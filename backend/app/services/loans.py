"""Loan services: creation transaction, state machine, listing, events.

Spec anchors: 4.2 (roles), 4.3 (borrow range), 6.1 (transitions), 6.2
(transaction order), 6.3 (idempotency / no-op), 6.4 (concurrency).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from typing import Any

from app.auth import CurrentUser
from app.constants import ACTIVE_LOAN_STATUSES
from app.db import connection, epoch_to_iso, utc_now, write_transaction
from app.errors import AppError
from app.geo import haversine_m
from app.idempotency import check_idempotent, record_idempotent
from app.services.tools import require_active_user

# Spec 4.3: borrow range = same community, or centre-to-centre <= 2000 m.
MAX_BORROW_DISTANCE_M = 2000.0

_ACTIVE_PLACEHOLDERS = ",".join("?" for _ in ACTIVE_LOAN_STATUSES)

_LOAN_FROM = (
    " FROM loans l"
    " JOIN tools t ON t.id = l.tool_id"
    " LEFT JOIN task_requirements tr ON tr.id = l.requirement_id"
)

_LOAN_SELECT = (
    "SELECT l.id, l.tool_id, l.borrower_id, l.requirement_id, l.status, l.note,"
    " l.created_at, l.updated_at, l.accepted_at, l.handed_over_at, l.returned_at,"
    " l.rejected_at, l.cancelled_at,"
    " t.name AS tool_name, t.owner_id AS owner_id,"
    " tr.task_id AS task_id"
    + _LOAN_FROM
)

_EVENT_SELECT = (
    "SELECT id, loan_id, actor_id, action, from_status, to_status, created_at"
    " FROM loan_events"
)

# Spec 6.1 transition table. "roles" lists who may run the action; "from" the
# statuses it accepts; "ts" the timestamp column it stamps.
_ACTIONS: dict[str, dict[str, Any]] = {
    "accept": {
        "to": "accepted",
        "from": frozenset({"pending"}),
        "owner_only": True,
        "ts": "accepted_at",
        "event": "accepted",
    },
    "reject": {
        "to": "rejected",
        "from": frozenset({"pending"}),
        "owner_only": True,
        "ts": "rejected_at",
        "event": "rejected",
    },
    "cancel": {
        "to": "cancelled",
        "from": frozenset({"pending", "accepted"}),
        "owner_only": False,  # borrower or owner (spec 4.2)
        "ts": "cancelled_at",
        "event": "cancelled",
    },
    "hand-over": {
        "to": "on_loan",
        "from": frozenset({"accepted"}),
        "owner_only": True,
        "ts": "handed_over_at",
        "event": "handed_over",
    },
    "return": {
        "to": "returned",
        "from": frozenset({"on_loan"}),
        "owner_only": True,
        "ts": "returned_at",
        "event": "returned",
    },
}


_EVENT_SEQ_LOCK = threading.Lock()
_EVENT_SEQ = int.from_bytes(os.urandom(2), "big")


def new_event_id() -> str:
    """UUIDv7-shaped id: 48-bit millisecond timestamp + a monotonic 14-bit
    sequence, then random node bits.

    Events of one loan are ordered by (created_at, id) per spec 8.2, and
    created_at only has second resolution — so the id itself must sort
    chronologically or same-second events would appear shuffled.
    """
    global _EVENT_SEQ
    milliseconds = int(time.time() * 1000)
    with _EVENT_SEQ_LOCK:
        _EVENT_SEQ = (_EVENT_SEQ + 1) % 0x4000
        seq = _EVENT_SEQ
    raw = (
        milliseconds.to_bytes(6, "big")
        + b"\x70\x00"  # version 7, fixed filler (keeps seq dominant)
        + bytes((0x80 | ((seq >> 8) & 0x3F), seq & 0xFF))
        + os.urandom(6)
    )
    return str(uuid.UUID(bytes=raw))


def loan_payload(row: sqlite3.Row) -> dict[str, Any]:
    """LoanResponse dict (spec 8.3): every timestamp ISO 8601 or null."""
    return {
        "id": row["id"],
        "tool_id": row["tool_id"],
        "tool_name": row["tool_name"],
        "owner_id": row["owner_id"],
        "borrower_id": row["borrower_id"],
        "requirement_id": row["requirement_id"],
        "task_id": row["task_id"],
        "status": row["status"],
        "note": row["note"],
        "created_at": epoch_to_iso(row["created_at"]),
        "updated_at": epoch_to_iso(row["updated_at"]),
        "accepted_at": epoch_to_iso(row["accepted_at"]),
        "handed_over_at": epoch_to_iso(row["handed_over_at"]),
        "returned_at": epoch_to_iso(row["returned_at"]),
        "rejected_at": epoch_to_iso(row["rejected_at"]),
        "cancelled_at": epoch_to_iso(row["cancelled_at"]),
    }


def event_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "loan_id": row["loan_id"],
        "actor_id": row["actor_id"],
        "action": row["action"],
        "from_status": row["from_status"],
        "to_status": row["to_status"],
        "created_at": epoch_to_iso(row["created_at"]),
    }


def _fetch_loan(conn: sqlite3.Connection, loan_id: str) -> sqlite3.Row | None:
    return conn.execute(
        f"{_LOAN_SELECT} WHERE l.id = ?", (loan_id,)
    ).fetchone()


def _require_visible(row: sqlite3.Row | None, user: CurrentUser) -> sqlite3.Row:
    """Loan details/events are readable by the two parties only; everyone
    else gets 404, not 403 (spec 4.2)."""
    if row is None:
        raise AppError("NOT_FOUND")
    if row["borrower_id"] != user.id and row["owner_id"] != user.id:
        raise AppError("NOT_FOUND")
    return row


# --- Reads -----------------------------------------------------------------


def list_loans(
    *,
    user: CurrentUser,
    role: str,
    status: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], int]:
    """GET /api/v1/loans: only loans the user borrows (role=borrower, default)
    or lends (role=owner)."""
    predicate = "l.borrower_id = ?" if role == "borrower" else "t.owner_id = ?"
    where = f" WHERE {predicate}"
    params: list[Any] = [user.id]
    if status:
        where += " AND l.status = ?"
        params.append(status)

    with connection() as conn:
        total = conn.execute(
            "SELECT COUNT(*) AS n" + _LOAN_FROM + where, params
        ).fetchone()["n"]
        rows = conn.execute(
            _LOAN_SELECT + where + " ORDER BY l.created_at ASC, l.id ASC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    return [loan_payload(row) for row in rows], int(total)


def get_loan(*, user: CurrentUser, loan_id: str) -> dict[str, Any]:
    with connection() as conn:
        row = _require_visible(_fetch_loan(conn, loan_id), user)
    return loan_payload(row)


def list_loan_events(
    *, user: CurrentUser, loan_id: str, limit: int, offset: int
) -> tuple[list[dict[str, Any]], int]:
    with connection() as conn:
        _require_visible(_fetch_loan(conn, loan_id), user)
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM loan_events WHERE loan_id = ?", (loan_id,)
        ).fetchone()["n"]
        rows = conn.execute(
            _EVENT_SELECT
            + " WHERE loan_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
            (loan_id, limit, offset),
        ).fetchall()
    return [event_payload(row) for row in rows], int(total)


# --- Create (spec 6.2 transaction order) ------------------------------------


def create_loan(
    *,
    user: CurrentUser,
    body: dict[str, Any],
    key: str,
    fingerprint: str,
) -> tuple[dict[str, Any], int, bool]:
    """POST /api/v1/loans: independent connection -> BEGIN IMMEDIATE ->
    re-confirm user -> idempotency -> tool/requirement checks -> insert
    pending loan -> created event -> touch tool.updated_at -> record key ->
    COMMIT. Any exception rolls back and maps to a spec error."""
    tool_id: str = body["tool_id"]
    requirement_id: str | None = body.get("requirement_id")
    note: str = body.get("note") or ""

    with connection() as conn:
        with write_transaction(conn):
            require_active_user(conn, user.id)

            replay = check_idempotent(conn, user.id, key, fingerprint)
            if replay["is_replay"]:
                return (
                    json.loads(replay["response_json"]),
                    int(replay["http_status"]),
                    True,
                )

            tool = conn.execute(
                "SELECT t.id, t.owner_id, t.community_id, t.category, t.is_archived,"
                " c.latitude, c.longitude"
                " FROM tools t JOIN communities c ON c.id = t.community_id"
                " WHERE t.id = ?",
                (tool_id,),
            ).fetchone()
            if tool is None:
                raise AppError("NOT_FOUND")
            if tool["is_archived"]:
                raise AppError("TOOL_ARCHIVED")
            if tool["owner_id"] == user.id:
                raise AppError("SELF_BORROW_FORBIDDEN")

            # Spec 4.3: server-computed distance from the borrower's own home
            # community centre; the client cannot widen the range.
            if tool["community_id"] != user.community_id:
                home = conn.execute(
                    "SELECT latitude, longitude FROM communities WHERE id = ?",
                    (user.community_id,),
                ).fetchone()
                if home is None:
                    raise AppError("UNAUTHENTICATED")
                distance = haversine_m(
                    home["latitude"], home["longitude"],
                    tool["latitude"], tool["longitude"],
                )
                if distance > MAX_BORROW_DISTANCE_M:
                    raise AppError(
                        "OUT_OF_RANGE",
                        details={
                            "distance_m": round(distance, 1),
                            "max_distance_m": int(MAX_BORROW_DISTANCE_M),
                        },
                    )

            if requirement_id:
                req = conn.execute(
                    "SELECT tr.id, tr.category, tr.self_supplied, tr.task_id,"
                    " tk.creator_id, tk.status AS task_status"
                    " FROM task_requirements tr JOIN tasks tk ON tk.id = tr.task_id"
                    " WHERE tr.id = ?",
                    (requirement_id,),
                ).fetchone()
                if req is None:
                    raise AppError("NOT_FOUND")
                if req["creator_id"] != user.id:
                    raise AppError("NOT_FOUND")
                if req["task_status"] != "open":
                    raise AppError("TASK_ALREADY_COMPLETED")
                if req["category"] != tool["category"]:
                    raise AppError("CATEGORY_MISMATCH")
                if req["self_supplied"]:
                    raise AppError("REQUIREMENT_LOCKED")
                used = conn.execute(
                    "SELECT 1 FROM loans WHERE requirement_id = ?"
                    " AND handed_over_at IS NOT NULL LIMIT 1",
                    (requirement_id,),
                ).fetchone()
                if used is not None:
                    raise AppError("REQUIREMENT_ALREADY_FULFILLED")
                occupied = conn.execute(
                    "SELECT 1 FROM loans WHERE requirement_id = ?"
                    f" AND status IN ({_ACTIVE_PLACEHOLDERS}) LIMIT 1",
                    (requirement_id, *ACTIVE_LOAN_STATUSES),
                ).fetchone()
                if occupied is not None:
                    raise AppError("REQUIREMENT_OCCUPIED")

            # Partial unique index uq_loans_one_active_tool is the real guard
            # (spec 5.2/6.4); this in-transaction check just names the error
            # and the index catches anything that slips past it.
            busy = conn.execute(
                "SELECT 1 FROM loans WHERE tool_id = ?"
                f" AND status IN ({_ACTIVE_PLACEHOLDERS}) LIMIT 1",
                (tool_id, *ACTIVE_LOAN_STATUSES),
            ).fetchone()
            if busy is not None:
                raise AppError("TOOL_UNAVAILABLE")

            now = utc_now()
            loan_id = str(uuid.uuid4())
            try:
                conn.execute(
                    "INSERT INTO loans (id, tool_id, borrower_id, requirement_id,"
                    " status, note, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
                    (loan_id, tool_id, user.id, requirement_id, note, now, now),
                )
            except sqlite3.IntegrityError as exc:
                raise _map_active_conflict(conn, tool_id, requirement_id) from exc

            conn.execute(
                "INSERT INTO loan_events (id, loan_id, actor_id, action,"
                " from_status, to_status, created_at)"
                " VALUES (?, ?, ?, 'created', NULL, 'pending', ?)",
                (new_event_id(), loan_id, user.id, now),
            )
            conn.execute(
                "UPDATE tools SET updated_at = ? WHERE id = ?", (now, tool_id)
            )

            row = _fetch_loan(conn, loan_id)
            if row is None:  # pragma: no cover - defensive
                raise AppError("INTERNAL_ERROR")
            data = loan_payload(row)
            record_idempotent(
                conn, user.id, key, fingerprint, 201,
                json.dumps(data, ensure_ascii=False), now,
            )
            return data, 201, False


def _map_active_conflict(
    conn: sqlite3.Connection, tool_id: str, requirement_id: str | None
) -> AppError:
    """Translate a unique/FK violation on insert into a business error
    without leaking SQL (spec 6.4)."""
    if conn.execute(
        "SELECT 1 FROM loans WHERE tool_id = ?"
        f" AND status IN ({_ACTIVE_PLACEHOLDERS}) LIMIT 1",
        (tool_id, *ACTIVE_LOAN_STATUSES),
    ).fetchone():
        return AppError("TOOL_UNAVAILABLE")
    if requirement_id and conn.execute(
        "SELECT 1 FROM loans WHERE requirement_id = ?"
        f" AND status IN ({_ACTIVE_PLACEHOLDERS}) LIMIT 1",
        (requirement_id, *ACTIVE_LOAN_STATUSES),
    ).fetchone():
        return AppError("REQUIREMENT_OCCUPIED")
    if conn.execute("SELECT 1 FROM tools WHERE id = ?", (tool_id,)).fetchone() is None:
        return AppError("NOT_FOUND")
    return AppError("TOOL_UNAVAILABLE")


# --- State machine (spec 6.1 / 6.3) ----------------------------------------


def transition_loan(
    *,
    user: CurrentUser,
    loan_id: str,
    action: str,
    key: str,
    fingerprint: str,
) -> tuple[dict[str, Any], int, bool]:
    """accept / reject / cancel / hand-over / return.

    Order: re-confirm user -> idempotency replay -> visibility (404 for
    strangers) -> permission (403 for the wrong party) -> already-in-target-
    state no-op (200, no event, no timestamp rewrite) -> transition or 409.
    """
    spec = _ACTIONS[action]

    with connection() as conn:
        with write_transaction(conn):
            require_active_user(conn, user.id)

            replay = check_idempotent(conn, user.id, key, fingerprint)
            if replay["is_replay"]:
                return (
                    json.loads(replay["response_json"]),
                    int(replay["http_status"]),
                    True,
                )

            row = _require_visible(_fetch_loan(conn, loan_id), user)

            is_owner = row["owner_id"] == user.id
            is_borrower = row["borrower_id"] == user.id
            if spec["owner_only"] and not is_owner:
                # Visible to the caller (borrower) but reserved to the owner.
                raise AppError("FORBIDDEN")
            if not spec["owner_only"] and not (is_owner or is_borrower):  # pragma: no cover
                raise AppError("FORBIDDEN")

            if row["status"] == spec["to"]:
                # Permission was enforced above; nothing changes (spec 6.3).
                data = loan_payload(row)
                record_idempotent(
                    conn, user.id, key, fingerprint, 200,
                    json.dumps(data, ensure_ascii=False), utc_now(),
                )
                return data, 200, False

            if row["status"] not in spec["from"]:
                raise AppError("INVALID_TRANSITION")

            now = utc_now()
            cur = conn.execute(
                f"UPDATE loans SET status = ?, updated_at = ?, {spec['ts']} = ?"
                " WHERE id = ? AND status = ?",
                (spec["to"], now, now, loan_id, row["status"]),
            )
            if cur.rowcount != 1:  # pragma: no cover - serialised by BEGIN IMMEDIATE
                raise AppError("INVALID_TRANSITION")

            conn.execute(
                "INSERT INTO loan_events (id, loan_id, actor_id, action,"
                " from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    new_event_id(),
                    loan_id,
                    user.id,
                    spec["event"],
                    row["status"],
                    spec["to"],
                    now,
                ),
            )

            row = _fetch_loan(conn, loan_id)
            if row is None:  # pragma: no cover - defensive
                raise AppError("INTERNAL_ERROR")
            data = loan_payload(row)
            record_idempotent(
                conn, user.id, key, fingerprint, 200,
                json.dumps(data, ensure_ascii=False), now,
            )
            return data, 200, False
