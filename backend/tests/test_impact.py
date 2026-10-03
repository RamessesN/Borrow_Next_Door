"""Contract tests for GET /api/v1/communities/{id}/impact (spec 8.2).

All counters are verified against rows inserted directly with SQL: this
file never imports the tools / loans / tasks business modules (they are
owned by parallel tasks).
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from datetime import datetime, timezone

from app.db import utc_now

HOME_COMMUNITY_ID = "c1111111-1111-4111-8111-111111111111"
EMPTY_COMMUNITY_ID = "c2222222-2222-4222-8222-222222222222"
ALICE_ID = "u1111111-1111-4111-8111-111111111111"
BOB_ID = "u2222222-2222-4222-8222-222222222222"
SEEDED_TOOL_ID = "t1111111-1111-4111-8111-111111111111"
OTHER_SEEDED_TOOL_ID = "t3333333-3333-4333-8333-333333333333"

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _get_impact(client, token: str, community_id: str = HOME_COMMUNITY_ID):
    return client.get(f"/api/v1/communities/{community_id}/impact", headers=_auth(token))


def _insert_rows(db_path: str) -> None:
    """Minimal tools / loans / tasks rows for the counting rules."""
    now = utc_now()
    with sqlite3.connect(db_path) as conn:
        # One extra active tool (3 are already seeded -> 4 active) ...
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category, "
            "description, is_archived, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
            ("t4444444-4444-4444-8444-444444444444", ALICE_ID, HOME_COMMUNITY_ID,
             "Neighbourhood litter picker", "litter_picker", "", now, now),
        )
        # ... and one archived tool that must NOT be counted.
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category, "
            "description, is_archived, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
            ("t5555555-5555-4555-8555-555555555555", BOB_ID, HOME_COMMUNITY_ID,
             "Retired watering can", "watering_can", "", now, now),
        )
        # One returned loan (counted) on a seeded tool.
        conn.execute(
            "INSERT INTO loans (id, tool_id, borrower_id, requirement_id, status, "
            "note, created_at, updated_at, returned_at) "
            "VALUES (?, ?, ?, NULL, ?, '', ?, ?, ?)",
            ("l1111111-1111-4111-8111-111111111111", SEEDED_TOOL_ID, BOB_ID,
             "returned", now, now, now),
        )
        # One pending loan (not counted) on another seeded tool.
        conn.execute(
            "INSERT INTO loans (id, tool_id, borrower_id, requirement_id, status, "
            "note, created_at, updated_at) "
            "VALUES (?, ?, ?, NULL, ?, '', ?, ?)",
            ("l2222222-2222-4222-8222-222222222222", OTHER_SEEDED_TOOL_ID, ALICE_ID,
             "pending", now, now),
        )
        # One completed task (counted) and one open task (not counted).
        conn.execute(
            "INSERT INTO tasks (id, creator_id, community_id, template_id, title, "
            "place_name, place_latitude, place_longitude, place_source, "
            "place_source_id, status, created_at, completed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, 'completed', ?, ?)",
            ("k1111111-1111-4111-8111-111111111111", ALICE_ID, HOME_COMMUNITY_ID,
             "park_cleanup", "Saturday tidy-up", "Demo meeting point",
             55.944703, -3.187417, now, now),
        )
        conn.execute(
            "INSERT INTO tasks (id, creator_id, community_id, template_id, title, "
            "place_name, place_latitude, place_longitude, place_source, "
            "place_source_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, 'open', ?)",
            ("k2222222-2222-4222-8222-222222222222", ALICE_ID, HOME_COMMUNITY_ID,
             "flowerbed_care", "Flowerbed visit", "Demo meeting point",
             55.944703, -3.187417, now),
        )
        # A loan and a task belonging to the empty community must not leak
        # into the home community's numbers: put an archived tool there only.
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category, "
            "description, is_archived, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
            ("t6666666-6666-4666-8666-666666666666", ALICE_ID, EMPTY_COMMUNITY_ID,
             "Archived trowel", "hand_trowel", "", now, now),
        )


# --- counts -------------------------------------------------------------------


def test_impact_counts_from_application_rows(client, alice_token, db_path):
    _insert_rows(db_path)
    resp = _get_impact(client, alice_token)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    # 3 seeded + 1 added active tools; archived excluded.
    assert data["active_tools_count"] == 4
    # 1 returned loan counted; the pending one is not.
    assert data["returned_loans_count"] == 1
    # 1 completed task counted; the open one is not.
    # 1 fixture row + 2 seeded demo stories on EH8 9AB
    assert data["completed_tasks_count"] == 3


def test_impact_empty_community_counts_are_zero(client, alice_token):
    resp = _get_impact(client, alice_token, EMPTY_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["active_tools_count"] == 0
    assert data["returned_loans_count"] == 0
    assert data["completed_tasks_count"] == 0


# --- as_of --------------------------------------------------------------------


def test_impact_as_of_is_iso_utc_timestamp(client, alice_token):
    before = utc_now()
    resp = _get_impact(client, alice_token)
    assert resp.status_code == 200, resp.text
    after = utc_now()
    as_of = resp.json()["data"]["as_of"]
    assert ISO_RE.match(as_of), as_of
    parsed = datetime.strptime(as_of, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    assert before - 1 <= parsed.timestamp() <= after + 1


# --- community lookup ----------------------------------------------------------


def test_impact_unknown_community_404(client, alice_token):
    unknown = str(uuid.uuid4())
    resp = _get_impact(client, alice_token, unknown)
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"
    text = resp.text
    assert "SELECT" not in text and ".sqlite3" not in text and "Traceback" not in text


def test_impact_requires_auth(client):
    resp = client.get(f"/api/v1/communities/{HOME_COMMUNITY_ID}/impact")
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"
