"""SQLite connection helpers: one short-lived connection per request."""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from app.config import get_settings


def connect(db_path: str | None = None) -> sqlite3.Connection:
    """Return a configured, independently owned connection."""
    path = db_path if db_path is not None else get_settings().database_path
    parent = Path(path).expanduser().resolve().parent
    parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@contextmanager
def connection(db_path: str | None = None) -> Iterator[sqlite3.Connection]:
    conn = connect(db_path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def write_transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """BEGIN IMMEDIATE -> COMMIT, ROLLBACK on any exception."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def utc_now() -> int:
    """Current UTC time as epoch seconds."""
    return int(time.time())


def epoch_to_iso(ts: int | None) -> str | None:
    """Convert epoch seconds to ISO 8601 UTC string with trailing Z."""
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_wal(db_path: str | None = None) -> None:
    """Enable WAL journal mode (called during migrations/initialisation)."""
    path = db_path if db_path is not None else get_settings().database_path
    conn = sqlite3.connect(path, isolation_level=None, timeout=5.0)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    finally:
        conn.close()
