"""Task, requirement-state and completion services (spec 7 / 8.2-8.4).

All derived requirement states (spec 7.1), coordination_ready and
completion_eligible are computed here on the server; clients never submit
them. Candidate tool selection follows spec 8.3 exactly: at most 5 ids,
sorted by same-community, distance, created_at, id, restricted to in-range
(<= 2000 m from the task community centre) available tools not owned by the
task creator.
"""

from __future__ import annotations

import json
import math
import sqlite3
import uuid
from typing import Any

from app.auth import CurrentUser
from app.constants import ACTIVE_LOAN_STATUSES, PLACE_SOURCES
from app.db import epoch_to_iso, utc_now
from app.errors import AppError
from app.geo import haversine_m
from app.schemas_tasks import CreateTaskRequest

MATCH_RADIUS_M = 2000.0
CANDIDATE_LIMIT = 5

# Active loan status -> requirement state (spec 7.1).
_ACTIVE_STATE = {"pending": "pending", "accepted": "confirmed", "on_loan": "in_use"}

COORDINATION_STATES = frozenset({"self_supplied", "confirmed", "in_use", "fulfilled"})
COMPLETION_STATES = frozenset({"self_supplied", "in_use", "fulfilled"})

_TASK_COLUMNS = (
    "id, creator_id, community_id, template_id, title, place_name, "
    "place_latitude, place_longitude, place_source, place_source_id, status, "
    "outcome_note, bags_collected, volunteer_minutes, created_at, completed_at"
)


# --- Templates --------------------------------------------------------------


