"""Shared pytest fixtures for the Borrow Next Door backend.

Contract for follow-up tasks: add new test files, do NOT modify this file.
All fixtures use a real on-disk SQLite database (never :memory:) so later
concurrency tests can open independent connections against the same file.
"""

from __future__ import annotations

import os
import uuid

# Must be set before app.main is imported: the module builds an app instance
# at import time and validates configuration. No access code is needed anymore
# (removed by user decision), only APP_MODE.
os.environ.setdefault("APP_MODE", "demo")
os.environ.pop("DEMO_ACCESS_CODE", None)

import pytest
from fastapi.testclient import TestClient

from app.auth import reset_rate_limits
from app.config import get_settings, reset_settings_cache
from app.migrations import migrate
from app.seed import seed

ALIAS_LIST = ("alice", "bob", "carol")


@pytest.fixture()
def db_path(tmp_path) -> str:
    """Real temporary file database path (fresh per test)."""
    return str(tmp_path / "borrow-next-door-test.sqlite3")


@pytest.fixture()
def settings(db_path, monkeypatch):
    """Test settings: temp DB file, no access code, demo mode."""
    monkeypatch.setenv("DATABASE_PATH", db_path)
    monkeypatch.delenv("DEMO_ACCESS_CODE", raising=False)
    monkeypatch.setenv("APP_MODE", "demo")
    reset_settings_cache()
    reset_rate_limits()
    yield get_settings()
    reset_settings_cache()
    reset_rate_limits()


@pytest.fixture()
def app(settings):
    """Migrated + seeded application instance."""
    migrate(settings.database_path)
    seed(settings.database_path)
    from app.main import create_app

    return create_app()


@pytest.fixture()
def client(app):
    """fastapi.testclient.TestClient bound to the test app/database."""
    with TestClient(app) as test_client:
        yield test_client


def login(client: TestClient, alias: str) -> str:
    """Perform a demo login (alias only, no access code) and return the token."""
    resp = client.post(
        "/api/v1/demo/sessions",
        json={"user_alias": alias},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]["access_token"]


@pytest.fixture()
def alice_token(client) -> str:
    return login(client, "alice")


@pytest.fixture()
def bob_token(client) -> str:
    return login(client, "bob")


@pytest.fixture()
def carol_token(client) -> str:
    return login(client, "carol")


def auth_headers(user: str, token: str) -> dict[str, str]:
    """Bearer headers for the given user's token (`user` kept for signature
    compatibility with the shared contract; only the token is sent)."""
    _ = user
    return {"Authorization": f"Bearer {token}"}


def new_idem_key() -> str:
    """A fresh UUID Idempotency-Key for one user intent."""
    return str(uuid.uuid4())
