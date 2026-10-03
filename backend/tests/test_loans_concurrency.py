"""True concurrency tests (spec 6.4).

Each request runs on its own thread with its own TestClient and its own
SQLite connection against the same real file database — no serialised
simulation. Every scenario asserts the database's final state, not just the
HTTP status codes.
"""

from __future__ import annotations

import sqlite3
import threading
import uuid

import pytest
from fastapi.testclient import TestClient

from app.db import utc_now
from tests.conftest import auth_headers, login, new_idem_key

C_EH8 = "c1111111-1111-4111-8111-111111111111"
U_BOB = "u2222222-2222-4222-8222-222222222222"
U_ALICE = "u1111111-1111-4111-8111-111111111111"

T_WATERING = "t1111111-1111-4111-8111-111111111111"  # alice's watering can

ACTIVE = ("pending", "accepted", "on_loan")


# --- helpers ----------------------------------------------------------------


def _fetch(settings, sql, params=()):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _insert_tool(settings, *, tool_id, owner_id, category):
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        now = utc_now()
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category,"
            " description, is_archived, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)",
            (tool_id, owner_id, C_EH8, f"Race {category}", category, now, now),
        )
    finally:
        conn.close()


def _insert_requirement(settings, *, task_id, requirement_id, creator_id, category):
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        now = utc_now()
        conn.execute(
            "INSERT INTO tasks (id, creator_id, community_id, template_id, title,"
            " place_name, place_latitude, place_longitude, place_source, status,"
            " created_at) VALUES (?, ?, ?, 'park_cleanup', 'Race task',"
            " 'Demo point', 55.944703, -3.187417, 'manual', 'open', ?)",
            (task_id, creator_id, C_EH8, now),
        )
        conn.execute(
            "INSERT INTO task_requirements (id, task_id, category, quantity,"
            " self_supplied, created_at) VALUES (?, ?, ?, 1, 0, ?)",
            (requirement_id, task_id, category, now),
        )
    finally:
        conn.close()


def _single(app, *, method, path, token, json_body=None, key=None):
    """One HTTP request on a dedicated client/connection."""
    client = TestClient(app)
    try:
        headers = auth_headers("any", token)
        headers["Idempotency-Key"] = key or new_idem_key()
        return client.request(method, path, json=json_body, headers=headers)
    finally:
        client.close()


