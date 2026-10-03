"""Contract tests for GET /api/v1/communities/{id}/environment (spec 8.2).

No test in this file performs a real external HTTP call: adapter HTTP is
monkeypatched at the module ``_fetch_json`` helper (or at ``fetch``), and
the fixture/verified-cache paths short-circuit before any network access.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from app.adapters.base import AdapterEnvelope
from app.db import epoch_to_iso, utc_now
from app.services.environment import cache_key


def _epoch(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    """Epoch seconds for a UTC timestamp (test-side expectation helper)."""
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp())

HOME_COMMUNITY_ID = "c1111111-1111-4111-8111-111111111111"
# EH16 5AA is seeded, is NOT in DEMO_CACHE, and is the subject for the
# degraded / no-fixture paths. EH8 9AB (the home community) now carries an
# honest demo fixture, so it can no longer stand in for "no fixture".
NO_FIXTURE_COMMUNITY_ID = "c2222222-2222-4222-8222-222222222222"
UNKNOWN_COMMUNITY_ID = "00000000-0000-4000-8000-000000000000"

ENV_SECTION_FIELDS = (
    "provider",
    "status",
    "data",
    "source_kind",
    "source",
    "source_url",
    "attribution",
    "fetched_at",
    "valid_time_from",
    "valid_time_to",
    "fresh_until",
    "stale_until",
)

# Realistic upstream payloads (shapes copied from the live APIs' docs) used
# to exercise the adapters' parsing without any network access.
_NESO_PAYLOAD = {
    "data": [
        {
            "regionid": 13,
            "dnoregion": "London",
            "shortname": "London",
            "data": [
                {
                    "from": "2026-10-03T10:00Z",
                    "to": "2026-10-03T10:30Z",
                    "intensity": {"forecast": 156, "index": "moderate"},
                    "generationmix": [
                        {"fuel": "gas", "perc": 45.2},
                        {"fuel": "wind", "perc": 30.1},
                        {"fuel": "solar", "perc": 10.4},
                        {"fuel": "coal", "perc": 2.1},
                    ],
                }
            ],
        }
    ]
}

_OPEN_METEO_PAYLOAD = {
    "latitude": 55.94,
    "longitude": -3.18,
    "current": {
        "time": "2026-10-03T10:00",
        "interval": 3600,
        "european_aqi": 26,
        "pm10": 11.9,
        "pm2_5": 6.4,
    },
}

_OVERPASS_PAYLOAD = {
    "elements": [
        {
            "type": "node",
            "id": 101,
            "lat": 55.9450,
            "lon": -3.1870,
            "tags": {"leisure": "park", "name": "Alpha Park"},
        },
        {
            "type": "way",
            "id": 202,
            "center": {"lat": 55.9460, "lon": -3.1860},
            "tags": {"leisure": "park", "name": "Beta Park"},
        },
        {
            "type": "node",
            "id": 303,
            "lat": 55.9440,
            "lon": -3.1880,
            "tags": {"leisure": "park"},  # unnamed -> skipped
        },
        {
            "type": "node",
            "id": 404,
            "lat": 55.9430,
            "lon": -3.1890,
            "tags": {"leisure": "garden", "name": "Gamma Garden"},
        },
    ]
}


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _get_env(client, token: str, community_id: str = HOME_COMMUNITY_ID):
    return client.get(
        f"/api/v1/communities/{community_id}/environment",
        headers=_auth(token),
    )


def _ok_carbon(intensity: int = 42) -> AdapterEnvelope:
    return AdapterEnvelope(
        provider="carbon_intensity",
        status="ok",
        data={"intensity": intensity, "index": "low"},
        source="Carbon Intensity API",
        source_url="https://carbon-intensity.github.io/api-definitions/",
        attribution="UK carbon intensity forecast",
        fetched_at=utc_now(),
    )


def _unavailable(provider: str) -> AdapterEnvelope:
    return AdapterEnvelope(provider=provider, status="unavailable")


def _insert_cache(
    db_path: str,
    provider: str,
    outcode: str,
    payload: dict,
    *,
    fetched_at: int,
    fresh_until: int | None,
    stale_until: int | None,
    source_kind: str = "cached",
) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO external_cache (cache_key, provider, schema_version, "
            "payload_json, source_url, attribution, source_kind, fetched_at, "
            "valid_time_from, valid_time_to, fresh_until, stale_until) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
            (
                cache_key(provider, outcode),
                provider,
                "1",
                json.dumps(payload),
                "https://example.invalid/provider",
                "Cached provider snapshot",
                source_kind,
                fetched_at,
                fresh_until,
                stale_until,
            ),
        )


def _mock_upstream_down(monkeypatch) -> None:
    """Every adapter's HTTP helper fails: no network, no live answers."""

    def down(url: str) -> dict:
        raise ConnectionError(f"no network access in tests: {url}")

    monkeypatch.setattr("app.adapters.carbon._fetch_json", down)
    monkeypatch.setattr("app.adapters.air._fetch_json", down)
    monkeypatch.setattr("app.adapters.greenspace._fetch_json", down)


