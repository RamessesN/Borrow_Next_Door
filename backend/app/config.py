"""Runtime settings read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

class SettingsError(RuntimeError):
    """Raised when configuration is missing or unsafe. Prevents startup."""


@dataclass(frozen=True)
class Settings:
    app_mode: str
    database_path: str
    session_ttl_hours: int


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    app_mode = os.environ.get("APP_MODE", "demo").strip().lower()
    if app_mode not in ("demo", "production"):
        raise SettingsError(
            f"APP_MODE must be 'demo' or 'production', got {app_mode!r}."
        )
    # No access code gate anymore (user override of spec 4.1): demo login is
    # open by design. Real authentication is still missing, so production mode
    # must not start.
    if app_mode == "production":
        raise SettingsError(
            "APP_MODE=production is not supported: real authentication is not "
            "implemented yet. Refusing to start with demo identities "
            "(spec 4.1)."
        )
    database_path = os.environ.get(
        "DATABASE_PATH", "./var/borrow-next-door.sqlite3"
    ).strip()
    if not database_path:
        raise SettingsError("DATABASE_PATH must not be empty.")
    ttl_raw = os.environ.get("SESSION_TTL_HOURS", "12").strip()
    try:
        session_ttl_hours = int(ttl_raw)
    except ValueError as exc:
        raise SettingsError("SESSION_TTL_HOURS must be an integer.") from exc
    if session_ttl_hours < 1:
        raise SettingsError("SESSION_TTL_HOURS must be >= 1.")
    return Settings(
        app_mode=app_mode,
        database_path=database_path,
        session_ttl_hours=session_ttl_hours,
    )


def reset_settings_cache() -> None:
    """Clear the cached settings (used by tests after env changes)."""
    get_settings.cache_clear()
