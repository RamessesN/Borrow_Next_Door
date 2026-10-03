"""Unit tests for the provider adapters' live parsing shapes.

Every test monkeypatches the module-level ``_fetch_json`` HTTP helper (or
``httpx.get`` for the postcode adapter): no real network request is ever
made. The point is to pin the envelope contract and C's parsing logic
(clean-energy share, AQI banding, haversine sort, validity windows).
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from app.adapters import air as air_adapter
from app.adapters import carbon as carbon_adapter
from app.adapters import greenspace as greenspace_adapter
from app.adapters import postcode as postcode_adapter
from app.adapters.base import AdapterEnvelope
from app.adapters.postcode import PostcodeNotFoundError

COORDS = {"postcode": "EH8 9AB", "outcode": "EH8", "latitude": 55.944703, "longitude": -3.187417}


def _epoch(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp())


# --- carbon ---------------------------------------------------------------------


def test_carbon_fetch_parses_neso_regional_payload(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.carbon._fetch_json",
        lambda url: {
            "data": [
                {
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
                    ]
                }
            ]
        },
    )
    envelope = carbon_adapter.fetch(**COORDS)
    assert envelope["provider"] == "carbon_intensity"
    assert envelope["status"] == "ok"
    assert envelope["data"]["index"] == "moderate"
    assert envelope["data"]["forecast"] == 156
    # Clean fuels: wind 30.1 + solar 10.4.
    assert envelope["data"]["clean_energy_percentage"] == 40.5
    assert envelope["data"]["top_source"] == "Gas (45.2%)"
    assert envelope["valid_time_from"] == _epoch(2026, 10, 3, 10, 0)
    assert envelope["valid_time_to"] == _epoch(2026, 10, 3, 10, 30)
    assert envelope["fetched_at"] is not None
    assert envelope["source"] == "NESO Carbon Intensity API (National Grid ESO)"
    assert envelope["source_url"] == "https://carbon-intensity.github.io/api-definitions/"
    assert envelope["attribution"]


def test_carbon_fetch_malformed_payload_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.carbon._fetch_json", lambda url: {"unexpected": True}
    )
    envelope = carbon_adapter.fetch(**COORDS)
    assert envelope["status"] == "unavailable"
    assert envelope["data"] is None
    # Source metadata stays populated so the UI can name the provider.
    assert envelope["source"] and envelope["source_url"] and envelope["attribution"]


def test_carbon_fetch_http_failure_is_unavailable_not_raise(monkeypatch):
    def down(url: str) -> dict:
        raise OSError("network unreachable")

    monkeypatch.setattr("app.adapters.carbon._fetch_json", down)
    envelope = carbon_adapter.fetch(**COORDS)  # must not raise
    assert envelope["status"] == "unavailable"
    assert envelope["data"] is None


# --- air ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("aqi", "label"),
    [(5, "Good"), (20, "Good"), (21, "Fair"), (40, "Fair"), (41, "Moderate"),
     (60, "Moderate"), (61, "Poor"), (80, "Poor"), (81, "Very Poor"), (120, "Very Poor")],
)
def test_air_fetch_aqi_banding(monkeypatch, aqi, label):
    monkeypatch.setattr(
        "app.adapters.air._fetch_json",
        lambda url: {
            "current": {
                "time": "2026-10-03T10:00",
                "interval": 3600,
                "european_aqi": aqi,
                "pm10": 11.9,
                "pm2_5": 6.4,
            }
        },
    )
    envelope = air_adapter.fetch(**COORDS)
    assert envelope["status"] == "ok"
    assert envelope["data"]["aqi"] == aqi
    assert envelope["data"]["status"] == label
    assert envelope["data"]["pm2_5"] == 6.4
    assert envelope["data"]["pm10"] == 11.9
    assert envelope["valid_time_from"] == _epoch(2026, 10, 3, 10, 0)
    assert envelope["valid_time_to"] == _epoch(2026, 10, 3, 11, 0)
    assert envelope["source_url"] == "https://open-meteo.com/en/docs/air-quality-api"
    assert envelope["attribution"]


def test_air_fetch_malformed_payload_is_unavailable(monkeypatch):
    monkeypatch.setattr("app.adapters.air._fetch_json", lambda url: {"current": {}})
    envelope = air_adapter.fetch(**COORDS)
    assert envelope["status"] == "unavailable"
    assert envelope["data"] is None


def test_air_fetch_http_failure_is_unavailable_not_raise(monkeypatch):
    def down(url: str) -> dict:
        raise TimeoutError("timed out")

    monkeypatch.setattr("app.adapters.air._fetch_json", down)
    envelope = air_adapter.fetch(**COORDS)  # must not raise
    assert envelope["status"] == "unavailable"


# --- greenspace -------------------------------------------------------------------


def test_greenspace_fetch_parses_overpass_elements(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.greenspace._fetch_json",
        lambda url: {
            "elements": [
                {"type": "node", "id": 1, "lat": 55.9450, "lon": -3.1870,
                 "tags": {"leisure": "park", "name": "Alpha Park"}},
                {"type": "way", "id": 2, "center": {"lat": 55.9460, "lon": -3.1860},
                 "tags": {"leisure": "park", "name": "Beta Park"}},
                {"type": "node", "id": 3, "lat": 55.9440, "lon": -3.1880,
                 "tags": {"leisure": "park"}},  # unnamed -> skipped
                {"type": "node", "id": 4, "lat": 55.9430, "lon": -3.1890,
                 "tags": {"leisure": "garden", "name": "Gamma Garden"}},
            ]
        },
    )
    envelope = greenspace_adapter.fetch(**COORDS)
    assert envelope["status"] == "ok"
    spaces = envelope["data"]
    assert [s["name"] for s in spaces] == ["Alpha Park", "Beta Park", "Gamma Garden"]
    assert spaces[0]["id"] == "osm-1"
    assert spaces[0]["type"] == "Park"
    assert spaces[2]["type"] == "Garden"
    assert spaces[0]["distance_km"] <= spaces[1]["distance_km"] <= spaces[2]["distance_km"]
    assert envelope["source"] == "OpenStreetMap Overpass API"
    assert envelope["source_url"] == "https://overpass-api.de/api/interpreter"
    assert "OpenStreetMap" in envelope["attribution"]


def test_greenspace_fetch_caps_at_five_nearest(monkeypatch):
    elements = [
        {"type": "node", "id": i, "lat": 55.944703 + i * 0.001, "lon": -3.187417,
         "tags": {"leisure": "park", "name": f"Park {i}"}}
        for i in range(8)
    ]
    monkeypatch.setattr(
        "app.adapters.greenspace._fetch_json", lambda url: {"elements": elements}
    )
    envelope = greenspace_adapter.fetch(**COORDS)
    assert envelope["status"] == "ok"
    assert len(envelope["data"]) == 5
    # Nearest first: Park 0 is at the community coordinates themselves.
    assert envelope["data"][0]["name"] == "Park 0"
    distances = [s["distance_km"] for s in envelope["data"]]
    assert distances == sorted(distances)


def test_greenspace_fetch_empty_answer_is_ok_with_empty_list(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.greenspace._fetch_json", lambda url: {"elements": []}
    )
    envelope = greenspace_adapter.fetch(**COORDS)
    assert envelope["status"] == "ok"
    assert envelope["data"] == []


def test_greenspace_fetch_http_failure_is_unavailable_not_raise(monkeypatch):
    def down(url: str) -> dict:
        raise OSError("network unreachable")

    monkeypatch.setattr("app.adapters.greenspace._fetch_json", down)
    envelope = greenspace_adapter.fetch(**COORDS)  # must not raise
    assert envelope["status"] == "unavailable"
    assert envelope["data"] is None


def test_greenspace_haversine_matches_c_reference():
    # C's reference implementation: ~1 degree of latitude ≈ 111.19 km.
    assert greenspace_adapter.haversine_distance_km(55.0, -3.0, 56.0, -3.0) == 111.19
    assert greenspace_adapter.haversine_distance_km(55.0, -3.0, 55.0, -3.0) == 0.0


# --- postcode ---------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


def test_postcode_fetch_ok_envelope(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.postcode.httpx.get",
        lambda url, **kwargs: _FakeResponse(
            200,
            {
                "status": 200,
                "result": {
                    "postcode": "EH8 9AB",
                    "outcode": "EH8",
                    "latitude": 55.944703,
                    "longitude": -3.187417,
                    "country": "Scotland",
                },
            },
        ),
    )
    envelope = postcode_adapter.fetch("  eh8 9ab ")
    assert envelope["provider"] == "postcodes_io"
    assert envelope["status"] == "ok"
    assert envelope["data"] == {
        "postcode": "EH8 9AB",
        "outcode": "EH8",
        "latitude": 55.944703,
        "longitude": -3.187417,
        "country": "Scotland",
    }
    assert envelope["fetched_at"] is not None
    assert envelope["source"] == "postcodes.io"
    assert envelope["source_url"] == "https://postcodes.io/"
    assert envelope["attribution"] == "Powered by postcodes.io"


def test_postcode_fetch_404_raises_not_found(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.postcode.httpx.get",
        lambda url, **kwargs: _FakeResponse(404, {"status": 404}),
    )
    with pytest.raises(PostcodeNotFoundError):
        postcode_adapter.fetch("ZZ99 9ZZ")


def test_postcode_fetch_non_200_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.postcode.httpx.get",
        lambda url, **kwargs: _FakeResponse(500, {}),
    )
    envelope = postcode_adapter.fetch("EH8 9AB")
    assert envelope["status"] == "unavailable"
    assert envelope["data"] is None


def test_postcode_fetch_network_error_is_unavailable(monkeypatch):
    def down(url, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("app.adapters.postcode.httpx.get", down)
    envelope = postcode_adapter.fetch("EH8 9AB")  # must not raise
    assert envelope["status"] == "unavailable"


def test_postcode_fetch_malformed_body_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        "app.adapters.postcode.httpx.get",
        lambda url, **kwargs: _FakeResponse(200, {"result": {"postcode": "EH8 9AB"}}),
    )
    envelope = postcode_adapter.fetch("EH8 9AB")
    assert envelope["status"] == "unavailable"


def test_envelope_rejects_invalid_status():
    with pytest.raises(ValueError):
        AdapterEnvelope(provider="x", status="bogus")
