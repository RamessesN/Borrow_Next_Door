"""Idempotent seed data: fixture communities, demo users, templates, tools.

Demo identities (alice / bob / carol) are演示账号, not real registrations.
No access code is stored here — the access code comes from runtime config.
"""

from __future__ import annotations

import sqlite3
import uuid

from app.constants import TASK_TEMPLATES
from app.db import connection, utc_now, write_transaction
from app.migrations import migrate

# Spec 2.1 verified snapshot: postcodes.io GET /postcodes/EH8%209AB (2026-10-03).
COMMUNITIES = [
    {
        "id": "c1111111-1111-4111-8111-111111111111",
        "postcode": "EH8 9AB",
        "outcode": "EH8",
        "latitude": 55.944703,
        "longitude": -3.187417,
        "country": "Scotland",
        "source": "fixture",
        "source_kind": "fixture",
        # ~2.5 km east of EH8 9AB, for distance-boundary tests (fixture).
    },
    {
        "id": "c2222222-2222-4222-8222-222222222222",
        "postcode": "EH16 5AA",
        "outcode": "EH16",
        "latitude": 55.925180,
        "longitude": -3.176690,
        "country": "Scotland",
        "source": "fixture",
        "source_kind": "fixture",
    },
]

USERS = [
    ("u1111111-1111-4111-8111-111111111111", "alice", "Alice"),
    ("u2222222-2222-4222-8222-222222222222", "bob", "Bob"),
    ("u3333333-3333-4333-8333-333333333333", "carol", "Carol"),
]

HOME_COMMUNITY_ID = COMMUNITIES[0]["id"]

DEMO_TOOLS = [
    {
        "id": "t1111111-1111-4111-8111-111111111111",
        "owner_alias": "alice",
        "name": "Galvanised watering can",
        "category": "watering_can",
        "description": "5 litre watering can, good for flowerbeds.",
    },
    {
        "id": "t2222222-2222-4222-8222-222222222222",
        "owner_alias": "alice",
        "name": "Hand trowel",
        "category": "hand_trowel",
        "description": "Sturdy hand trowel for weeding and planting.",
    },
    {
        "id": "t3333333-3333-4333-8333-333333333333",
        "owner_alias": "bob",
        "name": "Reusable gardening gloves",
        "category": "reusable_gloves",
        "description": "Pair of washable gloves, medium size.",
    },
]


def seed(db_path: str | None = None) -> dict:
    """Insert seed rows if missing. Safe to run repeatedly."""
    migrate(db_path)
    now = utc_now()
    stats = {"communities": 0, "users": 0, "templates": 0, "requirements": 0, "tools": 0}

    with connection(db_path) as conn:
        with write_transaction(conn):
            for c in COMMUNITIES:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO communities "
                    "(id, postcode, outcode, latitude, longitude, country, "
                    " source, source_kind, fetched_at, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        c["id"], c["postcode"], c["outcode"], c["latitude"],
                        c["longitude"], c["country"], c["source"],
                        c["source_kind"], now, now,
                    ),
                )
                stats["communities"] += cur.rowcount

            user_ids: dict[str, str] = {}
            for uid, alias, display_name in USERS:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO users "
                    "(id, alias, display_name, community_id, is_active, created_at) "
                    "VALUES (?, ?, ?, ?, 1, ?)",
                    (uid, alias, display_name, HOME_COMMUNITY_ID, now),
                )
                stats["users"] += cur.rowcount
                row = conn.execute(
                    "SELECT id FROM users WHERE alias = ?", (alias,)
                ).fetchone()
                user_ids[alias] = row["id"]

            for tpl_id, tpl in TASK_TEMPLATES.items():
                cur = conn.execute(
                    "INSERT OR IGNORE INTO task_templates (id, title, description) "
                    "VALUES (?, ?, ?)",
                    (tpl_id, tpl["title"], tpl["description"]),
                )
                stats["templates"] += cur.rowcount
                for category, quantity in tpl["requirements"]:
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO template_requirements "
                        "(template_id, category, quantity) VALUES (?, ?, ?)",
                        (tpl_id, category, quantity),
                    )
                    stats["requirements"] += cur.rowcount

            for tool in DEMO_TOOLS:
                owner_id = user_ids[tool["owner_alias"]]
                cur = conn.execute(
                    "INSERT OR IGNORE INTO tools "
                    "(id, owner_id, community_id, name, category, description, "
                    " is_archived, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
                    (
                        tool["id"], owner_id, HOME_COMMUNITY_ID, tool["name"],
                        tool["category"], tool["description"], now, now,
                    ),
                )
                stats["tools"] += cur.rowcount

    return stats


def fresh_uuid() -> str:
    return str(uuid.uuid4())


if __name__ == "__main__":  # pragma: no cover
    summary = seed()
    print("seed summary:", summary)
