"""Contract tests for the tools endpoints (spec 4.2 / 4.3 / 5.3 / 8.2 / 8.3)."""

from __future__ import annotations

import sqlite3
import uuid

from app.db import utc_now
from tests.conftest import auth_headers, new_idem_key

# Fixture communities (seed): EH8 9AB is every demo user's home community;
# EH16 5AA sits ~2.27 km away and is used for the 2000 m boundary.
C_EH8 = "c1111111-1111-4111-8111-111111111111"
C_EH16 = "c2222222-2222-4222-8222-222222222222"

T_WATERING = "t1111111-1111-4111-8111-111111111111"  # alice, watering_can
T_TROWEL = "t2222222-2222-4222-8222-222222222222"  # alice, hand_trowel
T_GLOVES = "t3333333-3333-4333-8333-333333333333"  # bob, reusable_gloves

U_ALICE = "u1111111-1111-4111-8111-111111111111"


# --- helpers ----------------------------------------------------------------


def _hdr(token: str) -> dict[str, str]:
    return auth_headers("any", token)


def _create_tool(client, token, *, name, category, description=""):
    resp = client.post(
        "/api/v1/tools",
        json={"name": name, "category": category, "description": description},
        headers={**_hdr(token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


def _act(client, token, loan_id, action):
    """POST one of the empty-body state machine endpoints."""
    return client.post(
        f"/api/v1/loans/{loan_id}/{action}",
        headers={**_hdr(token), "Idempotency-Key": new_idem_key()},
    )


def _request_loan(client, token, tool_id, **body):
    return client.post(
        "/api/v1/loans",
        json={"tool_id": tool_id, **body},
        headers={**_hdr(token), "Idempotency-Key": new_idem_key()},
    )


def _insert_tool_row(settings, *, tool_id, owner_id, community_id, category):
    """Minimal tools row via SQL (bypasses the API so the tool can live in a
    community the owner does not belong to — distance tests need that)."""
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        now = utc_now()
        conn.execute(
            "INSERT INTO tools (id, owner_id, community_id, name, category,"
            " description, is_archived, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)",
            (tool_id, owner_id, community_id, f"SQL {category}", category, now, now),
        )
    finally:
        conn.close()


def _delete_tool(settings, tool_id):
    conn = sqlite3.connect(settings.database_path, isolation_level=None)
    try:
        conn.execute("DELETE FROM tools WHERE id = ?", (tool_id,))
    finally:
        conn.close()


def _fetch(settings, sql, params=()):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


# --- GET /tools: listing ------------------------------------------------------


def test_list_requires_auth_for_selector_request(client):
    """With a query but no token: 401, not a payload."""
    resp = client.get("/api/v1/tools", params={"community_id": C_EH8})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


def test_list_requires_community_id(client, alice_token):
    resp = client.get("/api/v1/tools", headers=_hdr(alice_token))
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "VALIDATION_ERROR"
    assert any("community_id" in f["field"] for f in err["details"]["fields"])


def test_list_returns_seed_tools_with_meta(client, alice_token):
    resp = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(alice_token)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"data", "meta"}
    meta = body["meta"]
    assert meta["request_id"]
    assert meta["limit"] == 20 and meta["offset"] == 0
    assert meta["total"] == 3

    ids = [t["id"] for t in body["data"]]
    assert ids == [T_WATERING, T_TROWEL, T_GLOVES]  # stable sort, seed order

    first = body["data"][0]
    assert set(first) == {
        "id", "name", "category", "description", "owner", "community",
        "availability", "is_archived", "distance_m", "created_at", "updated_at",
    }
    assert first["owner"] == {"id": U_ALICE, "display_name": "Alice"}
    assert first["community"]["postcode"] == "EH8 9AB"
    assert first["availability"] == "available"
    assert first["is_archived"] is False
    # Same community as the reference -> computed distance 0.0 (not null).
    assert first["distance_m"] == 0.0
    assert first["created_at"].endswith("Z")


def test_list_shows_other_peoples_tools(client, bob_token, carol_token):
    """Bystanders see tools they do not own — with owner nicknames only."""
    resp = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(bob_token)
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    alice_tools = [t for t in data if t["owner"]["id"] == U_ALICE]
    assert len(alice_tools) == 2
    for tool in data:
        assert set(tool["owner"]) == {"id", "display_name"}  # no token/contacts

    resp = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(carol_token)
    )
    assert resp.status_code == 200
    assert resp.json()["meta"]["total"] == 3


def test_list_category_filter(client, alice_token):
    resp = client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "category": "watering_can"},
        headers=_hdr(alice_token),
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert [t["id"] for t in data] == [T_WATERING]
    assert resp.json()["meta"]["total"] == 1

    bad = client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "category": "power_drill"},
        headers=_hdr(alice_token),
    )
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "VALIDATION_ERROR"


