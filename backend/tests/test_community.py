"""Contract tests for GET /api/v1/communities/resolve (spec 8.2 / 4.3).

No test in this file performs a real external HTTP call: the postcode
adapter is monkeypatched wherever the upstream would be reached, and the
fixture/verified-cache paths short-circuit before any network access.
"""

from __future__ import annotations

import json
import sqlite3

import httpx
import pytest

from app.adapters.base import AdapterEnvelope
from app.adapters.postcode import (
    PostcodeNotFoundError,
    format_uk_postcode,
    normalize_postcode,
)
from app.db import utc_now
from app.services.community import postcode_cache_key

HOME_COMMUNITY_ID = "c1111111-1111-4111-8111-111111111111"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _resolve(client, token, postcode: str):
    return client.get(
        "/api/v1/communities/resolve",
        params={"postcode": postcode},
        headers=_auth(token),
    )


def _ok_envelope(postcode: str, outcode: str, lat: float, lon: float) -> AdapterEnvelope:
    return AdapterEnvelope(
        provider="postcodes_io",
        status="ok",
        data={
            "postcode": postcode,
            "outcode": outcode,
            "latitude": lat,
            "longitude": lon,
            "country": "Scotland",
        },
        source="postcodes.io",
        source_url="https://postcodes.io/",
        attribution="Powered by postcodes.io",
        fetched_at=utc_now(),
    )


def _unavailable_envelope() -> AdapterEnvelope:
    return AdapterEnvelope(
        provider="postcodes_io",
        status="unavailable",
        source="postcodes.io",
        source_url="https://postcodes.io/",
        attribution="Powered by postcodes.io",
    )


def _no_network(postcode: str) -> AdapterEnvelope:
    raise AssertionError(f"unexpected upstream call for {postcode!r}")


# --- normalisation -----------------------------------------------------------


def test_resolve_normalises_case_and_whitespace(client, alice_token, monkeypatch):
    """Lower-case / messy input resolves to the canonical fixture community."""
    monkeypatch.setattr("app.adapters.postcode.fetch", _no_network)
    resp = _resolve(client, alice_token, "  eh8\t  9ab  ")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["postcode"] == "EH8 9AB"
    assert data["outcode"] == "EH8"
    assert data["id"] == HOME_COMMUNITY_ID
    # Fixture snapshot stays honestly labelled.
    assert data["source_kind"] == "fixture"
    assert data["source"] == "fixture"


def test_resolve_fixture_community_eh16(client, alice_token, monkeypatch):
    monkeypatch.setattr("app.adapters.postcode.fetch", _no_network)
    resp = _resolve(client, alice_token, "EH16 5AA")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["postcode"] == "EH16 5AA"
    assert data["outcode"] == "EH16"
    assert data["source_kind"] == "fixture"
    assert data["country"] == "Scotland"
    assert abs(data["latitude"] - 55.92518) < 1e-6
    assert abs(data["longitude"] - -3.17669) < 1e-6
    assert data["fetched_at"].endswith("Z")


# --- invalid input -----------------------------------------------------------


def test_resolve_invalid_postcode_422(client, alice_token, monkeypatch):
    """Shape pre-check rejects bad input without ever calling upstream."""
    monkeypatch.setattr("app.adapters.postcode.fetch", _no_network)
    resp = _resolve(client, alice_token, "not a postcode")
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"]["code"] == "INVALID_POSTCODE"
    assert body["meta"]["request_id"]


def test_resolve_upstream_404_maps_to_422(client, alice_token, monkeypatch):
    """A syntactically plausible postcode rejected upstream is invalid."""
    def not_found(postcode: str) -> AdapterEnvelope:
        raise PostcodeNotFoundError(postcode)

    monkeypatch.setattr("app.adapters.postcode.fetch", not_found)
    resp = _resolve(client, alice_token, "ZZ99 9ZZ")
    assert resp.status_code == 422, resp.text
    assert resp.json()["error"]["code"] == "INVALID_POSTCODE"


