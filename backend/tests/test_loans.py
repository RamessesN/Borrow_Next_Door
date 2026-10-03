"""Contract tests for the loans endpoints (spec 4.2 / 4.3 / 6.1-6.3 / 8.2)."""

from __future__ import annotations

import sqlite3
import uuid

import pytest

from app.db import utc_now
from tests.conftest import auth_headers, new_idem_key

C_EH8 = "c1111111-1111-4111-8111-111111111111"
C_EH16 = "c2222222-2222-4222-8222-222222222222"

U_ALICE = "u1111111-1111-4111-8111-111111111111"
U_BOB = "u2222222-2222-4222-8222-222222222222"
U_CAROL = "u3333333-3333-4333-8333-333333333333"

T_WATERING = "t1111111-1111-4111-8111-111111111111"  # alice's seed tool

LOAN_FIELDS = {
    "id", "tool_id", "tool_name", "owner_id", "borrower_id", "requirement_id",
    "task_id", "status", "note", "created_at", "updated_at", "accepted_at",
    "handed_over_at", "returned_at", "rejected_at", "cancelled_at",
}

EVENT_FIELDS = {"id", "loan_id", "actor_id", "action", "from_status", "to_status", "created_at"}


# --- helpers ----------------------------------------------------------------


def _hdr(token: str) -> dict[str, str]:
    return auth_headers("any", token)