# --- shape -------------------------------------------------------------------


def test_environment_envelope_shape_when_upstream_down(client, alice_token, monkeypatch):
    """With every upstream unreachable the response is still well-formed.

    EH16 5AA is seeded but has no demo-cache fixture, so all three providers
    degrade to unavailable sections with honest source metadata.
    """
    _mock_upstream_down(monkeypatch)
    resp = _get_env(client, alice_token, NO_FIXTURE_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["meta"]["request_id"]

    data = body["data"]
    # Every provider is a self-contained envelope with all spec 8.2 fields.
    for section_name in ("postcode", "carbon_intensity", "air_quality", "greenspace"):
        section = data[section_name]
        for field in ENV_SECTION_FIELDS:
            assert field in section, f"{section_name} missing {field}"

    # The community's own location snapshot is fixture-labelled, never live.
    postcode_section = data["postcode"]
    assert postcode_section["status"] == "ok"
    assert postcode_section["source_kind"] == "fixture"
    assert postcode_section["data"]["postcode"] == "EH16 5AA"
    assert postcode_section["data"]["outcode"] == "EH16"
    assert "fixture" in postcode_section["attribution"].lower()

    # All three providers failed upstream: unavailable, but the envelope
    # still carries the real source metadata for the UI.
    for section_name in ("carbon_intensity", "air_quality", "greenspace"):
        section = data[section_name]
        assert section["status"] == "unavailable"
        assert section["data"] is None
        assert section["source_kind"] is None
        assert section["source"], f"{section_name} source must be non-empty"
        assert section["source_url"], f"{section_name} source_url must be non-empty"
        assert section["attribution"], f"{section_name} attribution must be non-empty"

    # Nothing healthy -> overall unavailable (no environment data at all).
    assert data["status"] == "unavailable"


# --- live adapter shapes (HTTP mocked, real parsing) ---------------------------


def test_environment_carbon_live_shape(client, alice_token, monkeypatch, db_path):
    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr(
        "app.adapters.carbon._fetch_json", lambda url: _NESO_PAYLOAD
    )
    resp = _get_env(client, alice_token)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    carbon = data["carbon_intensity"]
    assert carbon["status"] == "ok"
    assert carbon["source_kind"] == "live"
    # C's parsing: clean-energy share over the generation mix, top source.
    assert carbon["data"]["index"] == "moderate"
    assert carbon["data"]["forecast"] == 156
    assert carbon["data"]["clean_energy_percentage"] == 40.5
    assert carbon["data"]["top_source"] == "Gas (45.2%)"
    assert carbon["data"]["unit"] == "gCO2/kWh"
    # Validity window parsed from the upstream from/to timestamps.
    assert carbon["valid_time_from"] == epoch_to_iso(_epoch(2026, 10, 3, 10, 0))
    assert carbon["valid_time_to"] == epoch_to_iso(_epoch(2026, 10, 3, 10, 30))
    assert carbon["fetched_at"].endswith("Z")
    assert carbon["fresh_until"].endswith("Z")
    assert carbon["stale_until"].endswith("Z")
    # Real source metadata, not a placeholder.
    assert carbon["source"] == "NESO Carbon Intensity API (National Grid ESO)"
    assert carbon["source_url"] == "https://carbon-intensity.github.io/api-definitions/"
    assert carbon["attribution"]

    # The live answer was written to external_cache in a short transaction.
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT payload_json, source_kind FROM external_cache WHERE cache_key = ?",
            (cache_key("carbon_intensity", "EH8"),),
        ).fetchone()
    assert row is not None
    assert json.loads(row[0])["forecast"] == 156
    assert row[1] == "live"