def test_list_pagination(client, alice_token):
    page1 = client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "limit": 2, "offset": 0},
        headers=_hdr(alice_token),
    )
    page2 = client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "limit": 2, "offset": 2},
        headers=_hdr(alice_token),
    )
    assert page1.status_code == page2.status_code == 200
    assert len(page1.json()["data"]) == 2
    assert len(page2.json()["data"]) == 1
    assert page1.json()["meta"]["total"] == 3
    assert page2.json()["meta"]["total"] == 3
    combined = [t["id"] for t in page1.json()["data"] + page2.json()["data"]]
    assert combined == [T_WATERING, T_TROWEL, T_GLOVES]

    assert client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "limit": 0},
        headers=_hdr(alice_token),
    ).status_code == 422
    assert client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "limit": 101},
        headers=_hdr(alice_token),
    ).status_code == 422
    assert client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "offset": -1},
        headers=_hdr(alice_token),
    ).status_code == 422


def test_radius_boundaries(client, alice_token):
    # 100 m and 2000 m are the accepted edges.
    for radius in (100, 2000):
        resp = client.get(
            "/api/v1/tools",
            params={"community_id": C_EH8, "radius_m": radius},
            headers=_hdr(alice_token),
        )
        assert resp.status_code == 200, (radius, resp.text)
    # Outside 100-2000 -> 422 VALIDATION_ERROR.
    for radius in (99, 2001, 0):
        resp = client.get(
            "/api/v1/tools",
            params={"community_id": C_EH8, "radius_m": radius},
            headers=_hdr(alice_token),
        )
        assert resp.status_code == 422, radius
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_distance_filter_excludes_distant_community(client, alice_token, settings):
    """EH16 5AA is ~2271 m from EH8 9AB: with radius_m<=2000 no EH8 tool can
    show up in an EH16 query, and vice versa."""
    far_tool = str(uuid.uuid4())
    _insert_tool_row(
        settings,
        tool_id=far_tool,
        owner_id=U_ALICE,
        community_id=C_EH16,
        category="hand_trowel",
    )

    eh16 = client.get(
        "/api/v1/tools", params={"community_id": C_EH16}, headers=_hdr(alice_token)
    )
    assert eh16.status_code == 200
    assert [t["id"] for t in eh16.json()["data"]] == [far_tool]
    assert eh16.json()["data"][0]["distance_m"] == 0.0

    eh8 = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(alice_token)
    )
    assert eh8.status_code == 200
    assert far_tool not in [t["id"] for t in eh8.json()["data"]]
    assert eh8.json()["meta"]["total"] == 3

    # Without the far tool, an EH16 query over EH8 tools returns nothing
    # (all ~2271 m away, over the 2000 m default radius).
    _delete_tool(settings, far_tool)
    empty = client.get(
        "/api/v1/tools", params={"community_id": C_EH16}, headers=_hdr(alice_token)
    )
    assert empty.status_code == 200
    assert empty.json()["data"] == []
    assert empty.json()["meta"]["total"] == 0


