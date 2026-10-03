"""Contract tests for health checks and demo authentication (spec 8.2 / 4.1)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import SettingsError, get_settings, reset_settings_cache
from tests.conftest import TEST_ACCESS_CODE, auth_headers, login


# --- Health -----------------------------------------------------------------


def test_health_live(client):
    resp = client.get("/health/live")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"]["status"] == "live"
    assert body["meta"]["request_id"]
    assert resp.headers["X-Request-Id"] == body["meta"]["request_id"]


def test_health_ready_ok(client):
    resp = client.get("/health/ready")
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "ready"


def test_health_ready_503_without_migrations(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "fresh.sqlite3"))
    monkeypatch.setenv("DEMO_ACCESS_CODE", TEST_ACCESS_CODE)
    reset_settings_cache()
    try:
        from app.main import create_app

        fresh_client = TestClient(create_app())
        resp = fresh_client.get("/health/ready")
        assert resp.status_code == 503
        payload = resp.json()
        assert payload["error"] if "error" in payload else payload["data"]
        # No file path / SQL leakage either way.
        text = resp.text
        assert str(tmp_path) not in text
        assert ".sqlite3" not in text
    finally:
        reset_settings_cache()


# --- Demo login --------------------------------------------------------------


def test_demo_login_success(client):
    resp = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "alice", "access_code": TEST_ACCESS_CODE},
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()["data"]
    assert data["token_type"] == "bearer"
    assert len(data["access_token"]) >= 43  # token_urlsafe(32)
    assert data["expires_at"].endswith("Z")
    assert data["user"]["alias"] == "alice"
    assert data["user"]["id"]
    assert data["user"]["display_name"] == "Alice"
    assert data["user"]["community_id"]
    assert resp.json()["meta"]["request_id"]


def test_demo_login_wrong_access_code(client):
    resp = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "alice", "access_code": "wrong-access-code-xxxx"},
    )
    assert resp.status_code == 401
    err = resp.json()["error"]
    assert err["code"] == "UNAUTHENTICATED"
    assert "wrong-access-code" not in resp.text


def test_demo_login_unknown_alias(client):
    resp = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "mallory", "access_code": TEST_ACCESS_CODE},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


def test_demo_login_extra_field_rejected(client):
    resp = client.post(
        "/api/v1/demo/sessions",
        json={
            "user_alias": "alice",
            "access_code": TEST_ACCESS_CODE,
            "user_id": "u1111111-1111-4111-8111-111111111111",
        },
    )
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "VALIDATION_ERROR"
    # field name is fine to echo, the secret value is not
    assert TEST_ACCESS_CODE not in resp.text


# --- Configuration gate ------------------------------------------------------


@pytest.mark.parametrize("bad_code", ["", "change-me", "placeholder", "short"])
def test_startup_fails_without_valid_access_code(bad_code, monkeypatch):
    monkeypatch.setenv("DEMO_ACCESS_CODE", bad_code)
    reset_settings_cache()
    with pytest.raises(SettingsError):
        get_settings()


def test_create_app_fails_on_placeholder_code(monkeypatch):
    monkeypatch.setenv("DEMO_ACCESS_CODE", "change-me")
    reset_settings_cache()
    try:
        from app.main import create_app

        with pytest.raises(SystemExit):
            create_app()
    finally:
        reset_settings_cache()


def test_production_mode_refuses_to_start(monkeypatch):
    monkeypatch.setenv("APP_MODE", "production")
    monkeypatch.setenv("DEMO_ACCESS_CODE", TEST_ACCESS_CODE)
    reset_settings_cache()
    with pytest.raises(SettingsError):
        get_settings()


# --- Session lifecycle --------------------------------------------------------


def test_logout_then_token_401(client):
    token = login(client, "alice")
    assert client.get("/api/v1/me", headers=auth_headers("alice", token)).status_code == 200

    resp = client.post("/api/v1/sessions/logout", headers=auth_headers("alice", token))
    assert resp.status_code == 200
    assert resp.json()["data"]["revoked"] is True

    after = client.get("/api/v1/me", headers=auth_headers("alice", token))
    assert after.status_code == 401
    assert after.json()["error"]["code"] == "UNAUTHENTICATED"


def test_me_without_token_401(client):
    resp = client.get("/api/v1/me")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


def test_me_rejects_x_user_id_spoofing(client):
    """X-User-Id must never act as an identity (spec 4.1)."""
    resp = client.get(
        "/api/v1/me",
        headers={"X-User-Id": "u1111111-1111-4111-8111-111111111111"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


def test_shell_route_has_no_data_for_spoofed_header(client):
    """Business routes never answer an unauthenticated caller (spec 8.5):
    a spoofed X-User-Id header, or no header at all, yields 401
    UNAUTHENTICATED and never a business payload."""
    spoofed = {"X-User-Id": "u1111111-1111-4111-8111-111111111111"}
    for path in ("/api/v1/tools", "/api/v1/loans", "/api/v1/tasks", "/api/v1/communities/resolve"):
        for label, headers in (("spoofed", spoofed), ("bare", {})):
            resp = client.get(path, headers=headers)
            assert resp.status_code == 401, f"{path} ({label}): {resp.text}"
            body = resp.json()
            assert body["error"]["code"] == "UNAUTHENTICATED", path
            assert "data" not in body, path
            assert "u1111111" not in resp.text, path


def test_me_success_payload(client, alice_token):
    resp = client.get("/api/v1/me", headers=auth_headers("alice", alice_token))
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["id"]
    assert data["display_name"] == "Alice"
    assert data["mode"] == "demo"
    community = data["community"]
    assert community["postcode"] == "EH8 9AB"
    assert community["outcode"] == "EH8"
    assert community["country"] == "Scotland"
    assert community["source_kind"] == "fixture"
    assert community["latitude"] == pytest.approx(55.944703)
    assert community["longitude"] == pytest.approx(-3.187417)


# --- Rate limiting ------------------------------------------------------------


def test_login_rate_limited_after_repeated_failures(client):
    """10 failures/minute from one address -> 429 on the next attempt."""
    for i in range(10):
        resp = client.post(
            "/api/v1/demo/sessions",
            json={"user_alias": "alice", "access_code": f"bad-code-attempt-{i:02d}!!"},
        )
        assert resp.status_code == 401, f"attempt {i}: {resp.status_code}"

    blocked = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "alice", "access_code": TEST_ACCESS_CODE},
    )
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "RATE_LIMITED"