def template_payload(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Read the fixed templates and their requirements straight from the DB."""
    rows = conn.execute(
        "SELECT id, title, description FROM task_templates ORDER BY id"
    ).fetchall()
    payload: list[dict[str, Any]] = []
    for row in rows:
        req_rows = conn.execute(
            "SELECT category, quantity FROM template_requirements "
            "WHERE template_id = ? ORDER BY category",
            (row["id"],),
        ).fetchall()
        payload.append(
            {
                "id": row["id"],
                "title": row["title"],
                "description": row["description"],
                "requirements": [
                    {"category": r["category"], "quantity": r["quantity"]}
                    for r in req_rows
                ],
            }
        )
    return payload


# --- Reads ------------------------------------------------------------------


def get_task_row(conn: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    row = conn.execute(
        f"SELECT {_TASK_COLUMNS} FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()
    if row is None:
        raise AppError("NOT_FOUND")
    return row


def _requirement_state(
    conn: sqlite3.Connection,
    task: sqlite3.Row,
    requirement: sqlite3.Row,
    viewer_id: str,
) -> dict[str, Any]:
    """Authoritative derived state for one requirement (spec 7.1)."""
    loans = conn.execute(
        "SELECT l.id, l.status, l.handed_over_at, l.borrower_id, tl.owner_id "
        "FROM loans l JOIN tools tl ON tl.id = l.tool_id "
        "WHERE l.requirement_id = ? "
        "ORDER BY l.created_at DESC, l.id DESC",
        (requirement["id"],),
    ).fetchall()

    active = [l for l in loans if l["status"] in ACTIVE_LOAN_STATUSES]
    state: str
    active_loan_id: str | None = None
    candidate_tool_ids: list[str] = []

    if active:
        # One active loan per requirement is guaranteed by the partial unique
        # index; take the most recent one defensively.
        loan = active[0]
        state = _ACTIVE_STATE[loan["status"]]
        entitled = viewer_id in (
            task["creator_id"],
            loan["borrower_id"],
            loan["owner_id"],
        )
        active_loan_id = loan["id"] if entitled else None
    else:
        used = [
            l
            for l in loans
            if l["status"] == "returned" and l["handed_over_at"] is not None
        ]
        if used:
            state = "fulfilled"
        elif requirement["self_supplied"]:
            state = "self_supplied"
        else:
            candidate_tool_ids = _candidate_tools(conn, task, requirement)
            state = "match_available" if candidate_tool_ids else "missing"

    return {
        "id": requirement["id"],
        "category": requirement["category"],
        "quantity": requirement["quantity"],
        "self_supplied": bool(requirement["self_supplied"]),
        "state": state,
        "active_loan_id": active_loan_id,
        "candidate_tool_ids": candidate_tool_ids,
    }


def _candidate_tools(
    conn: sqlite3.Connection, task: sqlite3.Row, requirement: sqlite3.Row
) -> list[str]:
    """Spec 8.3 candidate list: in-range, available, not owned by the creator."""
    task_community = conn.execute(
        "SELECT latitude, longitude FROM communities WHERE id = ?",
        (task["community_id"],),
    ).fetchone()
    if task_community is None:  # pragma: no cover - FK guarantees existence
        return []

    rows = conn.execute(
        "SELECT t.id, t.created_at, t.community_id, c.latitude, c.longitude "
        "FROM tools t JOIN communities c ON c.id = t.community_id "
        "WHERE t.category = ? AND t.is_archived = 0 AND t.owner_id != ? "
        "AND NOT EXISTS ("
        "  SELECT 1 FROM loans l"
        "  WHERE l.tool_id = t.id AND l.status IN (?, ?, ?)"
        ")",
        (
            requirement["category"],
            task["creator_id"],
            *ACTIVE_LOAN_STATUSES,
        ),
    ).fetchall()

    scored: list[tuple[int, float, int, str]] = []
    for row in rows:
        same_community = row["community_id"] == task["community_id"]
        if same_community:
            distance = 0.0
        else:
            distance = haversine_m(
                task_community["latitude"],
                task_community["longitude"],
                row["latitude"],
                row["longitude"],
            )
            if distance > MATCH_RADIUS_M:
                continue
        scored.append(
            (0 if same_community else 1, distance, row["created_at"], row["id"])
        )
    scored.sort()
    return [item[3] for item in scored[:CANDIDATE_LIMIT]]


def build_task_data(
    conn: sqlite3.Connection, task: sqlite3.Row, viewer_id: str
) -> dict[str, Any]:
    """Full TaskResponse payload (spec 8.3) as seen by `viewer_id`."""
    creator = conn.execute(
        "SELECT display_name FROM users WHERE id = ?", (task["creator_id"],)
    ).fetchone()
    req_rows = conn.execute(
        "SELECT id, category, quantity, self_supplied FROM task_requirements "
        "WHERE task_id = ? ORDER BY category, id",
        (task["id"],),
    ).fetchall()
    requirements = [
        _requirement_state(conn, task, row, viewer_id) for row in req_rows
    ]

    if requirements:
        coordination_ready = all(
            r["state"] in COORDINATION_STATES for r in requirements
        )
        completion_eligible = all(
            r["state"] in COMPLETION_STATES for r in requirements
        )
    else:  # pragma: no cover - templates always ship >=1 requirement
        coordination_ready = False
        completion_eligible = False

    outcome = None
    if task["status"] == "completed":
        outcome = {
            "note": task["outcome_note"] or "",
            "bags_collected": task["bags_collected"],
            "volunteer_minutes": task["volunteer_minutes"],
            "verification": "self_reported",
        }

    return {
        "id": task["id"],
        "title": task["title"],
        "creator": {
            "id": task["creator_id"],
            "display_name": creator["display_name"] if creator else "",
        },
        "community_id": task["community_id"],
        "template_id": task["template_id"],
        "place": {
            "name": task["place_name"],
            "latitude": task["place_latitude"],
            "longitude": task["place_longitude"],
            "source": task["place_source"],
            "source_id": task["place_source_id"],
        },
        "status": task["status"],
        "requirements": requirements,
        "coordination_ready": coordination_ready,
        "completion_eligible": completion_eligible,
        "outcome": outcome,
        "created_at": epoch_to_iso(task["created_at"]) or "",
        "completed_at": epoch_to_iso(task["completed_at"]),
    }


def build_task_summary(
    conn: sqlite3.Connection, task: sqlite3.Row, viewer_id: str
) -> dict[str, Any]:
    """Public list row: no requirements / loan details (spec 8.2)."""
    full = build_task_data(conn, task, viewer_id)
    return {
        key: full[key]
        for key in (
            "id",
            "title",
            "creator",
            "community_id",
            "template_id",
            "place",
            "status",
            "coordination_ready",
            "completion_eligible",
            "outcome",
            "created_at",
            "completed_at",
        )
    }


def list_tasks(
    conn: sqlite3.Connection,
    user: CurrentUser,
    scope: str,
    community_id: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], int]:
    if scope == "mine":
        where, params = "creator_id = ?", [user.id]
    elif scope == "community":
        if not community_id:
            raise AppError(
                "VALIDATION_ERROR",
                "community_id is required when scope=community.",
                details={"field": "community_id"},
            )
        exists = conn.execute(
            "SELECT 1 FROM communities WHERE id = ?", (community_id,)
        ).fetchone()
        if exists is None:
            raise AppError("NOT_FOUND")
        where, params = "community_id = ?", [community_id]
    else:  # pragma: no cover - FastAPI Literal rejects other values
        raise AppError("VALIDATION_ERROR", details={"field": "scope"})

    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM tasks WHERE {where}", params
    ).fetchone()["c"]
    rows = conn.execute(
        f"SELECT {_TASK_COLUMNS} FROM tasks WHERE {where} "
        "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    items = [build_task_summary(conn, row, user.id) for row in rows]
    return items, total


# --- Place validation (spec 8.4) -------------------------------------------


def _finite(value: float) -> bool:
    return math.isfinite(value)


def _walk_for_feature(node: Any, wanted: str) -> dict[str, Any] | None:
    """Find a greenspace feature with id == wanted anywhere in a cached payload."""
    if isinstance(node, dict):
        if _feature_matches(node, wanted):
            feature = _extract_feature(node, wanted)
            if feature is not None:
                return feature
        for value in node.values():
            found = _walk_for_feature(value, wanted)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _walk_for_feature(value, wanted)
            if found is not None:
                return found
    return None


def _feature_matches(node: dict[str, Any], wanted: str) -> bool:
    wanted_norm = str(wanted).strip().lower()
    wanted_tail = wanted_norm.split("/")[-1]
    for key in ("id", "source_id", "osm_id", "place_id", "osm_type"):
        if key not in node:
            continue
        value = node[key]
        if value is None:
            continue
        text = str(value).strip().lower()
        if text == wanted_norm:
            return True
        if text == wanted_tail and wanted_tail.isdigit():
            return True
    tags = node.get("tags")
    if isinstance(tags, dict):
        for key in ("id", "source_id", "osm_id"):
            if str(tags.get(key, "")).strip().lower() == wanted_norm:
                return True
    return False


def _extract_feature(node: dict[str, Any], wanted: str) -> dict[str, Any] | None:
    name: str | None = None
    for source in (node, node.get("properties") or {}, node.get("tags") or {}):
        if isinstance(source, dict):
            for key in ("name", "display_name"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    name = value.strip()
                    break
        if name:
            break

    lat: Any = node.get("latitude", node.get("lat"))
    lon: Any = node.get("longitude", node.get("lon", node.get("lng")))

    geometry = node.get("geometry")
    if isinstance(geometry, dict):
        coords = geometry.get("coordinates")
        if isinstance(coords, dict):
            lat = lat if lat is not None else coords.get("lat")
            lon = lon if lon is not None else coords.get("lon", coords.get("lng"))
        elif isinstance(coords, (list, tuple)) and len(coords) >= 2:
            # GeoJSON is [longitude, latitude].
            lon = coords[0] if lon is None else lon
            lat = coords[1] if lat is None else lat

    try:
        latitude = float(lat)  # type: ignore[arg-type]
        longitude = float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not (_finite(latitude) and _finite(longitude)):
        return None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None
    if not name:
        name = f"OSM greenspace {wanted}"
    return {"name": name, "latitude": latitude, "longitude": longitude}


def _find_cached_greenspace(
    conn: sqlite3.Connection, community: sqlite3.Row, source_id: str
) -> dict[str, Any] | None:
    """Look the source_id up in the server-side greenspace cache for this
    community. Without a matching cached feature, osm places are rejected."""
    tokens = (community["id"], community["postcode"], community["outcode"])
    rows = conn.execute(
        "SELECT cache_key, payload_json FROM external_cache"
    ).fetchall()
    for row in rows:
        haystack = f"{row['cache_key'] or ''}\n{row['payload_json'] or ''}"
        if not any(token and token in haystack for token in tokens):
            continue
        try:
            payload = json.loads(row["payload_json"] or "null")
        except (TypeError, ValueError):
            continue
        feature = _walk_for_feature(payload, source_id)
        if feature is not None:
            return feature
    return None


def _resolve_place(
    conn: sqlite3.Connection, community: sqlite3.Row, place: Any
) -> tuple[str, float, float, str, str | None]:
    """Validate and normalise the meeting point. Returns
    (name, lat, lon, source, source_id)."""
    if place is None:
        # Default: the creator's community centre, marked as a fixture.
        return (
            "Community centre",
            community["latitude"],
            community["longitude"],
            "fixture",
            None,
        )

    if not (_finite(place.latitude) and _finite(place.longitude)):
        bad_field = "place.latitude" if not _finite(place.latitude) else "place.longitude"
        raise AppError(
            "VALIDATION_ERROR",
            "Place coordinates must be finite numbers.",
            details={"field": bad_field},
        )
    if not (-90 <= place.latitude <= 90):
        raise AppError(
            "VALIDATION_ERROR",
            "Latitude must be between -90 and 90.",
            details={"field": "place.latitude"},
        )
    if not (-180 <= place.longitude <= 180):
        raise AppError(
            "VALIDATION_ERROR",
            "Longitude must be between -180 and 180.",
            details={"field": "place.longitude"},
        )
    if place.source not in PLACE_SOURCES:
        raise AppError(
            "VALIDATION_ERROR",
            "Unsupported place source.",
            details={"field": "place.source"},
        )

    name, latitude, longitude, source_id = (
        place.name,
        place.latitude,
        place.longitude,
        place.source_id,
    )

    if place.source == "osm":
        if not place.source_id:
            raise AppError(
                "VALIDATION_ERROR",
                "source_id is required when place.source is 'osm'.",
                details={"field": "place.source_id"},
            )
        feature = _find_cached_greenspace(conn, community, place.source_id)
        if feature is None:
            raise AppError(
                "VALIDATION_ERROR",
                "No cached greenspace matches this source_id for the community.",
                details={"field": "place.source_id"},
            )
        name = feature["name"]
        latitude = feature["latitude"]
        longitude = feature["longitude"]
    elif place.source_id is not None:
        raise AppError(
            "VALIDATION_ERROR",
            "source_id is only valid when place.source is 'osm'.",
            details={"field": "place.source_id"},
        )

    distance = haversine_m(
        community["latitude"], community["longitude"], latitude, longitude
    )
    if distance > MATCH_RADIUS_M:
        raise AppError(
            "OUT_OF_RANGE",
            "The place is farther than 2000 m from the community centre.",
            details={"field": "place", "distance_m": round(distance)},
        )
    return name, latitude, longitude, place.source, source_id


# --- Writes (all run inside the caller's write transaction) -----------------


def create_task(
    conn: sqlite3.Connection, user: CurrentUser, body: CreateTaskRequest
) -> dict[str, Any]:
    template = conn.execute(
        "SELECT id, title FROM task_templates WHERE id = ?", (body.template_id,)
    ).fetchone()
    if template is None:
        raise AppError(
            "VALIDATION_ERROR",
            "Unknown task template.",
            details={"field": "template_id"},
        )
    template_reqs = conn.execute(
        "SELECT category, quantity FROM template_requirements "
        "WHERE template_id = ? ORDER BY category",
        (template["id"],),
    ).fetchall()
    if not template_reqs:
        raise AppError(
            "VALIDATION_ERROR",
            "Task template has no requirements.",
            details={"field": "template_id"},
        )

    community = conn.execute(
        "SELECT id, postcode, outcode, latitude, longitude FROM communities "
        "WHERE id = ?",
        (user.community_id,),
    ).fetchone()
    if community is None:  # pragma: no cover - FK guarantees existence
        raise AppError("NOT_FOUND")

    name, latitude, longitude, source, source_id = _resolve_place(
        conn, community, body.place
    )

    task_id = str(uuid.uuid4())
    now = utc_now()
    title = body.title if body.title else template["title"]
    conn.execute(
        "INSERT INTO tasks (id, creator_id, community_id, template_id, title, "
        "place_name, place_latitude, place_longitude, place_source, "
        "place_source_id, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
        (
            task_id,
            user.id,
            user.community_id,
            template["id"],
            title,
            name,
            latitude,
            longitude,
            source,
            source_id,
            now,
        ),
    )
    for req in template_reqs:
        conn.execute(
            "INSERT INTO task_requirements (id, task_id, category, quantity, "
            "self_supplied, created_at) VALUES (?, ?, ?, ?, 0, ?)",
            (str(uuid.uuid4()), task_id, req["category"], req["quantity"], now),
        )

    task = get_task_row(conn, task_id)
    return build_task_data(conn, task, user.id)


def set_self_supply(
    conn: sqlite3.Connection,
    user: CurrentUser,
    task_id: str,
    requirement_id: str,
    value: bool,
) -> dict[str, Any]:
    task = get_task_row(conn, task_id)
    if task["creator_id"] != user.id:
        raise AppError("FORBIDDEN")

    requirement = conn.execute(
        "SELECT id, task_id, self_supplied FROM task_requirements WHERE id = ?",
        (requirement_id,),
    ).fetchone()
    if requirement is None or requirement["task_id"] != task_id:
        raise AppError("NOT_FOUND")

    if task["status"] == "completed":
        raise AppError("TASK_ALREADY_COMPLETED")
    if task["status"] != "open":  # pragma: no cover - CHECK keeps open/completed
        raise AppError("INVALID_TRANSITION")

    # Locked while an active request exists, or after a real hand-over in the
    # past (spec 7.2). Checked on this connection inside the write transaction.
    active = conn.execute(
        "SELECT 1 FROM loans WHERE requirement_id = ? "
        "AND status IN (?, ?, ?) LIMIT 1",
        (requirement_id, *ACTIVE_LOAN_STATUSES),
    ).fetchone()
    used = conn.execute(
        "SELECT 1 FROM loans WHERE requirement_id = ? "
        "AND handed_over_at IS NOT NULL LIMIT 1",
        (requirement_id,),
    ).fetchone()
    if active is not None or used is not None:
        raise AppError("REQUIREMENT_LOCKED")

    conn.execute(
        "UPDATE task_requirements SET self_supplied = ? WHERE id = ?",
        (1 if value else 0, requirement_id),
    )
    task = get_task_row(conn, task_id)
    return build_task_data(conn, task, user.id)


def complete_task(
    conn: sqlite3.Connection, user: CurrentUser, task_id: str, body: Any
) -> dict[str, Any]:
    task = get_task_row(conn, task_id)
    if task["creator_id"] != user.id:
        raise AppError("FORBIDDEN")

    if task["status"] == "completed":
        same_body = (
            task["outcome_note"] == body.outcome_note
            and task["bags_collected"] == body.bags_collected
            and task["volunteer_minutes"] == body.volunteer_minutes
        )
        if same_body:
            # Same intent, new key: harmless no-op (spec 6.3 / 7.2).
            return build_task_data(conn, task, user.id)
        raise AppError("TASK_ALREADY_COMPLETED")

    # Getting the tools together is optional and never gates the report: the
    # organiser may record the outcome of their own open action even when
    # requirements are still missing, pending or unconfirmed. The derived
    # `coordination_ready` / `completion_eligible` flags stay as informative
    # progress figures only (spec 7.1 derivation, no longer a precondition).
    now = utc_now()
    cur = conn.execute(
        "UPDATE tasks SET status = 'completed', outcome_note = ?, "
        "bags_collected = ?, volunteer_minutes = ?, completed_at = ? "
        "WHERE id = ? AND status = 'open'",
        (
            body.outcome_note,
            body.bags_collected,
            body.volunteer_minutes,
            now,
            task_id,
        ),
    )
    if cur.rowcount != 1:  # pragma: no cover - concurrent completion
        raise AppError("INVALID_TRANSITION")
    task = get_task_row(conn, task_id)
    return build_task_data(conn, task, user.id)