def test_environment_air_live_shape(client, alice_token, monkeypatch):
    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr(
        "app.adapters.air._fetch_json", lambda url: _OPEN_METEO_PAYLOAD
    )
    resp = _get_env(client, alice_token)
    assert resp.status_code == 200, resp.text
    air = resp.json()["data"]["air_quality"]

    assert air["status"] == "ok"
    assert air["source_kind"] == "live"
    assert air["data"]["aqi"] == 26
    assert air["data"]["pm2_5"] == 6.4
    assert air["data"]["pm10"] == 11.9
    assert air["data"]["status"] == "Fair"  # C's European AQI banding
    # Hourly model timestamp, validity window = one interval.
    assert air["valid_time_from"] == epoch_to_iso(_epoch(2026, 10, 3, 10, 0))
    assert air["valid_time_to"] == epoch_to_iso(_epoch(2026, 10, 3, 11, 0))
    assert air["source"] == "Open-Meteo Air Quality (11km regional grid forecast)"
    assert air["source_url"] == "https://open-meteo.com/en/docs/air-quality-api"
    assert air["attribution"]


def test_environment_greenspace_live_shape(client, alice_token, monkeypatch):
    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr(
        "app.adapters.greenspace._fetch_json", lambda url: _OVERPASS_PAYLOAD
    )
    resp = _get_env(client, alice_token)
    assert resp.status_code == 200, resp.text
    green = resp.json()["data"]["greenspace"]

    assert green["status"] == "ok"
    assert green["source_kind"] == "live"
    spaces = green["data"]
    # Unnamed element skipped; remaining sorted by distance, nearest first.
    assert [s["name"] for s in spaces] == ["Alpha Park", "Beta Park", "Gamma Garden"]
    assert spaces[0]["id"] == "osm-101"
    assert spaces[0]["type"] == "Park"
    assert spaces[0]["source"] == "OpenStreetMap Overpass API"
    assert spaces[0]["distance_km"] <= spaces[1]["distance_km"]
    assert spaces[1]["distance_km"] <= spaces[2]["distance_km"]
    assert green["source_url"] == "https://overpass-api.de/api/interpreter"
    assert "OpenStreetMap" in green["attribution"]


# --- overall status aggregation ----------------------------------------------


def test_environment_partial_when_one_provider_ok(client, alice_token, monkeypatch, db_path):
    # The other two providers' HTTP is mocked to fail: no real network.
    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr(
        "app.adapters.carbon.fetch", lambda **kwargs: _ok_carbon(42)
    )
    resp = _get_env(client, alice_token, NO_FIXTURE_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    assert data["status"] == "partial"
    carbon = data["carbon_intensity"]
    assert carbon["status"] == "ok"
    assert carbon["source_kind"] == "live"
    assert carbon["data"]["intensity"] == 42
    assert carbon["fetched_at"].endswith("Z")
    assert carbon["fresh_until"].endswith("Z")
    assert carbon["stale_until"].endswith("Z")
    # Other providers keep their own statuses.
    assert data["air_quality"]["status"] == "unavailable"
    assert data["greenspace"]["status"] == "unavailable"

    # The live answer was written to external_cache in a short transaction.
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT payload_json, source_kind, fetched_at, fresh_until, stale_until "
            "FROM external_cache WHERE cache_key = ?",
            (cache_key("carbon_intensity", "EH16"),),
        ).fetchone()
    assert row is not None
    assert json.loads(row[0])["intensity"] == 42
    assert row[1] == "live"
    assert row[2] is not None and row[3] > row[2] and row[4] >= row[3]


