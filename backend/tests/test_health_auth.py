"""Contract tests for health checks and demo authentication (spec 8.2 / 4.1).

The demo access code was removed by explicit user decision (see
docs/DECISIONS.md "移除演示访问码"): login only needs `user_alias`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import SettingsError, get_settings, reset_settings_cache
from tests.conftest import auth_headers, login


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
    monkeypatch.delenv("DEMO_ACCESS_CODE", raising=False)
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
        json={"user_alias": "alice"},
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


def test_demo_login_without_access_code_env(client, monkeypatch):
    """Login works with no DEMO_ACCESS_CODE in the environment at all."""
    monkeypatch.delenv("DEMO_ACCESS_CODE", raising=False)
    resp = client.post("/api/v1/demo/sessions", json={"user_alias": "alice"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["data"]["access_token"]


def test_demo_login_ignores_access_code(client):
    """A leftover `access_code` key from an old client is accepted and ignored."""
    resp = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "alice", "access_code": "stale-value-from-old-client"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["data"]["user"]["alias"] == "alice"


def test_demo_login_unknown_alias(client):
    resp = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "mallory"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


def test_demo_login_extra_field_rejected(client):
    resp = client.post(
        "/api/v1/demo/sessions",
        json={
            "user_alias": "alice",
            "user_id": "u1111111-1111-4111-8111-111111111111",
        },
    )
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "VALIDATION_ERROR"
    assert "u1111111" not in err.get("message", "")


# --- Configuration gate ------------------------------------------------------


@pytest.mark.parametrize("env_value", [None, "", "change-me", "short"])
def test_startup_needs_no_access_code(env_value, monkeypatch):
    """Missing / empty / placeholder / short DEMO_ACCESS_CODE never blocks startup."""
    if env_value is None:
        monkeypatch.delenv("DEMO_ACCESS_CODE", raising=False)
    else:
        monkeypatch.setenv("DEMO_ACCESS_CODE", env_value)
    monkeypatch.setenv("APP_MODE", "demo")
    reset_settings_cache()
    try:
        settings = get_settings()
        assert settings.app_mode == "demo"
        assert settings.session_ttl_hours >= 1
        assert not hasattr(settings, "demo_access_code")
    finally:
        reset_settings_cache()


def test_create_app_starts_without_access_code(monkeypatch):
    monkeypatch.delenv("DEMO_ACCESS_CODE", raising=False)
    monkeypatch.setenv("APP_MODE", "demo")
    reset_settings_cache()
    try:
        from app.main import create_app

        app = create_app()
        assert app is not None
    finally:
        reset_settings_cache()


def test_production_mode_refuses_to_start(monkeypatch):
    """APP_MODE=production still refuses to start (real auth not implemented)."""
    monkeypatch.setenv("APP_MODE", "production")
    monkeypatch.delenv("DEMO_ACCESS_CODE", raising=False)
    reset_settings_cache()
    try:
        with pytest.raises(SettingsError):
            get_settings()
    finally:
        reset_settings_cache()


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


def test_login_rate_limited_after_soft_cap(client):
    """Loose flood guard: 60 demo logins/minute per IP -> 429 on the next one."""
    for i in range(60):
        resp = client.post(
            "/api/v1/demo/sessions",
            json={"user_alias": "alice"},
        )
        assert resp.status_code == 201, f"attempt {i}: {resp.status_code}"

    blocked = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": "alice"},
    )
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "RATE_LIMITED"
