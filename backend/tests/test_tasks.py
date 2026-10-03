"""Contract tests for task templates, tasks and requirement states (spec 7 / 8).

Loans are never created through the loans API here (that module is owned by a
parallel task): derived states are exercised by inserting minimal `loans` rows
directly with SQL, and candidate tools are inserted into `tools` directly.
"""

from __future__ import annotations

import uuid

import pytest

from app.db import connect, utc_now, write_transaction
from tests.conftest import auth_headers, login, new_idem_key

HOME_COMMUNITY = "c1111111-1111-4111-8111-111111111111"
FAR_COMMUNITY = "c2222222-2222-4222-8222-222222222222"  # ~2.3 km away
NEAR_COMMUNITY = "c3333333-3333-4333-8333-333333333333"  # ~45 m away
GLOVES_TOOL = "t3333333-3333-4333-8333-333333333333"  # bob's gloves, home community

API = "/api/v1"


# --- Helpers ----------------------------------------------------------------


def db(settings):
    return connect(settings.database_path)


def user_id(settings, alias: str) -> str:
    with db(settings) as conn:
        row = conn.execute("SELECT id FROM users WHERE alias = ?", (alias,)).fetchone()
    assert row is not None, alias
    return row["id"]


def community(settings, community_id: str) -> dict:
    with db(settings) as conn:
        row = conn.execute(
            "SELECT * FROM communities WHERE id = ?", (community_id,)
        ).fetchone()
    assert row is not None, community_id
    return dict(row)


def insert_community(settings, community_id, postcode, latitude, longitude):
    now = utc_now()
    with db(settings) as conn, write_transaction(conn):
        conn.execute(
            "INSERT INTO communities (id, postcode, outcode, latitude, longitude, "
            "country, source, source_kind, fetched_at, created_at) "
            "VALUES (?, ?, 'EH8', ?, ?, 'Scotland', 'fixture', 'fixture', ?, ?)",
            (community_id, postcode, latitude, longitude, now, now),
        )


def insert_user(settings, user_id_, alias, community_id=HOME_COMMUNITY):
    with db(settings) as conn, write_transaction(conn):
        conn.execute(
            "INSERT INTO users (id, alias, display_name, community_id, is_active, created_at) "
            "VALUES (?, ?, ?, ?, 1, ?)",
            (user_id_, alias, alias.title(), community_id, utc_now()),
        )


def insert_tool(
    settings,
    tool_id,
    owner_id,
    category,
    community_id=HOME_COMMUNITY,
    created_at=None,
    is_archived=0,
    name="Borrowable tool",
):
    stamp = created_at if created_at is not None else utc_now()
    with db(settings) as conn, write_transaction(conn):
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category, "
            "description, is_archived, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)",
            (tool_id, owner_id, community_id, name[:80], category, is_archived, stamp, stamp),
        )


def insert_loan(
    settings,
    tool_id,
    borrower_id,
    requirement_id,
    status,
    handed_over_at=None,
    created_at=None,
):
    stamp = created_at if created_at is not None else utc_now()
    with db(settings) as conn, write_transaction(conn):
        conn.execute(
            "INSERT INTO loans (id, tool_id, borrower_id, requirement_id, status, "
            "note, created_at, updated_at, accepted_at, handed_over_at, returned_at, "
            "rejected_at, cancelled_at) "
            "VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                tool_id,
                borrower_id,
                requirement_id,
                status,
                stamp,
                stamp,
                stamp if status == "accepted" else None,
                handed_over_at,
                stamp if status == "returned" else None,
                stamp if status == "rejected" else None,
                stamp if status == "cancelled" else None,
            ),
        )


def insert_greenspace_cache(settings, source_id="way/42", name="Demo Meadows"):
    payload = {
        "elements": [
            {
                "type": "way",
                "id": int(str(source_id).split("/")[-1]),
                "lat": 55.945,
                "lon": -3.188,
                "tags": {"name": name},
            }
        ]
    }
    import json as _json

    with db(settings) as conn, write_transaction(conn):
        conn.execute(
            "INSERT INTO external_cache (cache_key, provider, schema_version, "
            "payload_json, source_url, attribution, source_kind, fetched_at) "
            "VALUES (?, 'overpass', '1', ?, '', '', 'fixture', ?)",
            (f"greenspace:{HOME_COMMUNITY}", _json.dumps(payload), utc_now()),
        )