# --- upstream failure / cache fallback ---------------------------------------


def test_resolve_upstream_failure_without_cache_503(client, alice_token, monkeypatch):
    monkeypatch.setattr(
        "app.adapters.postcode.fetch", lambda postcode: _unavailable_envelope()
    )
    resp = _resolve(client, alice_token, "EH9 9AA")
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["error"]["code"] == "UPSTREAM_UNAVAILABLE"
    # No SQL / path / stack leakage.
    text = resp.text
    assert "Traceback" not in text
    assert ".sqlite3" not in text


def test_resolve_upstream_failure_with_cache_returns_cached(
    client, alice_token, monkeypatch, db_path
):
    postcode = "EH9 9AA"
    now = utc_now()
    payload = {
        "postcode": postcode,
        "outcode": "EH9",
        "latitude": 55.9412,
        "longitude": -3.1812,
        "country": "Scotland",
    }
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO external_cache (cache_key, provider, schema_version, "
            "payload_json, source_url, attribution, source_kind, fetched_at, "
            "valid_time_from, valid_time_to, fresh_until, stale_until) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
            (
                postcode_cache_key(postcode),
                "postcodes_io",
                "1",
                json.dumps(payload),
                "https://postcodes.io/",
                "Powered by postcodes.io",
                "cached",
                now,
                now + 3600,
                now + 86400,
            ),
        )

    monkeypatch.setattr(
        "app.adapters.postcode.fetch", lambda pc: _unavailable_envelope()
    )
    resp = _resolve(client, alice_token, postcode)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["postcode"] == "EH9 9AA"
    assert data["outcode"] == "EH9"
    assert data["source_kind"] == "cached"
    assert abs(data["latitude"] - 55.9412) < 1e-6

    # The fallback also materialises the community row.
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT source_kind FROM communities WHERE postcode = ?", (postcode,)
        ).fetchone()
    assert row is not None and row[0] == "cached"


# --- persistence -------------------------------------------------------------


def test_resolve_writes_new_community_row(client, alice_token, monkeypatch, db_path):
    seen: list[str] = []

    def fake_fetch(postcode: str) -> AdapterEnvelope:
        seen.append(postcode)
        return _ok_envelope("EH2 2DD", "EH2", 55.9506, -3.1870)

    monkeypatch.setattr("app.adapters.postcode.fetch", fake_fetch)
    resp = _resolve(client, alice_token, "  eh2   2dd ")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    # The adapter received the normalised canonical form.
    assert seen == ["EH2 2DD"]
    assert data["postcode"] == "EH2 2DD"
    assert data["source_kind"] == "live"
    assert data["source"] == "postcodes.io"

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT postcode, outcode, source_kind, source, latitude, longitude "
            "FROM communities WHERE postcode = 'EH2 2DD'"
        ).fetchone()
        cache_row = conn.execute(
            "SELECT payload_json, source_kind FROM external_cache WHERE cache_key = ?",
            (postcode_cache_key("EH2 2DD"),),
        ).fetchone()
    assert row is not None
    assert row[0] == "EH2 2DD" and row[1] == "EH2" and row[2] == "live"
    assert row[3] == "postcodes.io"
    assert abs(row[4] - 55.9506) < 1e-9 and abs(row[5] - -3.1870) < 1e-9
    # Verified snapshot kept in external_cache for later upstream failures.
    assert cache_row is not None and cache_row[1] == "live"
    assert json.loads(cache_row[0])["postcode"] == "EH2 2DD"


def test_resolve_other_postcode_keeps_identity(client, alice_token, monkeypatch):
    """Querying another postcode must not change the caller's home community."""
    monkeypatch.setattr(
        "app.adapters.postcode.fetch",
        lambda postcode: _ok_envelope("EH2 2DD", "EH2", 55.9506, -3.1870),
    )
    resp = _resolve(client, alice_token, "EH2 2DD")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["id"] != HOME_COMMUNITY_ID

    me = client.get("/api/v1/me", headers=_auth(alice_token))
    assert me.status_code == 200, me.text
    assert me.json()["data"]["community"]["id"] == HOME_COMMUNITY_ID