def _race(app, requests):
    """Fire every request concurrently behind a barrier.

    Returns the responses in request order; thread failures come back as
    exceptions so they fail the assertion loudly instead of deadlocking.
    """
    barrier = threading.Barrier(len(requests), timeout=15)
    results: list = [None] * len(requests)

    def run(index: int, spec: dict) -> None:
        try:
            barrier.wait()
            results[index] = _single(app, **spec)
        except Exception as exc:  # noqa: BLE001 - surfaced in assertions
            results[index] = exc

    threads = [
        threading.Thread(target=run, args=(index, spec))
        for index, spec in enumerate(requests)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert all(not t.is_alive() for t in threads), "a racer never finished"
    for result in results:
        assert not isinstance(result, Exception), result
    return results


def _tokens(app):
    with TestClient(app) as client:
        return {
            "alice": login(client, "alice"),
            "bob": login(client, "bob"),
            "carol": login(client, "carol"),
        }


# --- scenario 1: two borrowers, one tool --------------------------------------


def test_two_borrowers_race_for_one_tool(app, settings):
    tokens = _tokens(app)
    responses = _race(
        app,
        [
            {
                "method": "POST",
                "path": "/api/v1/loans",
                "token": tokens["bob"],
                "json_body": {"tool_id": T_WATERING},
            },
            {
                "method": "POST",
                "path": "/api/v1/loans",
                "token": tokens["carol"],
                "json_body": {"tool_id": T_WATERING},
            },
        ],
    )

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [201, 409], [r.text for r in responses]
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json()["error"]["code"] == "TOOL_UNAVAILABLE"
    winner = next(r for r in responses if r.status_code == 201)
    winner_id = winner.json()["data"]["id"]

    # Database ground truth: exactly one loan exists, and it is the winner's.
    loans = _fetch(
        settings,
        "SELECT id, borrower_id, status FROM loans WHERE tool_id = ?",
        (T_WATERING,),
    )
    assert len(loans) == 1, [dict(row) for row in loans]
    assert loans[0]["id"] == winner_id
    assert loans[0]["status"] == "pending"
    assert loans[0]["borrower_id"] in (U_BOB, "u3333333-3333-4333-8333-333333333333")

    # Exactly one created event — no ghost writes from the loser.
    events = _fetch(
        settings, "SELECT id FROM loan_events WHERE loan_id = ?", (winner_id,)
    )
    assert len(events) == 1

    # Idempotency records exist only for the successful actor.
    keys = _fetch(settings, "SELECT actor_id FROM idempotency_records")
    assert len(keys) == 1


# --- scenario 2: two tools, one requirement ------------------------------------


def test_two_tools_race_for_one_requirement(app, settings):
    tokens = _tokens(app)
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_requirement(
        settings,
        task_id=task_id,
        requirement_id=requirement_id,
        creator_id=U_BOB,
        category="watering_can",
    )
    second_tool = str(uuid.uuid4())
    _insert_tool(
        settings, tool_id=second_tool, owner_id=U_ALICE, category="watering_can"
    )

    responses = _race(
        app,
        [
            {
                "method": "POST",
                "path": "/api/v1/loans",
                "token": tokens["bob"],
                "json_body": {"tool_id": T_WATERING, "requirement_id": requirement_id},
            },
            {
                "method": "POST",
                "path": "/api/v1/loans",
                "token": tokens["bob"],
                "json_body": {"tool_id": second_tool, "requirement_id": requirement_id},
            },
        ],
    )

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [201, 409], [r.text for r in responses]
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json()["error"]["code"] == "REQUIREMENT_OCCUPIED"

    # Database ground truth: one loan holds the requirement, the other tool
    # has no loan at all.
    held = _fetch(
        settings,
        "SELECT id, tool_id, status FROM loans WHERE requirement_id = ?",
        (requirement_id,),
    )
    assert len(held) == 1, [dict(row) for row in held]
    assert held[0]["status"] == "pending"
    assert held[0]["tool_id"] in (T_WATERING, second_tool)
    winner_tool = held[0]["tool_id"]
    loser_tool = second_tool if winner_tool == T_WATERING else T_WATERING
    assert (
        _fetch(settings, "SELECT id FROM loans WHERE tool_id = ?", (loser_tool,)) == []
    )

    # The partial unique index agrees: one active row per requirement.
    active = _fetch(
        settings,
        "SELECT id FROM loans WHERE requirement_id = ? AND status IN (?,?,?)",
        (requirement_id, *ACTIVE),
    )
    assert len(active) == 1


# --- scenario 3: self-supply vs new request (needs the tasks module) -----------
_SELF_SUPPLY_PATH = "/api/v1/tasks/{task_id}/requirements/{requirement_id}/self-supply"


def test_self_supply_and_loan_race(app, settings):
    """Spec 6.4: a self-supply change and a new request may not both succeed.

    The PUT endpoint belongs to the parallel tasks module; if it is not
    registered yet this test skips with that reason instead of pretending to
    verify it.
    """
    tokens = _tokens(app)
    with TestClient(app) as probe:
        spec = probe.get("/openapi.json")
        assert spec.status_code == 200
        paths = spec.json().get("paths", {})
    if _SELF_SUPPLY_PATH not in paths:
        pytest.skip(
            "tasks module's self-supply endpoint is not registered yet "
            "(parallel module); race cannot be driven over HTTP"
        )

    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_requirement(
        settings,
        task_id=task_id,
        requirement_id=requirement_id,
        creator_id=U_BOB,
        category="litter_picker",
    )
    borrowed_tool = str(uuid.uuid4())
    _insert_tool(
        settings, tool_id=borrowed_tool, owner_id=U_ALICE, category="litter_picker"
    )

    responses = _race(
        app,
        [
            {
                "method": "PUT",
                "path": _SELF_SUPPLY_PATH.format(
                    task_id=task_id, requirement_id=requirement_id
                ),
                "token": tokens["bob"],
                "json_body": {"self_supplied": True},
            },
            {
                "method": "POST",
                "path": "/api/v1/loans",
                "token": tokens["bob"],
                "json_body": {
                    "tool_id": borrowed_tool,
                    "requirement_id": requirement_id,
                },
            },
        ],
    )

    # No server errors, and at most one side may have won.
    assert all(r.status_code < 500 for r in responses), [r.text for r in responses]
    requirement = _fetch(
        settings,
        "SELECT self_supplied FROM task_requirements WHERE id = ?",
        (requirement_id,),
    )[0]
    active_loans = _fetch(
        settings,
        "SELECT id FROM loans WHERE requirement_id = ? AND status IN (?,?,?)",
        (requirement_id, *ACTIVE),
    )
    # The hard invariant: never self-supplied AND covered by an active loan
    # at the same time.
    if requirement["self_supplied"] == 1:
        assert len(active_loans) == 0, "self-supplied requirement still has an active loan"
    if len(active_loans) == 1:
        assert requirement["self_supplied"] == 0, "active loan while self-supplied"