def headers(token, key=None):
    h = auth_headers("user", token)
    if key:
        h["Idempotency-Key"] = key
    return h


def create_task(client, token, **overrides):
    body = {"template_id": "park_cleanup"}
    body.update(overrides)
    return client.post(f"{API}/tasks", json=body, headers=headers(token, new_idem_key()))


def task_data(response, status=201):
    assert response.status_code == status, response.text
    return response.json()["data"]


def get_task(client, token, task_id):
    return client.get(f"{API}/tasks/{task_id}", headers=headers(token))


def req_by_category(data, category):
    return next(r for r in data["requirements"] if r["category"] == category)


def put_self_supply(client, token, task_id, requirement_id, value, key=None):
    return client.put(
        f"{API}/tasks/{task_id}/requirements/{requirement_id}/self-supply",
        json={"self_supplied": value},
        headers=headers(token, key or new_idem_key()),
    )


def complete(client, token, task_id, body, key=None):
    return client.post(
        f"{API}/tasks/{task_id}/complete",
        json=body,
        headers=headers(token, key or new_idem_key()),
    )


def make_eligible_task(client, token):
    """Task whose two requirements are both self-supplied (=> eligible)."""
    data = task_data(create_task(client, token))
    for req in data["requirements"]:
        resp = put_self_supply(client, token, data["id"], req["id"], True)
        assert resp.status_code == 200, resp.text
    final = get_task(client, token, data["id"]).json()["data"]
    assert final["completion_eligible"] is True
    return final


# --- Templates ----------------------------------------------------------------


def test_templates_are_read_from_database(client, alice_token, settings):
    resp = client.get(f"{API}/task-templates", headers=headers(alice_token))
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["meta"]["total"] == 2
    data = payload["data"]
    assert {t["id"] for t in data} == {"park_cleanup", "flowerbed_care"}

    park = next(t for t in data if t["id"] == "park_cleanup")
    assert {(r["category"], r["quantity"]) for r in park["requirements"]} == {
        ("litter_picker", 1),
        ("reusable_gloves", 1),
    }
    flower = next(t for t in data if t["id"] == "flowerbed_care")
    assert {(r["category"], r["quantity"]) for r in flower["requirements"]} == {
        ("watering_can", 1),
        ("hand_trowel", 1),
    }

    # The list is served from the DB, not a hard-coded copy: mutate the row.
    with db(settings) as conn, write_transaction(conn):
        conn.execute(
            "UPDATE task_templates SET title = ? WHERE id = 'park_cleanup'",
            ("Renamed in database",),
        )
    again = client.get(f"{API}/task-templates", headers=headers(alice_token))
    park_again = next(t for t in again.json()["data"] if t["id"] == "park_cleanup")
    assert park_again["title"] == "Renamed in database"


def test_task_templates_require_authentication(client):
    resp = client.get(f"{API}/task-templates")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


# --- Creation ----------------------------------------------------------------


def test_create_task_generates_template_requirements(client, alice_token, settings):
    resp = create_task(client, alice_token, title="Saturday clean-up")
    data = task_data(resp)
    assert resp.json()["meta"]["request_id"]

    assert set(data) == {
        "id",
        "title",
        "creator",
        "community_id",
        "template_id",
        "place",
        "status",
        "requirements",
        "coordination_ready",
        "completion_eligible",
        "outcome",
        "created_at",
        "completed_at",
    }
    assert data["title"] == "Saturday clean-up"
    assert data["template_id"] == "park_cleanup"
    assert data["status"] == "open"
    assert data["community_id"] == HOME_COMMUNITY
    assert data["creator"] == {
        "id": user_id(settings, "alice"),
        "display_name": "Alice",
    }
    assert data["outcome"] is None
    assert data["created_at"].endswith("Z")
    assert data["completed_at"] is None

    assert len(data["requirements"]) == 2
    assert {r["category"] for r in data["requirements"]} == {
        "litter_picker",
        "reusable_gloves",
    }
    for req in data["requirements"]:
        assert req["quantity"] == 1
        assert req["self_supplied"] is False
        assert req["state"] in {
            "self_supplied",
            "pending",
            "confirmed",
            "in_use",
            "fulfilled",
            "match_available",
            "missing",
        }
        assert req["active_loan_id"] is None
        assert isinstance(req["candidate_tool_ids"], list)

    # Requirement rows exist in the DB with the template categories.
    with db(settings) as conn:
        rows = conn.execute(
            "SELECT category, quantity FROM task_requirements WHERE task_id = ? "
            "ORDER BY category",
            (data["id"],),
        ).fetchall()
    assert [(r["category"], r["quantity"]) for r in rows] == [
        ("litter_picker", 1),
        ("reusable_gloves", 1),
    ]

    # Default place: the creator's community centre as a fixture.
    home = community(settings, HOME_COMMUNITY)
    assert data["place"]["name"] == "Community centre"
    assert data["place"]["source"] == "fixture"
    assert data["place"]["source_id"] is None
    assert data["place"]["latitude"] == pytest.approx(home["latitude"])
    assert data["place"]["longitude"] == pytest.approx(home["longitude"])