# --- auth ---------------------------------------------------------------------


def test_resolve_requires_auth(client):
    resp = client.get(
        "/api/v1/communities/resolve", params={"postcode": "EH8 9AB"}
    )
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


# --- postcode adapter normalisation (absorbed from C) ----------------------------


@pytest.mark.parametrize(
    ("raw", "compact"),
    [
        ("EH8 9AB", "EH89AB"),
        ("  eh8  9ab  ", "EH89AB"),
        ("eh89ab", "EH89AB"),
        ("", ""),
        (None, ""),
    ],
)
def test_postcode_adapter_normalize(raw, compact):
    assert normalize_postcode(raw) == compact


@pytest.mark.parametrize(
    ("compact", "display"),
    [
        ("EH144AS", "EH14 4AS"),
        ("EH11YZ", "EH1 1YZ"),
        ("EH89YL", "EH8 9YL"),
        # C's formatter has no GIR special case; splitting "GIR0AA" as
        # "GIR" + "0AA" happens to produce the correct display form.
        ("GIR0AA", "GIR 0AA"),
    ],
)
def test_postcode_adapter_format(compact, display):
    assert format_uk_postcode(compact) == display


# --- demo fixture fallback (C's demo cache) -------------------------------------


def test_resolve_upstream_down_demo_postcode_returns_fixture(
    client, alice_token, monkeypatch, db_path
):
    """EH14 4AS with no network: C's curated fixture answers, labelled fixture."""

    def no_network(url: str) -> dict:
        raise ConnectionError(f"no network access in tests: {url}")

    monkeypatch.setattr("app.adapters.postcode.httpx.get", no_network)
    resp = _resolve(client, alice_token, "  eh14 4as ")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["postcode"] == "EH14 4AS"
    assert data["outcode"] == "EH14"
    assert data["source_kind"] == "fixture"
    assert data["source"] == "fixture"
    assert abs(data["latitude"] - 55.9092) < 1e-6
    assert abs(data["longitude"] - -3.3193) < 1e-6

    # The fixture community row was materialised for later lookups.
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT postcode, outcode, source_kind FROM communities WHERE postcode = ?",
            ("EH14 4AS",),
        ).fetchone()
    assert row is not None and row[2] == "fixture"


def test_resolve_upstream_down_unknown_postcode_still_503(
    client, alice_token, monkeypatch
):
    """A non-demo postcode with no network has no fixture to fall back to."""

    def no_network(url: str) -> dict:
        raise ConnectionError(f"no network access in tests: {url}")

    monkeypatch.setattr("app.adapters.postcode.httpx.get", no_network)
    resp = _resolve(client, alice_token, "EH9 9AA")
    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_resolve_adapter_normalizes_before_upstream_call(
    client, alice_token, monkeypatch
):
    """The adapter strips case/spaces before quoting the upstream URL."""
    seen: list[str] = []

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {
                "status": 200,
                "result": {
                    "postcode": "EH2 2DD",
                    "outcode": "EH2",
                    "latitude": 55.9506,
                    "longitude": -3.1870,
                    "country": "Scotland",
                },
            }

    def fake_get(url: str, **kwargs):
        seen.append(url)
        return _FakeResponse()

    monkeypatch.setattr("app.adapters.postcode.httpx.get", fake_get)
    resp = _resolve(client, alice_token, "  eh2   2dd ")
    assert resp.status_code == 200, resp.text
    assert seen == ["https://api.postcodes.io/postcodes/EH22DD"]


def test_resolve_adapter_http_error_is_unavailable_not_500(
    client, alice_token, monkeypatch
):
    def fake_get(url: str, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("app.adapters.postcode.httpx.get", fake_get)
    resp = _resolve(client, alice_token, "EH2 2DD")
    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "UPSTREAM_UNAVAILABLE"
    assert "Traceback" not in resp.text
