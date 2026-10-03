#!/usr/bin/env python3
"""Delete and recreate the demo database: migrate + seed + summary.

Idempotent: safe to run repeatedly. Usage (from backend/):

    .venv/bin/python scripts/reset_db.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

# This CLI only rebuilds the database file. It never serves HTTP and never
# creates sessions, so it must NOT read or invent DEMO_ACCESS_CODE — the
# access code is runtime team config and must never live in source (spec 4.1).
# Access-code policy stays enforced in app.config.get_settings() for server
# startup; here we resolve the database path directly and pass it explicitly.

DEFAULT_DB_PATH = "./var/borrow-next-door.sqlite3"

from app.db import connection  # noqa: E402
from app.migrations import MIGRATION_VERSION, applied_versions, migrate  # noqa: E402
from app.seed import seed  # noqa: E402


def main() -> int:
    raw_path = os.environ.get("DATABASE_PATH", DEFAULT_DB_PATH).strip()
    if not raw_path:
        print("ERROR: DATABASE_PATH must not be empty.", file=sys.stderr)
        return 2
    db_path = Path(raw_path)
    if not db_path.is_absolute():
        db_path = BACKEND_DIR / db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Remove the database plus WAL/SHM sidecars for a clean rebuild.
    removed = []
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(db_path) + suffix)
        if p.exists():
            p.unlink()
            removed.append(p.name)

    applied = migrate(raw_path)
    stats = seed(raw_path)

    with connection(raw_path) as conn:
        versions = applied_versions(conn)
        users = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        communities = conn.execute(
            "SELECT COUNT(*) AS n FROM communities"
        ).fetchone()["n"]
        tools = conn.execute("SELECT COUNT(*) AS n FROM tools").fetchone()["n"]
        templates = conn.execute(
            "SELECT COUNT(*) AS n FROM task_templates"
        ).fetchone()["n"]
        indexes = [
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND name LIKE 'uq_%' OR name LIKE 'ix_%' ORDER BY name"
            ).fetchall()
        ]

    print("=== reset_db summary ===")
    print(f"database_path : {raw_path}")
    print(f"removed_files : {removed or 'none (fresh build)'}")
    print(f"migrations_run: {applied or 'none (already applied)'}")
    print(f"versions      : {versions}")
    print(f"seed_inserted : {stats}")
    print(f"counts        : communities={communities} users={users} "
          f"templates={templates} tools={tools}")
    print(f"indexes       : {indexes}")
    print(f"ready         : {MIGRATION_VERSION in versions}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