def test_environment_all_unavailable_is_unavailable(client, alice_token, monkeypatch):
    def fake(provider):
        return lambda **kwargs: _unavailable(provider)

    monkeypatch.setattr("app.adapters.carbon.fetch", fake("carbon_intensity"))
    monkeypatch.setattr("app.adapters.air.fetch", fake("air_quality"))
    monkeypatch.setattr("app.adapters.greenspace.fetch", fake("greenspace"))

    resp = _get_env(client, alice_token, NO_FIXTURE_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    for section_name in ("carbon_intensity", "air_quality", "greenspace"):
        assert data[section_name]["status"] == "unavailable"
        assert data[section_name]["data"] is None
    assert data["status"] == "unavailable"


def test_environment_provider_failure_does_not_break_response(
    client, alice_token, monkeypatch, tmp_path
):
    """A raising adapter becomes an unavailable section, not a 500."""
    secret = str(tmp_path / "internal-stack.py")

    def boom(**kwargs):
        raise RuntimeError(f"boom internals at {secret}")

    # Greenspace HTTP is mocked to fail: no real network in tests.
    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr("app.adapters.air.fetch", boom)
    monkeypatch.setattr("app.adapters.carbon.fetch", lambda **kwargs: _ok_carbon())

    resp = _get_env(client, alice_token, NO_FIXTURE_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["air_quality"]["status"] == "unavailable"
    assert data["carbon_intensity"]["status"] == "ok"
    assert data["postcode"]["status"] == "ok"
    assert data["status"] == "partial"

    text = resp.text
    assert "Traceback" not in text
    assert "boom internals" not in text
    assert secret not in text
    assert ".sqlite3" not in text


# --- demo fixture fallback (C's demo cache) ------------------------------------


def test_environment_demo_fixture_fallback_when_upstream_down(
    client, alice_token, monkeypatch, db_path
):
    """Demo postcodes get C's curated fixture snapshot when upstream fails.

    The fixture is served with source_kind="fixture" and is never written
    to external_cache as if it were a live answer.
    """
    now = utc_now()
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO communities (id, postcode, outcode, latitude, longitude, "
            "country, source, source_kind, fetched_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("c9999999-9999-4999-8999-999999999999", "EH14 4AS", "EH14",
             55.9092, -3.3193, "Scotland", "fixture", "fixture", now, now),
        )

    _mock_upstream_down(monkeypatch)
    resp = client.get(
        "/api/v1/communities/c9999999-9999-4999-8999-999999999999/environment",
        headers=_auth(alice_token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    carbon = data["carbon_intensity"]
    assert carbon["status"] == "ok"
    assert carbon["source_kind"] == "fixture"
    assert carbon["data"]["index"] == "very low"
    assert carbon["data"]["forecast"] == 38
    assert "fixture" in carbon["attribution"].lower()
    assert carbon["source_url"] == "https://carbon-intensity.github.io/api-definitions/"

    air = data["air_quality"]
    assert air["status"] == "ok"
    assert air["source_kind"] == "fixture"
    assert air["data"]["aqi"] == 19
    assert air["data"]["status"] == "Good"

    green = data["greenspace"]
    assert green["status"] == "ok"
    assert green["source_kind"] == "fixture"
    assert green["data"][0]["name"] == "Riccarton Estate & Campus Loch"
    assert "OpenStreetMap" in green["attribution"]

    # All three providers healthy on fixture data -> overall ok.
    assert data["status"] == "ok"

    # Fixture data is served from the module, never cached as live.
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT cache_key FROM external_cache WHERE cache_key LIKE 'env:%'"
        ).fetchall()
    assert rows == []


def test_environment_home_community_has_offline_fixture_fallback(
    client, alice_token, monkeypatch, db_path
):
    """The seeded home community (EH8 9AB) is offline-safe: with every
    upstream unreachable it falls back to C's honest fixture snapshot, so the
    demo never depends on live Overpass / Open-Meteo / NESO."""
    _mock_upstream_down(monkeypatch)
    resp = _get_env(client, alice_token)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    green = data["greenspace"]
    assert green["status"] == "ok"
    assert green["source_kind"] == "fixture"
    names = [place["name"] for place in green["data"]]
    assert "George Square Gardens" in names
    assert "The Meadows" in names
    assert green["data"][0]["distance_km"] <= 2

    assert data["air_quality"]["source_kind"] == "fixture"
    assert data["carbon_intensity"]["source_kind"] == "fixture"
    assert data["status"] == "ok"


# --- cache freshness / staleness ----------------------------------------------


def test_environment_fresh_cache_served_without_adapter_call(
    client, alice_token, monkeypatch, db_path
):
    now = utc_now()
    _insert_cache(
        db_path,
        "carbon_intensity",
        "EH16",
        {"intensity": 77, "index": "moderate"},
        fetched_at=now - 600,
        fresh_until=now + 3600,
        stale_until=now + 7200,
    )

    def no_call(**kwargs):
        raise AssertionError("adapter must not be called while the cache is fresh")

    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr("app.adapters.carbon.fetch", no_call)

    resp = _get_env(client, alice_token, NO_FIXTURE_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    section = resp.json()["data"]["carbon_intensity"]
    assert section["status"] == "cached"
    assert section["source_kind"] == "cached"
    assert section["data"]["intensity"] == 77
    assert section["fetched_at"] == epoch_to_iso(now - 600)
    assert section["fresh_until"] == epoch_to_iso(now + 3600)
    assert section["stale_until"] == epoch_to_iso(now + 7200)
    # Only one provider healthy -> partial.
    assert resp.json()["data"]["status"] == "partial"


def test_environment_stale_cache_served_when_adapter_not_ok(
    client, alice_token, monkeypatch, db_path
):
    now = utc_now()
    _insert_cache(
        db_path,
        "carbon_intensity",
        "EH8",
        {"intensity": 55},
        fetched_at=now - 7200,
        fresh_until=now - 60,        # already stale ...
        stale_until=now + 3600,      # ... but still within the stale window
    )

    calls: list[str] = []

    def adapter(**kwargs):
        calls.append("carbon")
        return AdapterEnvelope(provider="carbon_intensity", status="unavailable")

    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr("app.adapters.carbon.fetch", adapter)

    resp = _get_env(client, alice_token)
    assert resp.status_code == 200, resp.text
    section = resp.json()["data"]["carbon_intensity"]
    assert calls == ["carbon"]  # stale entry triggers a refresh attempt
    assert section["status"] == "cached"
    assert section["source_kind"] == "cached"
    assert section["data"]["intensity"] == 55
    # The stale flag is visible: fresh_until is in the past.
    fresh = datetime.strptime(section["fresh_until"], "%Y-%m-%dT%H:%M:%SZ")
    assert fresh.replace(tzinfo=timezone.utc).timestamp() < now
    assert section["stale_until"] == epoch_to_iso(now + 3600)


def test_environment_expired_cache_is_not_served(
    client, alice_token, monkeypatch, db_path
):
    now = utc_now()
    _insert_cache(
        db_path,
        "carbon_intensity",
        "EH16",
        {"intensity": 1},
        fetched_at=now - 86400,
        fresh_until=now - 7200,
        stale_until=now - 60,  # fully expired
    )
    _mock_upstream_down(monkeypatch)
    monkeypatch.setattr(
        "app.adapters.carbon.fetch",
        lambda **kwargs: AdapterEnvelope(
            provider="carbon_intensity", status="unavailable"
        ),
    )

    resp = _get_env(client, alice_token, NO_FIXTURE_COMMUNITY_ID)
    assert resp.status_code == 200, resp.text
    section = resp.json()["data"]["carbon_intensity"]
    # EH16 5AA is not a demo postcode: no fixture fallback either.
    assert section["status"] == "unavailable"
    assert section["data"] is None
    assert section["source_kind"] is None


# --- CORS -----------------------------------------------------------------------


def test_cors_preflight_allows_frontend_dev_server(client):
    """Vite dev server on 5173 may preflight with the app's headers."""
    resp = client.options(
        "/api/v1/communities/resolve",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization, Idempotency-Key, Content-Type",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"
    allow_headers = resp.headers.get("access-control-allow-headers", "").lower()
    for header in ("authorization", "idempotency-key", "content-type"):
        assert header in allow_headers


def test_cors_origin_header_on_actual_response(client, alice_token):
    resp = client.get(
        "/api/v1/communities/resolve",
        params={"postcode": "EH8 9AB"},
        headers={**_auth(alice_token), "Origin": "http://127.0.0.1:5173"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    # X-Request-Id is set by the request-id middleware and exposed for CORS.
    assert resp.headers["x-request-id"]


# --- community / auth ----------------------------------------------------------


def test_environment_unknown_community_404(client, alice_token):
    resp = _get_env(client, alice_token, UNKNOWN_COMMUNITY_ID)
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"
    text = resp.text
    assert "SELECT" not in text and "sqlite" not in text


def test_environment_requires_auth(client):
    resp = client.get(f"/api/v1/communities/{HOME_COMMUNITY_ID}/environment")
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"
