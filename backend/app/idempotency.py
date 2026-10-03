"""Idempotency-Key helpers (spec 6.3).

These primitives run on a write-transaction connection supplied by the
caller, so the idempotency record commits atomically with the business write.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from typing import Any

from app.errors import AppError

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def require_idempotency_key(header_value: str | None) -> str:
    """Validate the Idempotency-Key header; raise AppError when invalid."""
    if header_value is None or not header_value.strip():
        raise AppError("IDEMPOTENCY_KEY_REQUIRED")
    key = header_value.strip()
    if not UUID_RE.match(key):
        raise AppError("IDEMPOTENCY_KEY_INVALID")
    # Normalise to lowercase canonical UUID form.
    return str(uuid.UUID(key)).lower()


def compute_fingerprint(method: str, path: str, body: Any) -> str:
    """SHA-256 over method + normalised path + canonical JSON body."""
    normalised_path = "/" + path.strip("/") if path.strip("/") else "/"
    if body is None:
        canonical = ""
    elif isinstance(body, str):
        canonical = body
    else:
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    material = f"{method.upper()}\n{normalised_path}\n{canonical}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def check_idempotent(
    conn: sqlite3.Connection, actor_id: str, key: str, fingerprint: str
) -> dict[str, Any]:
    """Return {is_replay, http_status, response_json} for actor/key."""
    row = conn.execute(
        "SELECT fingerprint, http_status, response_json FROM idempotency_records "
        "WHERE actor_id = ? AND key = ?",
        (actor_id, key),
    ).fetchone()
    if row is None:
        return {"is_replay": False, "http_status": None, "response_json": None}
    if row["fingerprint"] != fingerprint:
        raise AppError("IDEMPOTENCY_KEY_REUSED")
    return {
        "is_replay": True,
        "http_status": row["http_status"],
        "response_json": row["response_json"],
    }


def record_idempotent(
    conn: sqlite3.Connection,
    actor_id: str,
    key: str,
    fingerprint: str,
    http_status: int,
    response_json: str,
    created_at: int,
) -> None:
    """Persist a successful (2xx) idempotency record in the caller's transaction."""
    if not (200 <= int(http_status) < 300):
        return
    conn.execute(
        "INSERT OR IGNORE INTO idempotency_records "
        "(actor_id, key, fingerprint, http_status, response_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (actor_id, key, fingerprint, int(http_status), response_json, int(created_at)),
    )
