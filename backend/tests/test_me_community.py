"""Contract tests for POST /api/v1/me/community (the demo "move my street" write).

This endpoint is the only writer of users.community_id: it resolves the
postcode, points the caller's row at it and returns the GET /me shape. The
fixture postcodes used here (EH8 9AB / EH16 5AA / EH14 4AS) are all seeded
communities, so no test reaches the postcode upstream.
"""

from __future__ import annotations

import sqlite3

from tests.conftest import auth_headers, new_idem_key

HOME_COMMUNITY_ID = "c1111111-1111-4111-8111-111111111111"
EH16_COMMUNITY_ID = "c2222222-2222-4222-8222-222222222222"
EH14_COMMUNITY_ID = "c8888880-8888-4888-8888-888888888880"
ALICE_ID = "u1111111-1111-4111-8111-111111111111"


def _move(client, token, postcode, key=None):
    headers = auth_headers("alice", token)
    if key is not None:
        headers["Idempotency-Key"] = key
    return client.post(
        "/api/v1/me/community", json={"postcode": postcode}, headers=headers
    )


def _me(client, token):
    return client.get("/api/v1/me", headers=auth_headers("alice", token))


def _user_community(db_path, alias="alice") -> str:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT community_id FROM users WHERE alias = ?", (alias,)
        ).fetchone()
    return row[0]


def test_move_community_updates_user_and_me(client, alice_token, db_path):
    resp = _move(client, alice_token, "EH16 5AA", new_idem_key())
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["id"] == ALICE_ID
    assert data["display_name"] == "Alice"
    assert data["mode"] == "demo"
    assert data["community"]["id"] == EH16_COMMUNITY_ID
    assert data["community"]["postcode"] == "EH16 5AA"
    assert data["community"]["outcode"] == "EH16"
    assert resp.json()["meta"]["request_id"]

    assert _user_community(db_path) == EH16_COMMUNITY_ID

    me = _me(client, alice_token)
    assert me.status_code == 200, me.text
    assert me.json()["data"]["community"]["id"] == EH16_COMMUNITY_ID
    assert me.json()["data"]["community"]["postcode"] == "EH16 5AA"
    assert me.json()["data"]["community"]["outcode"] == "EH16"


def test_tool_created_after_move_belongs_to_new_community(client, alice_token, db_path):
    moved = _move(client, alice_token, "EH14 4AS", new_idem_key())
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"]["community"]["id"] == EH14_COMMUNITY_ID

    headers = auth_headers("alice", alice_token)
    headers["Idempotency-Key"] = new_idem_key()
    resp = client.post(
        "/api/v1/tools",
        json={
            "name": "Moved-street picker",
            "category": "litter_picker",
            "description": "Kept on the new street.",
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    tool = resp.json()["data"]
    assert tool["community"]["id"] == EH14_COMMUNITY_ID
    assert tool["community"]["postcode"] == "EH14 4AS"

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT community_id FROM tools WHERE id = ?", (tool["id"],)
        ).fetchone()
    assert row[0] == EH14_COMMUNITY_ID


def test_invalid_postcode_leaves_user_and_me_unchanged(client, alice_token, db_path):
    before = _me(client, alice_token).json()["data"]["community"]
    resp = _move(client, alice_token, "not a postcode", new_idem_key())
    assert resp.status_code == 422, resp.text
    assert resp.json()["error"]["code"] == "INVALID_POSTCODE"

    assert _user_community(db_path) == HOME_COMMUNITY_ID
    after = _me(client, alice_token).json()["data"]["community"]
    assert after["id"] == before["id"]
    assert after["postcode"] == "EH8 9AB"


def test_move_community_requires_idempotency_key(client, alice_token, db_path):
    resp = client.post(
        "/api/v1/me/community",
        json={"postcode": "EH16 5AA"},
        headers=auth_headers("alice", alice_token),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    assert _user_community(db_path) == HOME_COMMUNITY_ID


def test_move_community_requires_auth(client):
    resp = client.post("/api/v1/me/community", json={"postcode": "EH16 5AA"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"

    spoofed = client.post(
        "/api/v1/me/community",
        json={"postcode": "EH16 5AA"},
        headers={"X-User-Id": ALICE_ID},
    )
    assert spoofed.status_code == 401
    assert spoofed.json()["error"]["code"] == "UNAUTHENTICATED"


def test_repeated_key_replays_without_moving_again(client, alice_token, db_path):
    key = new_idem_key()
    first = _move(client, alice_token, "EH14 4AS", key)
    assert first.status_code == 200, first.text
    assert first.json()["data"]["community"]["postcode"] == "EH14 4AS"

    # Put the account back by hand: a genuine replay returns the recorded
    # response without re-running the UPDATE, so the row must stay at home.
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE users SET community_id = ? WHERE alias = 'alice'",
            (HOME_COMMUNITY_ID,),
        )

    replay = _move(client, alice_token, "EH14 4AS", key)
    assert replay.status_code == 200, replay.text
    assert replay.headers.get("Idempotency-Replayed") == "true"
    assert replay.json()["data"]["community"]["postcode"] == "EH14 4AS"
    assert _user_community(db_path) == HOME_COMMUNITY_ID


def test_same_key_new_postcode_is_conflict(client, alice_token, db_path):
    key = new_idem_key()
    assert _move(client, alice_token, "EH16 5AA", key).status_code == 200

    conflict = _move(client, alice_token, "EH14 4AS", key)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert _user_community(db_path) == EH16_COMMUNITY_ID
