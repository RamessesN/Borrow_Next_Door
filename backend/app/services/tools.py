"""Tool services: availability, nearby listing, creation, archiving.

Spec anchors: 4.2 (ownership), 4.3 (distance rule), 5.3 (availability is
computed, never stored), 6.2/6.3 (short write transactions + idempotency).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from app.auth import CurrentUser
from app.constants import ACTIVE_LOAN_STATUSES
from app.db import connection, epoch_to_iso, utc_now, write_transaction
from app.errors import AppError
from app.geo import haversine_m
from app.idempotency import check_idempotent, record_idempotent

# Spec 5.3: the single availability computation, evaluated in SQL so listing,
# detail, matching and statistics all reuse exactly one rule.
_AVAILABILITY_SQL = (
    "CASE"
    " WHEN t.is_archived = 1 THEN 'archived'"
    " WHEN EXISTS (SELECT 1 FROM loans al"
    "     WHERE al.tool_id = t.id AND al.status = 'on_loan') THEN 'on_loan'"
    " WHEN EXISTS (SELECT 1 FROM loans al"
    "     WHERE al.tool_id = t.id AND al.status IN ('pending','accepted'))"
    "     THEN 'reserved'"
    " ELSE 'available'"
    " END"
)

_TOOL_SELECT = (
    "SELECT t.id, t.owner_id, t.community_id, t.name, t.category, t.description,"
    " t.is_archived, t.created_at, t.updated_at,"
    " u.display_name AS owner_display_name,"
    " c.postcode, c.outcode, c.latitude, c.longitude, c.country, c.source,"
    " c.source_kind, c.fetched_at,"
    f" {_AVAILABILITY_SQL} AS availability"
    " FROM tools t"
    " JOIN users u ON u.id = t.owner_id"
    " JOIN communities c ON c.id = t.community_id"
)

_ACTIVE_PLACEHOLDERS = ",".join("?" for _ in ACTIVE_LOAN_STATUSES)


def require_active_user(conn: sqlite3.Connection, user_id: str) -> None:
    """Spec 6.2: re-confirm the session user is still valid inside the write
    transaction before touching any business state."""
    row = conn.execute(
        "SELECT is_active FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if row is None or not row["is_active"]:
        raise AppError("UNAUTHENTICATED")


def _fetch_row(conn: sqlite3.Connection, tool_id: str) -> sqlite3.Row | None:
    return conn.execute(
        f"{_TOOL_SELECT} WHERE t.id = ?", (tool_id,)
    ).fetchone()


def tool_payload(row: sqlite3.Row, distance_m: float | None) -> dict[str, Any]:
    """Build the ToolResponse dict (spec 8.3) from a _TOOL_SELECT row.

    ``distance_m`` is the Haversine estimate against the query reference
    community, or None when there is no reference community (spec 8.3 — never
    filled with 0 to fake a computation).
    """
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "description": row["description"],
        "owner": {"id": row["owner_id"], "display_name": row["owner_display_name"]},
        "community": {
            "id": row["community_id"],
            "postcode": row["postcode"],
            "outcode": row["outcode"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "country": row["country"],
            "source": row["source"],
            "source_kind": row["source_kind"],
            "fetched_at": epoch_to_iso(row["fetched_at"]),
        },
        "availability": row["availability"],
        "is_archived": bool(row["is_archived"]),
        "distance_m": None if distance_m is None else float(distance_m),
        "created_at": epoch_to_iso(row["created_at"]),
        "updated_at": epoch_to_iso(row["updated_at"]),
    }


def list_tools(
    *,
    community_id: str,
    radius_m: int,
    category: str | None,
    availability: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], int]:
    """GET /api/v1/tools (spec 8.2, 4.3).

    distance_m is measured from the *query* community centre; tools outside
    radius_m are dropped. Stable order: same community first, then distance,
    created_at, id.
    """
    with connection() as conn:
        ref = conn.execute(
            "SELECT id, latitude, longitude FROM communities WHERE id = ?",
            (community_id,),
        ).fetchone()
        if ref is None:
            raise AppError("NOT_FOUND")
        sql = _TOOL_SELECT
        params: list[Any] = []
        if category:
            sql += " WHERE t.category = ?"
            params.append(category)
        rows = conn.execute(sql, params).fetchall()

    matched: list[tuple[sqlite3.Row, float]] = []
    for row in rows:
        distance = haversine_m(
            ref["latitude"], ref["longitude"], row["latitude"], row["longitude"]
        )
        if distance > radius_m:
            continue
        if availability and row["availability"] != availability:
            continue
        matched.append((row, distance))

    matched.sort(
        key=lambda item: (
            0 if item[0]["community_id"] == ref["id"] else 1,
            item[1],
            item[0]["created_at"],
            item[0]["id"],
        )
    )
    total = len(matched)
    page = matched[offset : offset + limit]
    return [tool_payload(row, distance) for row, distance in page], total


def get_tool(tool_id: str) -> dict[str, Any]:
    """GET /api/v1/tools/{id}: readable even when archived (spec 8.2).

    The detail route carries no reference community, so distance_m is null.
    """
    with connection() as conn:
        row = _fetch_row(conn, tool_id)
    if row is None:
        raise AppError("NOT_FOUND")
    return tool_payload(row, None)


def create_tool(
    *,
    user: CurrentUser,
    body: dict[str, Any],
    key: str,
    fingerprint: str,
) -> tuple[dict[str, Any], int, bool]:
    """POST /api/v1/tools — 201 with owner and home community set server-side."""
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

            now = utc_now()
            tool_id = str(uuid.uuid4())
            try:
                conn.execute(
                    "INSERT INTO tools (id, owner_id, community_id, name, category,"
                    " description, is_archived, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
                    (
                        tool_id,
                        user.id,
                        user.community_id,
                        body["name"],
                        body["category"],
                        body.get("description") or "",
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                # Never leak SQL; a violated FK/CHECK here means the caller's
                # own identity no longer resolves.
                raise AppError("INTERNAL_ERROR") from exc

            row = _fetch_row(conn, tool_id)
            if row is None:  # pragma: no cover - defensive
                raise AppError("INTERNAL_ERROR")
            data = tool_payload(row, None)
            record_idempotent(
                conn, user.id, key, fingerprint, 201,
                json.dumps(data, ensure_ascii=False), now,
            )
            return data, 201, False


def archive_tool(
    *,
    user: CurrentUser,
    tool_id: str,
    key: str,
    fingerprint: str,
) -> tuple[dict[str, Any], int, bool]:
    """POST /api/v1/tools/{id}/archive (spec 4.2 / 8.2).

    Owner only; 409 ACTIVE_LOAN_EXISTS while any pending/accepted/on_loan
    loan exists; already-archived is a 200 no-op that touches nothing.
    """
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

            row = _fetch_row(conn, tool_id)
            if row is None:
                raise AppError("NOT_FOUND")
            if row["owner_id"] != user.id:
                raise AppError("FORBIDDEN")

            if row["is_archived"]:
                # Already in the target state: 200 no-op, no event, no
                # updated_at rewrite (spec 6.3).
                data = tool_payload(row, None)
                record_idempotent(
                    conn, user.id, key, fingerprint, 200,
                    json.dumps(data, ensure_ascii=False), utc_now(),
                )
                return data, 200, False

            active = conn.execute(
                "SELECT 1 FROM loans WHERE tool_id = ?"
                f" AND status IN ({_ACTIVE_PLACEHOLDERS})",
                (tool_id, *ACTIVE_LOAN_STATUSES),
            ).fetchone()
            if active is not None:
                raise AppError("ACTIVE_LOAN_EXISTS")

            now = utc_now()
            conn.execute(
                "UPDATE tools SET is_archived = 1, updated_at = ? WHERE id = ?",
                (now, tool_id),
            )
            row = _fetch_row(conn, tool_id)
            if row is None:  # pragma: no cover - defensive
                raise AppError("INTERNAL_ERROR")
            data = tool_payload(row, None)
            record_idempotent(
                conn, user.id, key, fingerprint, 200,
                json.dumps(data, ensure_ascii=False), now,
            )
            return data, 200, False