def _publish(client, token, *, category="litter_picker") -> str:
    """Owner publishes a fresh tool; returns its id."""
    resp = client.post(
        "/api/v1/tools",
        json={
            "name": f"Lendable {uuid.uuid4().hex[:8]}",
            "category": category,
            "description": "",
        },
        headers={**_hdr(token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]["id"]


def _request_loan(client, token, tool_id, *, key=None, **extra):
    body = {"tool_id": tool_id, **extra}
    return client.post(
        "/api/v1/loans",
        json=body,
        headers={**_hdr(token), "Idempotency-Key": key or new_idem_key()},
    )


def _act(client, token, loan_id, action, *, key=None):
    return client.post(
        f"/api/v1/loans/{loan_id}/{action}",
        headers={**_hdr(token), "Idempotency-Key": key or new_idem_key()},
    )


def _reach(client, owner_token, borrower_token, target: str) -> str:
    """Publish a tool, request it, drive the loan to `target`; returns loan id."""
    tool_id = _publish(client, owner_token)
    created = _request_loan(client, borrower_token, tool_id)
    assert created.status_code == 201, created.text
    loan_id = created.json()["data"]["id"]
    plan = {
        "pending": [],
        "accepted": [("owner", "accept")],
        "on_loan": [("owner", "accept"), ("owner", "hand-over")],
        "returned": [
            ("owner", "accept"),
            ("owner", "hand-over"),
            ("owner", "return"),
        ],
        "rejected": [("owner", "reject")],
        "cancelled": [("borrower", "cancel")],
    }[target]
    for who, action in plan:
        token = owner_token if who == "owner" else borrower_token
        resp = _act(client, token, loan_id, action)
        assert resp.status_code == 200, (target, action, resp.text)
    return loan_id


def _fetch(settings, sql, params=()):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _insert_task(settings, *, task_id, creator_id, template_id="park_cleanup", status="open"):
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        conn.execute(
            "INSERT INTO tasks (id, creator_id, community_id, template_id, title,"
            " place_name, place_latitude, place_longitude, place_source, status,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
            (
                task_id, creator_id, C_EH8, template_id, "Test task",
                "Demo meeting point", 55.944703, -3.187417, status, utc_now(),
            ),
        )
    finally:
        conn.close()


def _insert_requirement(settings, *, requirement_id, task_id, category, self_supplied=0):
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        conn.execute(
            "INSERT INTO task_requirements (id, task_id, category, quantity,"
            " self_supplied, created_at) VALUES (?, ?, ?, 1, ?, ?)",
            (requirement_id, task_id, category, self_supplied, utc_now()),
        )
    finally:
        conn.close()


# --- happy path ---------------------------------------------------------------


def test_full_happy_path_create_accept_handover_return(
    client, alice_token, bob_token
):
    tool_id = _publish(client, alice_token, category="watering_can")

    created = _request_loan(
        client, bob_token, tool_id, note="For our neighbourhood clean-up."
    )
    assert created.status_code == 201, created.text
    assert created.headers.get("Idempotency-Replayed") is None
    loan = created.json()["data"]
    assert set(loan) == LOAN_FIELDS
    assert loan["status"] == "pending"
    assert loan["tool_id"] == tool_id
    assert loan["tool_name"].startswith("Lendable")
    assert loan["owner_id"] == U_ALICE
    assert loan["borrower_id"] == U_BOB
    assert loan["requirement_id"] is None and loan["task_id"] is None
    assert loan["note"] == "For our neighbourhood clean-up."
    for field in ("accepted_at", "handed_over_at", "returned_at", "rejected_at", "cancelled_at"):
        assert loan[field] is None
    assert loan["created_at"].endswith("Z")
    loan_id = loan["id"]

    accepted = _act(client, alice_token, loan_id, "accept")
    assert accepted.status_code == 200, accepted.text
    loan = accepted.json()["data"]
    assert loan["status"] == "accepted"
    assert loan["accepted_at"] is not None
    assert loan["handed_over_at"] is None

    handed = _act(client, alice_token, loan_id, "hand-over")
    assert handed.status_code == 200, handed.text
    loan = handed.json()["data"]
    assert loan["status"] == "on_loan"
    assert loan["handed_over_at"] is not None

    returned = _act(client, alice_token, loan_id, "return")
    assert returned.status_code == 200, returned.text
    loan = returned.json()["data"]
    assert loan["status"] == "returned"
    assert loan["returned_at"] is not None

    # Timestamps never go backwards.
    assert loan["created_at"] <= loan["accepted_at"] <= loan["handed_over_at"] <= loan["returned_at"]

    # The loan is readable by both parties.
    for token in (alice_token, bob_token):
        resp = client.get(f"/api/v1/loans/{loan_id}", headers=_hdr(token))
        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "returned"


# --- state machine rules ------------------------------------------------------


@pytest.mark.parametrize(
    "target,actor,action",
    [
        ("pending", "owner", "return"),
        ("pending", "owner", "hand-over"),
        ("accepted", "owner", "reject"),
        ("on_loan", "owner", "accept"),
        ("on_loan", "owner", "reject"),
        ("on_loan", "borrower", "cancel"),  # already out: return flow only
        ("rejected", "owner", "accept"),
        ("rejected", "owner", "return"),
        ("cancelled", "owner", "accept"),
        ("cancelled", "owner", "hand-over"),
        ("returned", "owner", "accept"),
        ("returned", "owner", "hand-over"),
        ("returned", "borrower", "cancel"),
    ],
)
def test_invalid_transition_matrix(client, alice_token, bob_token, target, actor, action):
    loan_id = _reach(client, alice_token, bob_token, target)
    token = alice_token if actor == "owner" else bob_token
    resp = _act(client, token, loan_id, action)
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "INVALID_TRANSITION"


@pytest.mark.parametrize(
    "target,action",
    [
        ("pending", "accept"),
        ("pending", "reject"),
        ("pending", "hand-over"),
        ("pending", "return"),
        ("accepted", "hand-over"),
        ("accepted", "reject"),
        ("cancelled", "hand-over"),  # permission is checked before state
        ("on_loan", "return"),
        ("returned", "return"),  # permission beats the no-op rule
    ],
)
def test_borrower_cannot_run_owner_actions(client, alice_token, bob_token, target, action):
    loan_id = _reach(client, alice_token, bob_token, target)
    resp = _act(client, bob_token, loan_id, action)
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "FORBIDDEN"


def test_cancel_by_either_party(client, alice_token, bob_token):
    # Borrower cancels their own pending request.
    tool_id = _publish(client, alice_token)
    created = _request_loan(client, bob_token, tool_id)
    loan_id = created.json()["data"]["id"]
    cancelled = _act(client, bob_token, loan_id, "cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["data"]["status"] == "cancelled"
    assert cancelled.json()["data"]["cancelled_at"] is not None

    # Owner cancels an accepted booking.
    loan_id = _reach(client, alice_token, bob_token, "accepted")
    cancelled = _act(client, alice_token, loan_id, "cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["data"]["status"] == "cancelled"

    # Tool is free again: availability flips back to available.
    detail = client.get(f"/api/v1/tools/{tool_id}", headers=_hdr(alice_token))
    assert detail.json()["data"]["availability"] == "available"


def test_return_noop_keeps_timestamps_and_events(client, alice_token, bob_token, settings):
    loan_id = _reach(client, alice_token, bob_token, "returned")
    before = client.get(f"/api/v1/loans/{loan_id}", headers=_hdr(alice_token)).json()["data"]
    events_before = _fetch(
        settings, "SELECT id FROM loan_events WHERE loan_id = ?", (loan_id,)
    )

    # New key, same intent: 200 no-op — owner-only permission still applies.
    again = _act(client, alice_token, loan_id, "return")
    assert again.status_code == 200
    after = again.json()["data"]
    assert after == before
    assert after["returned_at"] == before["returned_at"]
    events_after = _fetch(
        settings, "SELECT id FROM loan_events WHERE loan_id = ?", (loan_id,)
    )
    assert len(events_after) == len(events_before)

    # ...and the borrower still may not "confirm" the return, even as a no-op.
    denied = _act(client, bob_token, loan_id, "return")
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "FORBIDDEN"


def test_borrow_own_tool_forbidden(client, alice_token):
    resp = _request_loan(client, alice_token, T_WATERING)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "SELF_BORROW_FORBIDDEN"


def _create_task(client, token, template_id="flowerbed_care"):
    resp = client.post(
        "/api/v1/tasks",
        json={"template_id": template_id},
        headers={**_hdr(token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


def test_lend_own_tool_to_own_requirement(client, alice_token, bob_token):
    """The organiser may lend their own registered tool to a requirement of
    their own open action — the same loan record, state machine and tool
    reservation as borrowing from a neighbour. A bare self-borrow stays 403
    and a stranger's requirement stays invisible."""
    task = _create_task(client, alice_token)
    watering = next(
        r for r in task["requirements"] if r["category"] == "watering_can"
    )

    resp = _request_loan(client, alice_token, T_WATERING, requirement_id=watering["id"])
    assert resp.status_code == 201, resp.text
    loan = resp.json()["data"]
    assert set(loan) == LOAN_FIELDS
    assert loan["owner_id"] == U_ALICE
    assert loan["borrower_id"] == U_ALICE, "a self-lend names the owner twice"
    assert loan["requirement_id"] == watering["id"]
    assert loan["task_id"] == task["id"]
    assert loan["status"] == "pending"

    # The requirement is claimed and the tool reserved, exactly like a borrow.
    detail = client.get(
        f"/api/v1/tasks/{task['id']}", headers=_hdr(alice_token)
    ).json()["data"]
    row = next(r for r in detail["requirements"] if r["category"] == "watering_can")
    assert row["state"] == "pending"
    assert row["active_loan_id"] == loan["id"]
    tools = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(alice_token)
    ).json()["data"]
    assert next(t for t in tools if t["id"] == T_WATERING)["availability"] == "reserved"

    # Somebody else's requirement does not unlock the self-lend: the tool
    # owner cannot claim a requirement they do not organise (404, spec 4.2).
    bob_task = _create_task(client, bob_token)
    bob_watering = next(
        r for r in bob_task["requirements"] if r["category"] == "watering_can"
    )
    denied = _request_loan(client, alice_token, T_WATERING, requirement_id=bob_watering["id"])
    assert denied.status_code == 404
    assert denied.json()["error"]["code"] == "NOT_FOUND"

    # The owner drives their own loan through the frozen state machine.
    for action in ("accept", "hand-over", "return"):
        moved = _act(client, alice_token, loan["id"], action)
        assert moved.status_code == 200, moved.text
    done = _act(client, alice_token, loan["id"], "accept")
    assert done.status_code == 409
    assert done.json()["error"]["code"] == "INVALID_TRANSITION"
    detail = client.get(
        f"/api/v1/tasks/{task['id']}", headers=_hdr(alice_token)
    ).json()["data"]
    row = next(r for r in detail["requirements"] if r["category"] == "watering_can")
    assert row["state"] == "fulfilled"
    tools = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(alice_token)
    ).json()["data"]
    assert next(t for t in tools if t["id"] == T_WATERING)["availability"] == "available"

    # A returned self-lend is part of the owner's history on both sides.
    lent = client.get("/api/v1/loans?role=owner", headers=_hdr(alice_token)).json()["data"]
    borrowed = client.get("/api/v1/loans?role=borrower", headers=_hdr(alice_token)).json()["data"]
    assert [l["id"] for l in lent] == [loan["id"]]
    assert [l["id"] for l in borrowed] == [loan["id"]]


def test_self_lend_needs_an_own_requirement(client, alice_token, bob_token):
    """Without an own requirement, lending your own tool is still borrowing
    your own tool (403) — and another organiser's requirement does not unlock
    it either (404, spec 4.2)."""
    idle = _publish(client, alice_token, category="watering_can")
    resp = _request_loan(client, alice_token, T_WATERING)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "SELF_BORROW_FORBIDDEN"
    resp = _request_loan(client, alice_token, idle)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "SELF_BORROW_FORBIDDEN"

    bob_task = _create_task(client, bob_token)
    bob_watering = next(
        r for r in bob_task["requirements"] if r["category"] == "watering_can"
    )
    resp = _request_loan(client, alice_token, idle, requirement_id=bob_watering["id"])
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"

    # An unknown requirement id cannot smuggle a self-borrow in either.
    resp = _request_loan(client, alice_token, idle, requirement_id="no-such-requirement")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_borrow_archived_tool(client, alice_token, bob_token):
    tool_id = _publish(client, alice_token)
    archived = client.post(
        f"/api/v1/tools/{tool_id}/archive",
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert archived.status_code == 200
    resp = _request_loan(client, bob_token, tool_id)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "TOOL_ARCHIVED"


def test_second_borrower_gets_tool_unavailable(client, alice_token, bob_token, carol_token):
    tool_id = _publish(client, alice_token)
    first = _request_loan(client, bob_token, tool_id)
    assert first.status_code == 201
    second = _request_loan(client, carol_token, tool_id)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "TOOL_UNAVAILABLE"


def test_out_of_range_borrow_rejected(client, alice_token, bob_token, settings):
    """A tool in EH16 5AA (~2271 m from the borrowers' EH8 9AB home) is
    outside the 2000 m rule regardless of what the client claims."""
    far_tool = str(uuid.uuid4())
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category,"
            " description, is_archived, created_at, updated_at)"
            " VALUES (?, ?, ?, 'Far trowel', 'hand_trowel', '', 0, ?, ?)",
            (far_tool, U_ALICE, C_EH16, utc_now(), utc_now()),
        )
    finally:
        conn.close()

    resp = _request_loan(client, bob_token, far_tool)
    assert resp.status_code == 422, resp.text
    err = resp.json()["error"]
    assert err["code"] == "OUT_OF_RANGE"
    assert err["details"]["distance_m"] > 2000
    assert 2200 < err["details"]["distance_m"] < 2400  # ~2271 m fixture pair


# --- third-party access ---------------------------------------------------------


def test_third_party_gets_404_everywhere(client, alice_token, bob_token, carol_token):
    tool_id = _publish(client, alice_token)
    created = _request_loan(client, bob_token, tool_id)
    loan_id = created.json()["data"]["id"]

    # Reads: strangers cannot even confirm the loan exists.
    detail = client.get(f"/api/v1/loans/{loan_id}", headers=_hdr(carol_token))
    assert detail.status_code == 404
    assert detail.json()["error"]["code"] == "NOT_FOUND"
    events = client.get(f"/api/v1/loans/{loan_id}/events", headers=_hdr(carol_token))
    assert events.status_code == 404

    # Writes: every action on an invisible loan is 404, never a payload.
    for action in ("accept", "reject", "cancel", "hand-over", "return"):
        resp = _act(client, carol_token, loan_id, action)
        assert resp.status_code == 404, action
        assert resp.json()["error"]["code"] == "NOT_FOUND"

    # Carol's role-scoped lists never contain the loan.
    for role in ("borrower", "owner"):
        resp = client.get(
            "/api/v1/loans", params={"role": role}, headers=_hdr(carol_token)
        )
        assert resp.status_code == 200
        assert loan_id not in [item["id"] for item in resp.json()["data"]]


def test_unknown_loan_ids_404(client, alice_token):
    ghost = str(uuid.uuid4())
    assert client.get(f"/api/v1/loans/{ghost}", headers=_hdr(alice_token)).status_code == 404
    assert (
        client.get(f"/api/v1/loans/{ghost}/events", headers=_hdr(alice_token)).status_code
        == 404
    )
    resp = _act(client, alice_token, ghost, "accept")
    assert resp.status_code == 404


def test_loans_require_authentication(client, alice_token):
    tool_id = str(uuid.uuid4())
    assert client.post("/api/v1/loans", json={"tool_id": tool_id}).status_code == 401
    bare = client.get("/api/v1/loans")
    assert bare.status_code == 401  # bare + anonymous (spec 8.5)
    assert bare.json()["error"]["code"] == "UNAUTHENTICATED"
    assert client.get("/api/v1/loans", params={"role": "owner"}).status_code == 401


# --- request validation ---------------------------------------------------------


def test_note_and_body_validation(client, alice_token, bob_token):
    tool_id = _publish(client, alice_token)

    too_long = _request_loan(client, bob_token, tool_id, note="n" * 301)
    assert too_long.status_code == 422

    wrong_type = _request_loan(client, bob_token, tool_id, note=123)
    assert wrong_type.status_code == 422

    exactly_300 = _request_loan(client, bob_token, tool_id, note="n" * 300)
    assert exactly_300.status_code == 201, exactly_300.text
    assert exactly_300.json()["data"]["note"] == "n" * 300

    # Forgery attempts are rejected before any business logic runs.
    for extra in (
        {"borrower_id": U_CAROL},
        {"status": "accepted"},
        {"owner_id": U_ALICE},
    ):
        resp = client.post(
            "/api/v1/loans",
            json={"tool_id": tool_id, **extra},
            headers={**_hdr(bob_token), "Idempotency-Key": new_idem_key()},
        )
        assert resp.status_code == 422, extra
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    missing = client.post(
        "/api/v1/loans",
        json={"note": "no tool"},
        headers={**_hdr(bob_token), "Idempotency-Key": new_idem_key()},
    )
    assert missing.status_code == 422

    malformed = _request_loan(client, bob_token, "not a uuid!!")
    assert malformed.status_code == 422

    unknown = _request_loan(client, bob_token, str(uuid.uuid4()))
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "NOT_FOUND"


def test_idempotency_key_required_for_writes(client, alice_token, bob_token):
    tool_id = _publish(client, alice_token)
    no_key = client.post("/api/v1/loans", json={"tool_id": tool_id}, headers=_hdr(bob_token))
    assert no_key.status_code == 400
    assert no_key.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"

    bad_key = client.post(
        "/api/v1/loans",
        json={"tool_id": tool_id},
        headers={**_hdr(bob_token), "Idempotency-Key": "nope"},
    )
    assert bad_key.status_code == 400
    assert bad_key.json()["error"]["code"] == "IDEMPOTENCY_KEY_INVALID"

    created = _request_loan(client, bob_token, tool_id)
    loan_id = created.json()["data"]["id"]
    no_key_action = client.post(
        f"/api/v1/loans/{loan_id}/accept", headers=_hdr(alice_token)
    )
    assert no_key_action.status_code == 400
    assert no_key_action.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_create_replay_does_not_duplicate_loan_or_events(
    client, alice_token, bob_token, settings
):
    tool_id = _publish(client, alice_token)
    key = new_idem_key()
    body = {"tool_id": tool_id, "requirement_id": None, "note": "Replay me"}

    first = client.post(
        "/api/v1/loans",
        json=body,
        headers={**_hdr(bob_token), "Idempotency-Key": key},
    )
    assert first.status_code == 201, first.text
    loan_id = first.json()["data"]["id"]

    second = client.post(
        "/api/v1/loans",
        json=body,
        headers={**_hdr(bob_token), "Idempotency-Key": key},
    )
    assert second.status_code == 201
    assert second.headers.get("Idempotency-Replayed") == "true"
    assert second.json()["data"] == first.json()["data"]
    assert second.json()["meta"]["request_id"]  # fresh request id on replay

    loans = _fetch(settings, "SELECT id FROM loans WHERE tool_id = ?", (tool_id,))
    assert len(loans) == 1
    events = _fetch(settings, "SELECT id FROM loan_events WHERE loan_id = ?", (loan_id,))
    assert len(events) == 1

    # Same key, different fingerprint -> conflict, nothing written.
    conflict = client.post(
        "/api/v1/loans",
        json={"tool_id": tool_id, "note": "Different intent"},
        headers={**_hdr(bob_token), "Idempotency-Key": key},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert len(_fetch(settings, "SELECT id FROM loans WHERE tool_id = ?", (tool_id,))) == 1


def test_transition_replay_returns_original_without_new_event(
    client, alice_token, bob_token, settings
):
    tool_id = _publish(client, alice_token)
    loan_id = _request_loan(client, bob_token, tool_id).json()["data"]["id"]
    key = new_idem_key()

    first = _act(client, alice_token, loan_id, "accept", key=key)
    assert first.status_code == 200
    second = _act(client, alice_token, loan_id, "accept", key=key)
    assert second.status_code == 200
    assert second.headers.get("Idempotency-Replayed") == "true"
    assert second.json()["data"] == first.json()["data"]

    events = _fetch(settings, "SELECT action FROM loan_events WHERE loan_id = ?", (loan_id,))
    assert [e["action"] for e in events] == ["created", "accepted"]


# --- listing -------------------------------------------------------------------


def test_list_loans_roles_status_and_meta(client, alice_token, bob_token, carol_token):
    tool_id = _publish(client, alice_token)
    created = _request_loan(client, bob_token, tool_id)
    loan_id = created.json()["data"]["id"]
    for action, token in (
        ("accept", alice_token),
        ("hand-over", alice_token),
        ("return", alice_token),
    ):
        assert _act(client, token, loan_id, action).status_code == 200

    # Default role is borrower.
    as_borrower = client.get("/api/v1/loans", headers=_hdr(bob_token))
    assert as_borrower.status_code == 200
    body = as_borrower.json()
    assert body["meta"]["request_id"] and body["meta"]["total"] == 1
    assert body["meta"]["limit"] == 20 and body["meta"]["offset"] == 0
    assert [item["id"] for item in body["data"]] == [loan_id]
    assert set(body["data"][0]) == LOAN_FIELDS

    # Owner view for alice; she borrowed nothing herself.
    as_owner = client.get(
        "/api/v1/loans", params={"role": "owner"}, headers=_hdr(alice_token)
    )
    assert [item["id"] for item in as_owner.json()["data"]] == [loan_id]
    as_borrower_alice = client.get("/api/v1/loans", headers=_hdr(alice_token))
    assert as_borrower_alice.json()["data"] == []

    # Status filter.
    returned = client.get(
        "/api/v1/loans", params={"status": "returned"}, headers=_hdr(bob_token)
    )
    assert [item["id"] for item in returned.json()["data"]] == [loan_id]
    pending = client.get(
        "/api/v1/loans", params={"status": "pending"}, headers=_hdr(bob_token)
    )
    assert pending.json()["data"] == []
    assert pending.json()["meta"]["total"] == 0

    # Pagination.
    page = client.get(
        "/api/v1/loans",
        params={"limit": 1, "offset": 1},
        headers=_hdr(bob_token),
    )
    assert page.json()["data"] == []
    assert page.json()["meta"]["total"] == 1

    # Invalid enums -> 422.
    assert (
        client.get("/api/v1/loans", params={"role": "lender"}, headers=_hdr(bob_token)).status_code
        == 422
    )
    assert (
        client.get(
            "/api/v1/loans", params={"status": "lost"}, headers=_hdr(bob_token)
        ).status_code
        == 422
    )

    # Carol has no loans in either role.
    for role in ("borrower", "owner"):
        resp = client.get(
            "/api/v1/loans", params={"role": role}, headers=_hdr(carol_token)
        )
        assert resp.json()["data"] == []
        assert resp.json()["meta"]["total"] == 0


# --- events ----------------------------------------------------------------------


def test_event_stream_order_and_fields(client, alice_token, bob_token, carol_token, settings):
    tool_id = _publish(client, alice_token, category="watering_can")
    loan_id = _request_loan(client, bob_token, tool_id).json()["data"]["id"]
    assert _act(client, alice_token, loan_id, "accept").status_code == 200
    assert _act(client, alice_token, loan_id, "hand-over").status_code == 200
    assert _act(client, alice_token, loan_id, "return").status_code == 200

    resp = client.get(f"/api/v1/loans/{loan_id}/events", headers=_hdr(bob_token))
    assert resp.status_code == 200, resp.text
    events = resp.json()["data"]
    assert resp.json()["meta"]["total"] == 4
    assert [e["action"] for e in events] == [
        "created", "accepted", "handed_over", "returned",
    ]
    assert [(e["from_status"], e["to_status"]) for e in events] == [
        (None, "pending"),
        ("pending", "accepted"),
        ("accepted", "on_loan"),
        ("on_loan", "returned"),
    ]
    assert events[0]["actor_id"] == U_BOB  # borrower created it
    assert all(e["actor_id"] == U_ALICE for e in events[1:])  # owner drove it
    for event in events:
        assert set(event) == EVENT_FIELDS
        assert event["loan_id"] == loan_id
        assert event["created_at"].endswith("Z")
    stamps = [e["created_at"] for e in events]
    assert stamps == sorted(stamps)

    # Pagination.
    page = client.get(
        f"/api/v1/loans/{loan_id}/events",
        params={"limit": 2, "offset": 2},
        headers=_hdr(alice_token),
    )
    assert page.status_code == 200
    assert [e["action"] for e in page.json()["data"]] == ["handed_over", "returned"]
    assert page.json()["meta"]["total"] == 4

    # Rejected loans record their event too.
    rejected_id = _reach(client, alice_token, bob_token, "rejected")
    rejected_events = client.get(
        f"/api/v1/loans/{rejected_id}/events", headers=_hdr(alice_token)
    ).json()["data"]
    assert [e["action"] for e in rejected_events] == ["created", "rejected"]
    assert rejected_events[-1]["to_status"] == "rejected"

    # Stranger still cannot read events.
    assert (
        client.get(f"/api/v1/loans/{loan_id}/events", headers=_hdr(carol_token)).status_code
        == 404
    )


# --- requirement-linked loans (spec 6.2) ------------------------------------------


def test_requirement_linkage_and_task_id(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_BOB)
    _insert_requirement(
        settings, requirement_id=requirement_id, task_id=task_id, category="litter_picker"
    )

    tool_id = _publish(client, alice_token, category="litter_picker")
    resp = _request_loan(
        client, bob_token, tool_id, requirement_id=requirement_id, note="for the task"
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()["data"]
    assert data["requirement_id"] == requirement_id
    assert data["task_id"] == task_id
    assert data["status"] == "pending"


def test_requirement_category_mismatch(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_BOB)
    _insert_requirement(
        settings, requirement_id=requirement_id, task_id=task_id, category="litter_picker"
    )

    # Alice's seed watering can does not match a litter_picker requirement.
    resp = _request_loan(
        client, bob_token, T_WATERING, requirement_id=requirement_id
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "CATEGORY_MISMATCH"


def test_requirement_must_belong_to_borrower(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_ALICE)  # not bob's task
    _insert_requirement(
        settings, requirement_id=requirement_id, task_id=task_id, category="litter_picker"
    )
    tool_id = _publish(client, alice_token)
    resp = _request_loan(client, bob_token, tool_id, requirement_id=requirement_id)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_requirement_unknown_id(client, alice_token, bob_token):
    tool_id = _publish(client, alice_token)
    resp = _request_loan(
        client, bob_token, tool_id, requirement_id=str(uuid.uuid4())
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_requirement_on_completed_task(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_BOB, status="completed")
    _insert_requirement(
        settings, requirement_id=requirement_id, task_id=task_id, category="litter_picker"
    )
    tool_id = _publish(client, alice_token)
    resp = _request_loan(client, bob_token, tool_id, requirement_id=requirement_id)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "TASK_ALREADY_COMPLETED"


def test_requirement_self_supplied_locked(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_BOB)
    _insert_requirement(
        settings,
        requirement_id=requirement_id,
        task_id=task_id,
        category="litter_picker",
        self_supplied=1,
    )
    tool_id = _publish(client, alice_token)
    resp = _request_loan(client, bob_token, tool_id, requirement_id=requirement_id)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "REQUIREMENT_LOCKED"


def test_requirement_occupied_by_active_loan(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_BOB)
    _insert_requirement(
        settings, requirement_id=requirement_id, task_id=task_id, category="litter_picker"
    )
    tool_a = _publish(client, alice_token)
    tool_b = _publish(client, alice_token)

    first = _request_loan(client, bob_token, tool_a, requirement_id=requirement_id)
    assert first.status_code == 201, first.text

    second = _request_loan(client, bob_token, tool_b, requirement_id=requirement_id)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "REQUIREMENT_OCCUPIED"


def test_requirement_already_fulfilled(client, alice_token, bob_token, settings):
    task_id, requirement_id = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=task_id, creator_id=U_BOB)
    _insert_requirement(
        settings, requirement_id=requirement_id, task_id=task_id, category="litter_picker"
    )
    tool_id = _publish(client, alice_token)

    loan_id = _request_loan(
        client, bob_token, tool_id, requirement_id=requirement_id
    ).json()["data"]["id"]
    for action in ("accept", "hand-over", "return"):
        assert _act(client, alice_token, loan_id, action).status_code == 200

    # History exists (handed_over_at set) -> no second loan for this need.
    retry = _request_loan(client, bob_token, tool_id, requirement_id=requirement_id)
    assert retry.status_code == 409
    assert retry.json()["error"]["code"] == "REQUIREMENT_ALREADY_FULFILLED"

    # A rejected loan releases the requirement (no hand-over happened).
    other_task, other_req = str(uuid.uuid4()), str(uuid.uuid4())
    _insert_task(settings, task_id=other_task, creator_id=U_BOB)
    _insert_requirement(
        settings, requirement_id=other_req, task_id=other_task, category="hand_trowel"
    )
    trowel = _publish(client, alice_token, category="hand_trowel")
    l1 = _request_loan(client, bob_token, trowel, requirement_id=other_req)
    assert l1.status_code == 201
    assert _act(client, alice_token, l1.json()["data"]["id"], "reject").status_code == 200
    l2 = _request_loan(client, bob_token, trowel, requirement_id=other_req)
    assert l2.status_code == 201, l2.text  # released, reusable