def test_create_task_unknown_template_is_validation_error(client, alice_token):
    resp = create_task(client, alice_token, template_id="does_not_exist")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- Listing ------------------------------------------------------------------


def test_list_tasks_scopes_and_pagination(client, alice_token, bob_token, settings):
    for i in range(3):
        assert create_task(client, alice_token, title=f"A{i}").status_code == 201
    assert (
        create_task(
            client, bob_token, template_id="flowerbed_care", title="B0"
        ).status_code
        == 201
    )

    alice_id = user_id(settings, "alice")

    # scope=mine is the default: only the caller's tasks.
    resp = client.get(f"{API}/tasks", headers=headers(alice_token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["meta"]["total"] == 4  # 3 fixture + 1 seeded demo story
    assert len(body["data"]) == 4  # 3 fixture + 1 seeded demo story
    assert {t["creator"]["id"] for t in body["data"]} == {alice_id}
    for item in body["data"]:
        assert "requirements" not in item
        assert "active_loan_id" not in item
        assert set(item) == {
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
        }

    # Pagination keeps total over the same filter.
    page1 = client.get(
        f"{API}/tasks?limit=2&offset=0", headers=headers(alice_token)
    ).json()
    page2 = client.get(
        f"{API}/tasks?limit=2&offset=2", headers=headers(alice_token)
    ).json()
    assert len(page1["data"]) == 2 and page1["meta"]["total"] == 4
    assert page1["meta"]["limit"] == 2 and page1["meta"]["offset"] == 0
    assert len(page2["data"]) == 2 and page2["meta"]["total"] == 4
    ids = {t["id"] for t in page1["data"]} | {t["id"] for t in page2["data"]}
    assert len(ids) == 4  # stable, non-overlapping pages (3 fixture + 1 seeded story)

    # scope=community requires community_id.
    resp = client.get(f"{API}/tasks?scope=community", headers=headers(alice_token))
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    # Unknown community -> 404.
    resp = client.get(
        f"{API}/tasks?scope=community&community_id={uuid.uuid4()}",
        headers=headers(alice_token),
    )
    assert resp.status_code == 404

    # scope=community returns every task of that community, summaries only.
    resp = client.get(
        f"{API}/tasks?scope=community&community_id={HOME_COMMUNITY}",
        headers=headers(alice_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["meta"]["total"] == 6  # 4 fixture + 2 seeded demo stories
    assert {t["creator"]["id"] for t in resp.json()["data"]} == {
        alice_id,
        user_id(settings, "bob"),
    }

    # limit bounds.
    resp = client.get(f"{API}/tasks?limit=0", headers=headers(alice_token))
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- Derived requirement states (spec 7.1) ------------------------------------


def test_state_match_available_and_missing(client, alice_token):
    data = task_data(create_task(client, alice_token))
    litter = req_by_category(data, "litter_picker")
    gloves = req_by_category(data, "reusable_gloves")
    # No litter picker exists in the seed; bob's gloves are borrowable.
    assert litter["state"] == "missing"
    assert litter["candidate_tool_ids"] == []
    assert gloves["state"] == "match_available"
    assert gloves["candidate_tool_ids"] == [GLOVES_TOOL]
    assert data["coordination_ready"] is False
    assert data["completion_eligible"] is False


def test_state_self_supplied(client, alice_token):
    data = task_data(create_task(client, alice_token))
    litter = req_by_category(data, "litter_picker")
    resp = put_self_supply(client, alice_token, data["id"], litter["id"], True)
    data = task_data(resp, status=200)
    litter = req_by_category(data, "litter_picker")
    assert litter["self_supplied"] is True
    assert litter["state"] == "self_supplied"
    assert litter["candidate_tool_ids"] == []


@pytest.mark.parametrize(
    "status,expected_state,coordination_ready,completion_eligible",
    [
        ("pending", "pending", False, False),
        ("accepted", "confirmed", True, False),
        ("on_loan", "in_use", True, True),
    ],
)
def test_state_from_active_loan(
    client,
    alice_token,
    settings,
    status,
    expected_state,
    coordination_ready,
    completion_eligible,
):
    data = task_data(create_task(client, alice_token))
    litter = req_by_category(data, "litter_picker")
    gloves = req_by_category(data, "reusable_gloves")
    assert (
        put_self_supply(client, alice_token, data["id"], litter["id"], True).status_code
        == 200
    )
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=gloves["id"],
        status=status,
    )

    data = get_task(client, alice_token, data["id"]).json()["data"]
    gloves = req_by_category(data, "reusable_gloves")
    assert gloves["state"] == expected_state
    assert gloves["active_loan_id"] is not None
    assert gloves["candidate_tool_ids"] == []
    assert data["coordination_ready"] is coordination_ready
    assert data["completion_eligible"] is completion_eligible

    if completion_eligible:
        # Tools still on loan do not block completion (spec 7.2).
        resp = complete(
            client,
            alice_token,
            data["id"],
            {"outcome_note": "Done with the tool still borrowed."},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["status"] == "completed"


def test_state_fulfilled_from_returned_loan(client, alice_token, settings):
    data = task_data(create_task(client, alice_token))
    litter = req_by_category(data, "litter_picker")
    gloves = req_by_category(data, "reusable_gloves")
    put_self_supply(client, alice_token, data["id"], litter["id"], True)
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=gloves["id"],
        status="returned",
        handed_over_at=utc_now(),
    )

    data = get_task(client, alice_token, data["id"]).json()["data"]
    gloves = req_by_category(data, "reusable_gloves")
    assert gloves["state"] == "fulfilled"
    assert gloves["active_loan_id"] is None
    assert gloves["candidate_tool_ids"] == []
    assert data["coordination_ready"] is True
    assert data["completion_eligible"] is True


@pytest.mark.parametrize("status", ["rejected", "cancelled"])
def test_rejected_and_cancelled_loans_do_not_satisfy(
    client, alice_token, settings, status
):
    data = task_data(create_task(client, alice_token))
    gloves = req_by_category(data, "reusable_gloves")
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=gloves["id"],
        status=status,
    )
    data = get_task(client, alice_token, data["id"]).json()["data"]
    gloves = req_by_category(data, "reusable_gloves")
    assert gloves["state"] == "match_available"
    assert GLOVES_TOOL in gloves["candidate_tool_ids"]


def test_active_loan_id_hidden_from_unrelated_viewer(
    client, alice_token, settings
):
    dave_id = str(uuid.uuid4())
    insert_user(settings, dave_id, "dave")
    dave_token = login(client, "dave")

    data = task_data(create_task(client, alice_token))
    gloves = req_by_category(data, "reusable_gloves")
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=gloves["id"],
        status="pending",
    )

    for token in (alice_token,):  # creator
        seen = req_by_category(
            get_task(client, token, data["id"]).json()["data"], "reusable_gloves"
        )
        assert seen["active_loan_id"] is not None
    # Borrower and tool owner are part of the loan.
    for alias in ("carol", "bob"):
        seen = req_by_category(
            get_task(client, login(client, alias), data["id"]).json()["data"],
            "reusable_gloves",
        )
        assert seen["active_loan_id"] is not None
    # An unrelated neighbour sees the public state but no loan id.
    unseen = req_by_category(
        get_task(client, dave_token, data["id"]).json()["data"], "reusable_gloves"
    )
    assert unseen["state"] == "pending"
    assert unseen["active_loan_id"] is None


def test_ready_and_eligible_combinations(client, alice_token, settings):
    data = task_data(create_task(client, alice_token))
    litter = req_by_category(data, "litter_picker")
    gloves = req_by_category(data, "reusable_gloves")

    # Neither covered yet.
    assert data["coordination_ready"] is False
    assert data["completion_eligible"] is False

    # One self-supplied, one still only matchable: still not coordinated.
    put_self_supply(client, alice_token, data["id"], litter["id"], True)
    data = get_task(client, alice_token, data["id"]).json()["data"]
    assert req_by_category(data, "litter_picker")["state"] == "self_supplied"
    assert data["coordination_ready"] is False
    assert data["completion_eligible"] is False

    # Confirmed booking: coordinated but not completion-eligible.
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=req_by_category(data, "reusable_gloves")["id"],
        status="accepted",
    )
    data = get_task(client, alice_token, data["id"]).json()["data"]
    assert data["coordination_ready"] is True
    assert data["completion_eligible"] is False

    # Every requirement self-supplied: both flags true.
    data = make_eligible_task(client, alice_token)
    assert data["coordination_ready"] is True
    assert data["completion_eligible"] is True


