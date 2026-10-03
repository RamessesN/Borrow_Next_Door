"""Database migrations (spec 5). Each version runs exactly once."""

from __future__ import annotations

import sqlite3

from app.db import connect, ensure_wal, utc_now

MIGRATION_VERSION = "0001_initial"

# Schema DDL for version 0001. All IDs are UUID text; timestamps are epoch
# seconds (INTEGER); foreign keys use ON DELETE RESTRICT.
_DDL = """
CREATE TABLE communities (
    id           TEXT PRIMARY KEY,
    postcode     TEXT NOT NULL UNIQUE,
    outcode      TEXT NOT NULL,
    latitude     REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
    longitude    REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
    country      TEXT NOT NULL,
    source       TEXT NOT NULL,
    source_kind  TEXT NOT NULL CHECK (source_kind IN ('live','cached','fixture')),
    fetched_at   INTEGER,
    created_at   INTEGER NOT NULL
);

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    alias         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER
);

CREATE TABLE tools (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
    name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    category      TEXT NOT NULL CHECK (category IN
                    ('litter_picker','reusable_gloves','watering_can','hand_trowel')),
    description   TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    is_archived   INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE task_templates (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL
);

CREATE TABLE template_requirements (
    template_id  TEXT NOT NULL REFERENCES task_templates(id) ON DELETE RESTRICT,
    category     TEXT NOT NULL CHECK (category IN
                   ('litter_picker','reusable_gloves','watering_can','hand_trowel')),
    quantity     INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
    PRIMARY KEY (template_id, category)
);

CREATE TABLE tasks (
    id                TEXT PRIMARY KEY,
    creator_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    community_id      TEXT NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
    template_id       TEXT NOT NULL REFERENCES task_templates(id) ON DELETE RESTRICT,
    title             TEXT NOT NULL,
    place_name        TEXT NOT NULL,
    place_latitude    REAL NOT NULL CHECK (place_latitude >= -90 AND place_latitude <= 90),
    place_longitude   REAL NOT NULL CHECK (place_longitude >= -180 AND place_longitude <= 180),
    place_source      TEXT NOT NULL CHECK (place_source IN ('osm','manual','fixture')),
    place_source_id   TEXT,
    status            TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','completed')),
    outcome_note      TEXT,
    bags_collected    INTEGER,
    volunteer_minutes INTEGER,
    created_at        INTEGER NOT NULL,
    completed_at      INTEGER,
    CHECK (bags_collected IS NULL OR (bags_collected >= 0 AND bags_collected <= 1000)),
    CHECK (volunteer_minutes IS NULL OR
             (volunteer_minutes >= 0 AND volunteer_minutes <= 10000))
);

CREATE TABLE task_requirements (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    category      TEXT NOT NULL CHECK (category IN
                    ('litter_picker','reusable_gloves','watering_can','hand_trowel')),
    quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
    self_supplied INTEGER NOT NULL DEFAULT 0 CHECK (self_supplied IN (0,1)),
    created_at    INTEGER NOT NULL,
    UNIQUE (task_id, category)
);

CREATE TABLE loans (
    id             TEXT PRIMARY KEY,
    tool_id        TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    borrower_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    requirement_id TEXT REFERENCES task_requirements(id) ON DELETE RESTRICT,
    status         TEXT NOT NULL CHECK (status IN
                     ('pending','accepted','on_loan','returned','rejected','cancelled')),
    note           TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    accepted_at    INTEGER,
    handed_over_at INTEGER,
    returned_at    INTEGER,
    rejected_at    INTEGER,
    cancelled_at   INTEGER
);

CREATE TABLE loan_events (
    id          TEXT PRIMARY KEY,
    loan_id     TEXT NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
    actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action      TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE idempotency_records (
    actor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    key           TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    http_status   INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (actor_id, key)
);

CREATE TABLE external_cache (
    cache_key        TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    schema_version   TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    source_url       TEXT NOT NULL DEFAULT '',
    attribution      TEXT NOT NULL DEFAULT '',
    source_kind      TEXT NOT NULL CHECK (source_kind IN ('live','cached','fixture')),
    fetched_at       INTEGER NOT NULL,
    valid_time_from  INTEGER,
    valid_time_to    INTEGER,
    fresh_until      INTEGER,
    stale_until      INTEGER
);

-- Spec 5.2 indexes: exact SQL copied from the specification.
CREATE UNIQUE INDEX uq_loans_one_active_tool
ON loans(tool_id)
WHERE status IN ('pending', 'accepted', 'on_loan');

CREATE UNIQUE INDEX uq_loans_one_active_requirement
ON loans(requirement_id)
WHERE requirement_id IS NOT NULL
  AND status IN ('pending', 'accepted', 'on_loan');

CREATE INDEX ix_tools_community_category
ON tools(community_id, category, is_archived);

CREATE INDEX ix_loans_borrower_status ON loans(borrower_id, status);
CREATE INDEX ix_loans_tool_status ON loans(tool_id, status);
CREATE INDEX ix_tasks_community_status ON tasks(community_id, status);

CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_loan_events_loan ON loan_events(loan_id, created_at);
"""


def _ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version TEXT PRIMARY KEY,"
        " applied_at INTEGER NOT NULL"
        ")"
    )


def applied_versions(conn: sqlite3.Connection) -> list[str]:
    _ensure_migrations_table(conn)
    rows = conn.execute(
        "SELECT version FROM schema_migrations ORDER BY version"
    ).fetchall()
    return [r["version"] for r in rows]


def migrate(db_path: str | None = None) -> list[str]:
    """Apply pending migrations. Returns list of versions applied now."""
    ensure_wal(db_path)
    conn = connect(db_path)
    try:
        _ensure_migrations_table(conn)
        done = set(applied_versions(conn))
        applied: list[str] = []
        if MIGRATION_VERSION not in done:
            # executescript() would implicitly commit, so split the DDL into
            # individual statements and run them inside one explicit transaction.
            statements = [
                stmt.strip() for stmt in _DDL.split(";") if stmt.strip()
            ]
            conn.execute("BEGIN IMMEDIATE")
            try:
                for stmt in statements:
                    conn.execute(stmt)
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (MIGRATION_VERSION, utc_now()),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            applied.append(MIGRATION_VERSION)
        return applied
    finally:
        conn.close()


def is_ready(db_path: str | None = None) -> bool:
    """True when the DB is readable and every migration is applied."""
    try:
        conn = connect(db_path)
    except Exception:
        return False
    try:
        versions = applied_versions(conn)
        return MIGRATION_VERSION in versions
    except Exception:
        return False
    finally:
        conn.close()
