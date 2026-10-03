"""Demo-session authentication (spec 4.1).

Tokens are opaque secrets (>=32 random bytes); the server stores only the
SHA-256 hex digest plus expiry/revocation timestamps. Real authentication is
not implemented, so APP_MODE=production refuses to start (enforced in
app.config) and the demo routes are only registered in demo mode.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta
from typing import Deque

from fastapi import Request

from app.config import get_settings
from app.db import connection, utc_now, write_transaction
from app.errors import AppError


@dataclass(frozen=True)
class CurrentUser:
    id: str
    alias: str
    display_name: str
    community_id: str
    is_active: bool


def hash_token(token: str) -> str:
    """SHA-256 hex digest of the opaque bearer token."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_access_code(attempted: str) -> bool:
    """Constant-time comparison against the configured demo access code."""
    expected = get_settings().demo_access_code
    return hmac.compare_digest(
        attempted.encode("utf-8"), expected.encode("utf-8")
    )


# --- Login failure rate limiting (in-process, per IP) ---------------------

_LOCK = threading.Lock()
_FAILURE_WINDOW_SECONDS = 60
_FAILURE_THRESHOLD = 10
_failures: dict[str, Deque[float]] = defaultdict(deque)


def _register_failure(ip: str) -> int:
    now = time.monotonic()
    with _LOCK:
        q = _failures[ip]
        while q and now - q[0] > _FAILURE_WINDOW_SECONDS:
            q.popleft()
        q.append(now)
        return len(q)


def _failures_in_window(ip: str) -> int:
    now = time.monotonic()
    with _LOCK:
        q = _failures[ip]
        while q and now - q[0] > _FAILURE_WINDOW_SECONDS:
            q.popleft()
        return len(q)


def reset_rate_limits() -> None:
    """Clear counters (tests only)."""
    with _LOCK:
        _failures.clear()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# --- Session lifecycle -----------------------------------------------------


def create_demo_session(alias: str, access_code: str, ip: str) -> dict:
    """Validate credentials and create a session row.

    Returns a dict with access_token, token_type, expires_at, and user info.
    Raises AppError(UNAUTHENTICATED) on bad credentials, AppError(RATE_LIMITED)
    after repeated failures from one IP.
    """
    if _failures_in_window(ip) >= _FAILURE_THRESHOLD:
        raise AppError("RATE_LIMITED", http_status=429)

    if not verify_access_code(access_code):
        _register_failure(ip)
        raise AppError("UNAUTHENTICATED")

    with connection() as conn:
        row = conn.execute(
            "SELECT id, alias, display_name, community_id, is_active "
            "FROM users WHERE alias = ?",
            (alias.strip(),),
        ).fetchone()
        if row is None or not row["is_active"]:
            _register_failure(ip)
            raise AppError("UNAUTHENTICATED")

        token = secrets.token_urlsafe(32)
        token_digest = hash_token(token)
        created_at = utc_now()
        settings = get_settings()
        expires_at = created_at + settings.session_ttl_hours * 3600

        with write_transaction(conn):
            conn.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, revoked_at) "
                "VALUES (?, ?, ?, ?, NULL)",
                (token_digest, row["id"], created_at, expires_at),
            )

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_at": _iso(expires_at),
        "user": {
            "id": row["id"],
            "alias": row["alias"],
            "display_name": row["display_name"],
            "community_id": row["community_id"],
        },
    }


def _iso(ts: int | None) -> str | None:
    from app.db import epoch_to_iso

    return epoch_to_iso(ts)


def revoke_session(token: str) -> bool:
    """Revoke the session owning this token. Returns True if a live session
    was revoked."""
    digest = hash_token(token)
    with connection() as conn:
        with write_transaction(conn):
            cur = conn.execute(
                "UPDATE sessions SET revoked_at = ? "
                "WHERE token_hash = ? AND revoked_at IS NULL",
                (utc_now(), digest),
            )
        return cur.rowcount > 0


def _extract_token(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def get_current_user(request: Request) -> CurrentUser:
    """FastAPI dependency: validate Bearer token -> CurrentUser or 401."""
    token = _extract_token(request)
    if not token:
        raise AppError("UNAUTHENTICATED")
    digest = hash_token(token)
    now = utc_now()
    with connection() as conn:
        row = conn.execute(
            "SELECT s.expires_at, s.revoked_at, "
            "u.id, u.alias, u.display_name, u.community_id, u.is_active "
            "FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ?",
            (digest,),
        ).fetchone()
    if row is None:
        raise AppError("UNAUTHENTICATED")
    if row["revoked_at"] is not None:
        raise AppError("UNAUTHENTICATED")
    if row["expires_at"] is not None and row["expires_at"] < now:
        raise AppError("UNAUTHENTICATED")
    if not row["is_active"]:
        raise AppError("UNAUTHENTICATED")
    return CurrentUser(
        id=row["id"],
        alias=row["alias"],
        display_name=row["display_name"],
        community_id=row["community_id"],
        is_active=bool(row["is_active"]),
    )


def require_demo_mode() -> None:
    """Raise if the process is not in demo mode (defence in depth)."""
    if get_settings().app_mode != "demo":
        raise AppError("NOT_FOUND")


# Re-export for convenience in routers.
__all__ = [
    "CurrentUser",
    "create_demo_session",
    "revoke_session",
    "hash_token",
    "get_current_user",
    "require_demo_mode",
    "reset_rate_limits",
]