# --- Self-supply writes --------------------------------------------------------


def test_self_supply_locks_with_active_loan(client, alice_token, settings):
    data = task_data(create_task(client, alice_token))
    gloves = req_by_category(data, "reusable_gloves")
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=gloves["id"],
        status="pending",
    )
    resp = put_self_supply(client, alice_token, data["id"], gloves["id"], True)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "REQUIREMENT_LOCKED"


def test_self_supply_locks_after_usage_history(client, alice_token, settings):
    data = task_data(create_task(client, alice_token))
    gloves = req_by_category(data, "reusable_gloves")
    insert_loan(
        settings,
        tool_id=GLOVES_TOOL,
        borrower_id=user_id(settings, "carol"),
        requirement_id=gloves["id"],
        status="returned",
        handed_over_at=utc_now(),
    )
    resp = put_self_supply(client, alice_token, data["id"], gloves["id"], True)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "REQUIREMENT_LOCKED"


def test_self_supply_rejected_after_completion(client, alice_token):
    data = make_eligible_task(client, alice_token)
    resp = complete(
        client, alice_token, data["id"], {"outcome_note": "All done today."}
    )
    assert resp.status_code == 200, resp.text

    req_id = data["requirements"][0]["id"]
    resp = put_self_supply(client, alice_token, data["id"], req_id, False)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "TASK_ALREADY_COMPLETED"