def test_unknown_community_404(client, alice_token):
    resp = client.get(
        "/api/v1/tools",
        params={"community_id": str(uuid.uuid4())},
        headers=_hdr(alice_token),
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


# --- GET /tools/{id} ----------------------------------------------------------


def test_detail_fields_and_null_distance(client, alice_token):
    resp = client.get(f"/api/v1/tools/{T_WATERING}", headers=_hdr(alice_token))
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["id"] == T_WATERING
    assert data["category"] == "watering_can"
    assert data["owner"]["display_name"] == "Alice"
    assert data["community"]["outcode"] == "EH8"
    assert data["availability"] == "available"
    # No reference community on the detail route -> null, never 0 (spec 8.3).
    assert data["distance_m"] is None
    assert data["created_at"].endswith("Z")


def test_detail_unknown_tool_404(client, alice_token):
    resp = client.get(f"/api/v1/tools/{uuid.uuid4()}", headers=_hdr(alice_token))
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_detail_requires_auth(client):
    resp = client.get(f"/api/v1/tools/{T_WATERING}")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


# --- POST /tools --------------------------------------------------------------


def test_create_tool_201(client, alice_token):
    resp = client.post(
        "/api/v1/tools",
        json={
            "name": "Neighbourhood litter picker",
            "category": "litter_picker",
            "description": "Reusable picker for a local clean-up.",
        },
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 201, resp.text
    assert "Idempotency-Replayed" not in resp.headers
    data = resp.json()["data"]
    assert data["name"] == "Neighbourhood litter picker"
    assert data["category"] == "litter_picker"
    # Owner and community are server-side, from the session (spec 4.2).
    assert data["owner"] == {"id": U_ALICE, "display_name": "Alice"}
    assert data["community"]["id"] == C_EH8
    assert data["availability"] == "available"
    assert data["is_archived"] is False
    assert data["distance_m"] is None  # no reference community
    assert data["created_at"] == data["updated_at"]
    assert resp.json()["meta"]["request_id"]

    # It is listed under the owner's home community.
    listed = client.get(
        "/api/v1/tools", params={"community_id": C_EH8}, headers=_hdr(alice_token)
    )
    assert data["id"] in [t["id"] for t in listed.json()["data"]]
    assert listed.json()["meta"]["total"] == 4


def test_create_tool_requires_idempotency_key(client, alice_token):
    body = {"name": "Spade", "category": "hand_trowel"}
    missing = client.post("/api/v1/tools", json=body, headers=_hdr(alice_token))
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"

    bad = client.post(
        "/api/v1/tools",
        json=body,
        headers={**_hdr(alice_token), "Idempotency-Key": "not-a-uuid"},
    )
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "IDEMPOTENCY_KEY_INVALID"


def test_create_tool_rejects_unknown_fields(client, alice_token):
    """owner_id/status in the body are forgeries, not inputs (spec 4.2)."""
    for extra in (
        {"owner_id": "u3333333-3333-4333-8333-333333333333"},
        {"status": "available"},
        {"is_archived": True},
        {"community_id": C_EH16},
    ):
        resp = client.post(
            "/api/v1/tools",
            json={"name": "Spade", "category": "hand_trowel", **extra},
            headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
        )
        assert resp.status_code == 422, extra
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_create_tool_field_bounds(client, alice_token):
    too_long = client.post(
        "/api/v1/tools",
        json={"name": "x" * 81, "category": "hand_trowel"},
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert too_long.status_code == 422

    empty_name = client.post(
        "/api/v1/tools",
        json={"name": "", "category": "hand_trowel"},
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert empty_name.status_code == 422

    long_description = client.post(
        "/api/v1/tools",
        json={"name": "Spade", "category": "hand_trowel", "description": "d" * 501},
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert long_description.status_code == 422

    ok = client.post(
        "/api/v1/tools",
        json={"name": "d" * 80, "category": "hand_trowel", "description": "d" * 500},
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert ok.status_code == 201, ok.text


def test_create_tool_idempotent_replay(client, alice_token, settings):
    key = new_idem_key()
    body = {"name": "Shared ladder", "category": "hand_trowel", "description": ""}
    first = client.post(
        "/api/v1/tools",
        json=body,
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert first.status_code == 201

    second = client.post(
        "/api/v1/tools",
        json=body,
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert second.status_code == 201
    assert second.headers.get("Idempotency-Replayed") == "true"
    assert second.json()["data"] == first.json()["data"]
    # No duplicate row was created.
    rows = _fetch(settings, "SELECT id FROM tools WHERE name = ?", (body["name"],))
    assert len(rows) == 1

    # Same key + different body -> 409, original data untouched.
    conflict = client.post(
        "/api/v1/tools",
        json={"name": "Different ladder", "category": "hand_trowel"},
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_create_tool_key_reuse_across_paths(client, alice_token):
    """A key is bound to method+path+body; reusing it elsewhere is a conflict."""
    key = new_idem_key()
    created = client.post(
        "/api/v1/tools",
        json={"name": "Bucket", "category": "watering_can"},
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert created.status_code == 201
    other_path = client.post(
        "/api/v1/tools/{tool_id}/archive".format(tool_id=T_TROWEL),
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert other_path.status_code == 409
    assert other_path.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


# --- POST /tools/{id}/archive -------------------------------------------------


def test_archive_by_owner(client, alice_token):
    resp = client.post(
        f"/api/v1/tools/{T_TROWEL}/archive",
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["is_archived"] is True
    assert data["availability"] == "archived"

    # Archived tools stay readable (spec 8.2).
    detail = client.get(f"/api/v1/tools/{T_TROWEL}", headers=_hdr(alice_token))
    assert detail.status_code == 200
    assert detail.json()["data"]["availability"] == "archived"


def test_archive_requires_owner(client, bob_token, carol_token):
    resp = client.post(
        f"/api/v1/tools/{T_WATERING}/archive",
        headers={**_hdr(bob_token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "FORBIDDEN"

    # Unarchived still — carol gets the same answer, not a silent success.
    detail = client.get(f"/api/v1/tools/{T_WATERING}", headers=_hdr(bob_token))
    assert detail.json()["data"]["is_archived"] is False


def test_archive_unknown_tool_404(client, alice_token):
    resp = client.post(
        f"/api/v1/tools/{uuid.uuid4()}/archive",
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_archive_rejected_while_active_loan_exists(client, alice_token, bob_token):
    # Alice borrows bob's gloves -> bob (owner) cannot archive while pending.
    loan = _request_loan(client, alice_token, T_GLOVES)
    assert loan.status_code == 201, loan.text

    resp = client.post(
        f"/api/v1/tools/{T_GLOVES}/archive",
        headers={**_hdr(bob_token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ACTIVE_LOAN_EXISTS"

    # After the loan is rejected the archive succeeds.
    rejected = _act(client, bob_token, loan.json()["data"]["id"], "reject")
    assert rejected.status_code == 200
    ok = client.post(
        f"/api/v1/tools/{T_GLOVES}/archive",
        headers={**_hdr(bob_token), "Idempotency-Key": new_idem_key()},
    )
    assert ok.status_code == 200
    assert ok.json()["data"]["is_archived"] is True


def test_archive_requires_idempotency_key(client, alice_token):
    resp = client.post(f"/api/v1/tools/{T_TROWEL}/archive", headers=_hdr(alice_token))
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_archive_replay_and_noop(client, alice_token):
    key = new_idem_key()
    first = client.post(
        f"/api/v1/tools/{T_TROWEL}/archive",
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert first.status_code == 200
    first_data = first.json()["data"]

    # Same key -> replay of the original response.
    replay = client.post(
        f"/api/v1/tools/{T_TROWEL}/archive",
        headers={**_hdr(alice_token), "Idempotency-Key": key},
    )
    assert replay.status_code == 200
    assert replay.headers.get("Idempotency-Replayed") == "true"
    assert replay.json()["data"] == first_data

    # New key on an already-archived tool -> 200 no-op, updated_at untouched.
    noop = client.post(
        f"/api/v1/tools/{T_TROWEL}/archive",
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert noop.status_code == 200
    assert noop.json()["data"] == first_data
    assert noop.json()["data"]["updated_at"] == first_data["updated_at"]


def test_archive_rejects_body_fields(client, alice_token):
    """Archive takes an empty body; forged fields do not slip through."""
    resp = client.post(
        f"/api/v1/tools/{T_TROWEL}/archive",
        json={"is_archived": False},
        headers={**_hdr(alice_token), "Idempotency-Key": new_idem_key()},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- availability (spec 5.3) ---------------------------------------------------


def test_availability_four_states(client, alice_token, bob_token):
    """available -> reserved -> on_loan -> available -> archived, computed
    from loans + is_archived only (no stored tool.status)."""

    def detail(token):
        resp = client.get(f"/api/v1/tools/{T_GLOVES}", headers=_hdr(token))
        assert resp.status_code == 200
        return resp.json()["data"]["availability"]

    assert detail(alice_token) == "available"

    loan = _request_loan(client, alice_token, T_GLOVES)
    assert loan.status_code == 201
    assert detail(alice_token) == "reserved"
    loan_id = loan.json()["data"]["id"]

    # accepted is still "reserved" (not on loan yet).
    assert _act(client, bob_token, loan_id, "accept").status_code == 200
    assert detail(alice_token) == "reserved"

    assert _act(client, bob_token, loan_id, "hand-over").status_code == 200
    assert detail(alice_token) == "on_loan"

    assert _act(client, bob_token, loan_id, "return").status_code == 200
    assert detail(alice_token) == "available"

    archived = client.post(
        f"/api/v1/tools/{T_GLOVES}/archive",
        headers={**_hdr(bob_token), "Idempotency-Key": new_idem_key()},
    )
    assert archived.status_code == 200
    assert detail(alice_token) == "archived"


def test_availability_filter(client, alice_token, bob_token):
    loan = _request_loan(client, bob_token, T_WATERING)
    assert loan.status_code == 201

    def ids_for(availability):
        resp = client.get(
            "/api/v1/tools",
            params={
                "community_id": C_EH8,
                "availability": availability,
            },
            headers=_hdr(alice_token),
        )
        assert resp.status_code == 200, resp.text
        return [t["id"] for t in resp.json()["data"]]

    assert ids_for("available") == [T_TROWEL, T_GLOVES]
    assert ids_for("reserved") == [T_WATERING]
    assert ids_for("on_loan") == []
    assert ids_for("archived") == []

    bad = client.get(
        "/api/v1/tools",
        params={"community_id": C_EH8, "availability": "loaned_out"},
        headers=_hdr(alice_token),
    )
    assert bad.status_code == 422
