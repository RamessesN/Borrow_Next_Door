"""Runtime settings read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

# Placeholder access codes that must never be used in a running server.
_PLACEHOLDER_CODES = {
    "",
    "change-me",
    "changeme",
    "placeholder",
    "secret",
    "access-code",
    "demo",
}

MIN_ACCESS_CODE_LENGTH = 16


class SettingsError(RuntimeError):
    """Raised when configuration is missing or unsafe. Prevents startup."""


@dataclass(frozen=True)
class Settings:
    app_mode: str
    demo_access_code: str
    database_path: str
    session_ttl_hours: int


def _read_access_code() -> str:
    code = os.environ.get("DEMO_ACCESS_CODE", "")
    stripped = code.strip()
    if not stripped:
        raise SettingsError(
            "DEMO_ACCESS_CODE is required and must not be empty. "
            "Set a runtime value of at least 16 characters (see .env.example)."
        )
    if stripped.lower() in _PLACEHOLDER_CODES:
        raise SettingsError(
            "DEMO_ACCESS_CODE is a placeholder value and must be changed "
            "before startup."
        )
    if len(stripped) < MIN_ACCESS_CODE_LENGTH:
        raise SettingsError(
            f"DEMO_ACCESS_CODE must be at least {MIN_ACCESS_CODE_LENGTH} "
            "characters long."
        )
    return stripped


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    app_mode = os.environ.get("APP_MODE", "demo").strip().lower()
    if app_mode not in ("demo", "production"):
        raise SettingsError(
            f"APP_MODE must be 'demo' or 'production', got {app_mode!r}."
        )
    # The access code is always validated: a production deploy must not fall
    # back to a demo secret even if demo routes are disabled.
    demo_access_code = _read_access_code()
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
        demo_access_code=demo_access_code,
        database_path=database_path,
        session_ttl_hours=session_ttl_hours,
    )


def reset_settings_cache() -> None:
    """Clear the cached settings (used by tests after env changes)."""
    get_settings.cache_clear()