def test_self_supply_forbidden_for_non_creator(client, alice_token, bob_token):
    data = task_data(create_task(client, alice_token))
    req_id = data["requirements"][0]["id"]
    resp = put_self_supply(client, bob_token, data["id"], req_id, True)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "FORBIDDEN"


def test_self_supply_requirement_of_other_task_is_404(client, alice_token):
    task1 = task_data(create_task(client, alice_token))
    task2 = task_data(create_task(client, alice_token))
    foreign_req = task2["requirements"][0]["id"]
    resp = put_self_supply(client, alice_token, task1["id"], foreign_req, True)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"

    resp = put_self_supply(
        client, alice_token, task1["id"], str(uuid.uuid4()), True
    )
    assert resp.status_code == 404


def test_self_supply_rejects_non_boolean(client, alice_token):
    data = task_data(create_task(client, alice_token))
    req_id = data["requirements"][0]["id"]
    resp = client.put(
        f"{API}/tasks/{data['id']}/requirements/{req_id}/self-supply",
        json={"self_supplied": 1},
        headers=headers(alice_token, new_idem_key()),
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- Completion ----------------------------------------------------------------


def test_complete_ignores_the_tool_checklist(client, alice_token):
    """Getting the tools together (02) is optional: the organiser may record
    the outcome of an open action even when requirements are still missing or
    unconfirmed. The derived flags stay informative only."""
    data = task_data(create_task(client, alice_token))  # missing + match_available
    assert data["completion_eligible"] is False
    assert data["coordination_ready"] is False

    resp = complete(
        client, alice_token, data["id"], {"outcome_note": "Finished the cleanup."}
    )
    assert resp.status_code == 200, resp.text
    done = resp.json()["data"]
    assert done["status"] == "completed"
    assert done["outcome"]["note"] == "Finished the cleanup."
    assert done["outcome"]["bags_collected"] is None
    assert done["outcome"]["volunteer_minutes"] is None
    # The checklist is untouched: it keeps reporting its own progress.
    assert done["completion_eligible"] is False
    assert done["coordination_ready"] is False
    assert {r["state"] for r in done["requirements"]} <= {"missing", "match_available"}


def test_complete_with_an_active_loan_still_works(client, alice_token, settings):
    """A pending request does not block the report either — borrowing and
    completing stay separate facts (the loan keeps its own state machine)."""
    data = task_data(create_task(client, alice_token))
    gloves = req_by_category(data, "reusable_gloves")
    insert_loan(
        settings, GLOVES_TOOL, user_id(settings, "alice"), gloves["id"], "pending"
    )

    resp = complete(
        client, alice_token, data["id"], {"outcome_note": "Recorded with a request still open."}
    )
    assert resp.status_code == 200, resp.text
    done = resp.json()["data"]
    assert done["status"] == "completed"
    assert req_by_category(done, "reusable_gloves")["state"] == "pending"
    assert done["completion_eligible"] is False


def test_complete_success_replay_noop_and_conflict(client, alice_token):
    data = make_eligible_task(client, alice_token)
    body = {
        "outcome_note": "Collected 3 bags of litter by the play park.",
        "bags_collected": 3,
        "volunteer_minutes": 45,
    }
    key = new_idem_key()

    resp = complete(client, alice_token, data["id"], body, key=key)
    assert resp.status_code == 200, resp.text
    done = resp.json()["data"]
    assert done["status"] == "completed"
    assert done["completed_at"].endswith("Z")
    assert done["outcome"] == {
        "note": body["outcome_note"],
        "bags_collected": 3,
        "volunteer_minutes": 45,
        "verification": "self_reported",
    }

    # Old key replays the stored response, even later.
    replay = complete(client, alice_token, data["id"], body, key=key)
    assert replay.status_code == 200
    assert replay.headers.get("Idempotency-Replayed") == "true"
    assert replay.json()["data"]["completed_at"] == done["completed_at"]

    # Same body, brand-new key: 200 no-op, timestamps untouched.
    noop = complete(client, alice_token, data["id"], body)
    assert noop.status_code == 200, noop.text
    assert noop.json()["data"]["completed_at"] == done["completed_at"]

    # Different body, new key: the outcome may not be rewritten.
    conflict = complete(
        client,
        alice_token,
        data["id"],
        {"outcome_note": "Actually it was 10 bags.", "bags_collected": 10},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "TASK_ALREADY_COMPLETED"

    # Same key with a different body: idempotency key reuse.
    reused = complete(
        client, alice_token, data["id"], {"outcome_note": "Rewrite attempt"}, key=key
    )
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_complete_forbidden_for_non_creator(client, alice_token, bob_token):
    data = make_eligible_task(client, alice_token)
    resp = complete(
        client, bob_token, data["id"], {"outcome_note": "Let me finish this."}
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "FORBIDDEN"
    assert get_task(client, alice_token, data["id"]).json()["data"]["status"] == "open"


def test_complete_rejects_boolean_integers(client, alice_token):
    data = make_eligible_task(client, alice_token)
    resp = complete(
        client,
        alice_token,
        data["id"],
        {"outcome_note": "Done.", "bags_collected": True},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    resp = complete(
        client,
        alice_token,
        data["id"],
        {"outcome_note": "Done.", "volunteer_minutes": True},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    # The task is untouched.
    assert get_task(client, alice_token, data["id"]).json()["data"]["status"] == "open"


def test_complete_requires_outcome_note(client, alice_token):
    data = make_eligible_task(client, alice_token)
    resp = complete(client, alice_token, data["id"], {})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_unknown_task_is_404(client, alice_token):
    resp = get_task(client, alice_token, str(uuid.uuid4()))
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_completed_task_outcome_is_immutable_read(client, alice_token):
    data = make_eligible_task(client, alice_token)
    complete(client, alice_token, data["id"], {"outcome_note": "One line note."})
    detail = get_task(client, alice_token, data["id"]).json()["data"]
    assert detail["outcome"] == {
        "note": "One line note.",
        "bags_collected": None,
        "volunteer_minutes": None,
        "verification": "self_reported",
    }


# --- Candidate tools (spec 8.3) -------------------------------------------------


def test_candidate_tool_ids_limit_and_order(client, alice_token, bob_token, settings):
    alice = user_id(settings, "alice")
    bob = user_id(settings, "bob")
    carol = user_id(settings, "carol")

    insert_community(settings, NEAR_COMMUNITY, "EH8 9AC", 55.945, -3.187)

    # 7 available litter pickers in the home community (two share created_at).
    home_expected = []
    for n, created in enumerate(
        [100, 100, 101, 102, 103, 104, 105], start=1
    ):
        tool_id = f"aaaaaaaa-0000-4000-8000-{n:012d}"
        insert_tool(
            settings,
            tool_id,
            bob,
            "litter_picker",
            community_id=HOME_COMMUNITY,
            created_at=created,
        )
        home_expected.append((created, tool_id))
    home_expected.sort()  # created_at ASC, id ASC -> first five are in
    expected = [t for _, t in home_expected[:5]]

    # Nearby community tools (in range) sort after same-community ones even
    # though they are older.
    for n, created in enumerate([10, 11, 12], start=1):
        insert_tool(
            settings,
            f"bbbbbbbb-0000-4000-8000-{n:012d}",
            carol,
            "litter_picker",
            community_id=NEAR_COMMUNITY,
            created_at=created,
        )

    # Excluded: archived, owned by the creator, already reserved, out of range.
    insert_tool(settings, "cccccccc-0000-4000-8000-000000000001", bob,
                "litter_picker", created_at=1, is_archived=1)
    insert_tool(settings, "cccccccc-0000-4000-8000-000000000002", alice,
                "litter_picker", created_at=1)
    reserved_id = "cccccccc-0000-4000-8000-000000000003"
    insert_tool(settings, reserved_id, bob, "litter_picker", created_at=1)
    insert_loan(
        settings,
        tool_id=reserved_id,
        borrower_id=carol,
        requirement_id=None,
        status="pending",
    )
    insert_tool(settings, "cccccccc-0000-4000-8000-000000000004", bob,
                "litter_picker", community_id=FAR_COMMUNITY, created_at=1)

    data = task_data(create_task(client, alice_token))
    litter = req_by_category(data, "litter_picker")
    assert litter["state"] == "match_available"
    assert litter["candidate_tool_ids"] == expected
    assert len(litter["candidate_tool_ids"]) == 5

    # The same list is what an unrelated neighbour sees.
    other = req_by_category(
        get_task(client, bob_token, data["id"]).json()["data"], "litter_picker"
    )
    assert other["candidate_tool_ids"] == expected


# --- Place validation (spec 8.4) -------------------------------------------------


def test_place_out_of_range_is_rejected(client, alice_token):
    resp = create_task(
        client,
        alice_token,
        place={
            "name": "Too far away",
            "latitude": 56.5,
            "longitude": -3.187417,
            "source": "manual",
            "source_id": None,
        },
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "OUT_OF_RANGE"


def test_place_invalid_coordinates_rejected(client, alice_token):
    resp = create_task(
        client,
        alice_token,
        place={
            "name": "Off the planet",
            "latitude": 91.0,
            "longitude": -3.187417,
            "source": "manual",
            "source_id": None,
        },
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    resp = client.post(
        f"{API}/tasks",
        # httpx refuses to encode NaN via json=; send the raw (Python-style)
        # JSON token instead to prove the server rejects non-finite coords.
        content=(
            '{"template_id": "park_cleanup", "place": {"name": "Not a number", '
            '"latitude": NaN, "longitude": -3.187417, "source": "manual", '
            '"source_id": null}}'
        ),
        headers={
            **headers(alice_token, new_idem_key()),
            "Content-Type": "application/json",
        },
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_place_invalid_source_rejected(client, alice_token):
    resp = create_task(
        client,
        alice_token,
        place={
            "name": "Drone survey",
            "latitude": 55.944703,
            "longitude": -3.187417,
            "source": "drone",
            "source_id": None,
        },
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_place_osm_requires_cached_greenspace(client, alice_token, settings):
    base = {
        "name": "Client claimed park",
        "latitude": 55.5,
        "longitude": -3.5,
        "source": "osm",
        "source_id": "way/42",
    }
    # No greenspace cached yet -> osm places are rejected, manual still works.
    resp = create_task(client, alice_token, place=base)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    resp = create_task(
        client,
        alice_token,
        place={
            "name": "Manual spot",
            "latitude": 55.944703,
            "longitude": -3.187417,
            "source": "manual",
            "source_id": None,
        },
    )
    assert resp.status_code == 201, resp.text

    insert_greenspace_cache(settings, source_id="way/42", name="Demo Meadows")
    data = task_data(create_task(client, alice_token, place=base))
    # Name and coordinates come from the server-side cache, not the client.
    assert data["place"]["source"] == "osm"
    assert data["place"]["source_id"] == "way/42"
    assert data["place"]["name"] == "Demo Meadows"
    assert data["place"]["latitude"] == pytest.approx(55.945)
    assert data["place"]["longitude"] == pytest.approx(-3.188)


# --- Contract hardening: extra=forbid, idempotency, spoofed headers -------------


def test_extra_fields_rejected_everywhere(client, alice_token):
    resp = client.post(
        f"{API}/tasks",
        json={
            "template_id": "park_cleanup",
            "status": "completed",
            "outcome": {"note": "forged"},
        },
        headers=headers(alice_token, new_idem_key()),
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    data = task_data(create_task(client, alice_token))
    resp = complete(
        client,
        alice_token,
        data["id"],
        {"outcome_note": "ok", "status": "completed"},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    resp = client.put(
        f"{API}/tasks/{data['id']}/requirements/{data['requirements'][0]['id']}/self-supply",
        json={"self_supplied": True, "state": "self_supplied"},
        headers=headers(alice_token, new_idem_key()),
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_create_task_requires_idempotency_key(client, alice_token):
    resp = client.post(
        f"{API}/tasks",
        json={"template_id": "park_cleanup"},
        headers=auth_headers("alice", alice_token),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_create_task_idempotent_replay_and_key_reuse(client, alice_token):
    body = {"template_id": "park_cleanup", "title": "Replay me"}
    key = new_idem_key()

    first = client.post(
        f"{API}/tasks", json=body, headers=headers(alice_token, key)
    )
    assert first.status_code == 201, first.text
    assert "Idempotency-Replayed" not in first.headers
    created_id = first.json()["data"]["id"]

    second = client.post(
        f"{API}/tasks", json=body, headers=headers(alice_token, key)
    )
    assert second.status_code == 201
    assert second.headers.get("Idempotency-Replayed") == "true"
    assert second.json()["data"]["id"] == created_id

    # Only one task was actually created.
    listing = client.get(f"{API}/tasks", headers=headers(alice_token))
    assert listing.json()["meta"]["total"] == 2  # 1 created here + 1 seeded demo story

    # Same key, different intent -> 409.
    third = client.post(
        f"{API}/tasks",
        json={"template_id": "flowerbed_care"},
        headers=headers(alice_token, key),
    )
    assert third.status_code == 409
    assert third.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_self_supply_idempotent_replay(client, alice_token):
    data = task_data(create_task(client, alice_token))
    req_id = data["requirements"][0]["id"]
    key = new_idem_key()

    first = put_self_supply(
        client, alice_token, data["id"], req_id, True, key=key
    )
    assert first.status_code == 200
    second = put_self_supply(
        client, alice_token, data["id"], req_id, True, key=key
    )
    assert second.status_code == 200
    assert second.headers.get("Idempotency-Replayed") == "true"
    assert second.json()["data"]["id"] == first.json()["data"]["id"]

    # Same key with a different payload -> 409.
    third = put_self_supply(
        client, alice_token, data["id"], req_id, False, key=key
    )
    assert third.status_code == 409
    assert third.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_spoofed_user_id_header_unlocks_nothing(client, alice_token):
    # Foundation contract: X-User-Id without any bearer token -> 401, no data.
    resp = client.get(
        f"{API}/tasks", headers={"X-User-Id": "u1111111-1111-4111-8111-111111111111"}
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"
    assert "u1111111" not in resp.text

    # Plain unauthenticated access follows spec 8.5 (401).
    resp = client.get(f"{API}/tasks")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"
