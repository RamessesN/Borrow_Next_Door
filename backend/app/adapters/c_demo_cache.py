"""Offline demo fixture cache ported from C's ``services/demo_cache.py``.

C shipped a small curated snapshot for the hackathon demo postcodes so the
UI always has presentation-grade data even when every external API is
unreachable. B keeps the same idea but labels it honestly: payloads from
this module are served with ``source_kind="fixture"`` by the service layer
and are never mistaken for live adapter answers.

Keys are normalised compact postcodes (no spaces, upper case), matching
C's ``normalize_postcode``. C's origin/main data covered EH14 4AS and
EH1 1YZ (its docstring also advertised EH8 9YL); the EH8 9YL entry below
completes that advertised set for the University of Edinburgh / George
Square area, in the same shape as C's entries. The EH8 9AB entry gives the
seeded home community an honest offline fallback (still served with
``source_kind="fixture"``, never "live"), so the demo renders without
live Overpass / Open-Meteo / NESO. The other seeded community, EH16 5AA,
is deliberately left fixture-free so the degraded / no-fixture path stays
covered by the backend tests.
"""

from __future__ import annotations

from datetime import datetime, timezone

# Curated fixture snapshots (ported from C, EH8 9YL entry completed).
DEMO_CACHE: dict[str, dict] = {
    "EH144AS": {
        "postcode": "EH14 4AS",
        "location": {
            "district": "City of Edinburgh",
            "parish": "Currie Community",
            "outcode": "EH14",
            "latitude": 55.9092,
            "longitude": -3.3193,
            "description": "Heriot-Watt / Riccarton Community",
        },
        "air_quality": {
            "status": "Good",
            "aqi": 19,
            "pm2_5": 4.1,
            "pm10": 7.8,
            "source": "Open-Meteo Air Quality (11km regional grid forecast)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "carbon_intensity": {
            "index": "very low",
            "forecast": 38,
            "unit": "gCO2/kWh",
            "clean_energy_percentage": 76.5,
            "top_source": "Wind (62.3%)",
            "source": "NESO Carbon Intensity API (National Grid ESO)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "green_spaces": [
            {
                "id": "hw-riccarton-grounds",
                "name": "Riccarton Estate & Campus Loch",
                "type": "Nature Reserve & Grounds",
                "distance_km": 0.2,
                "latitude": 55.9100,
                "longitude": -3.3210,
            },
            {
                "id": "currie-comm-park",
                "name": "Currie Community Park",
                "type": "Public Park",
                "distance_km": 1.1,
                "latitude": 55.8985,
                "longitude": -3.3150,
            },
            {
                "id": "water-of-leith-currie",
                "name": "Water of Leith Walkway (Currie Section)",
                "type": "River Walkway & Green Corridor",
                "distance_km": 1.4,
                "latitude": 55.8970,
                "longitude": -3.3080,
            },
            {
                "id": "baberton-mains-park",
                "name": "Baberton Mains Park",
                "type": "Local Grassland & Recreation",
                "distance_km": 1.8,
                "latitude": 55.9080,
                "longitude": -3.2920,
            },
        ],
    },
    "EH11YZ": {
        "postcode": "EH1 1YZ",
        "location": {
            "district": "City of Edinburgh",
            "parish": "City Centre",
            "outcode": "EH1",
            "latitude": 55.9525,
            "longitude": -3.1895,
            "description": "Edinburgh Old Town / Waverley Community",
        },
        "air_quality": {
            "status": "Fair",
            "aqi": 28,
            "pm2_5": 7.3,
            "pm10": 13.5,
            "source": "Open-Meteo Air Quality (11km regional grid forecast)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "carbon_intensity": {
            "index": "low",
            "forecast": 42,
            "unit": "gCO2/kWh",
            "clean_energy_percentage": 71.0,
            "top_source": "Wind (55.0%)",
            "source": "NESO Carbon Intensity API (National Grid ESO)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "green_spaces": [
            {
                "id": "princes-st-gardens",
                "name": "Princes Street Gardens",
                "type": "Public Urban Park",
                "distance_km": 0.4,
                "latitude": 55.9508,
                "longitude": -3.1970,
            },
            {
                "id": "calton-hill",
                "name": "Calton Hill Park",
                "type": "Historic Green Hill",
                "distance_km": 0.6,
                "latitude": 55.9554,
                "longitude": -3.1829,
            },
            {
                "id": "holyrood-park",
                "name": "Holyrood Park",
                "type": "Royal Natural Park",
                "distance_km": 1.2,
                "latitude": 55.9510,
                "longitude": -3.1670,
            },
            {
                "id": "the-meadows",
                "name": "The Meadows",
                "type": "Community Green Space",
                "distance_km": 1.3,
                "latitude": 55.9412,
                "longitude": -3.1925,
            },
        ],
    },
    "EH89YL": {
        "postcode": "EH8 9YL",
        "location": {
            "district": "City of Edinburgh",
            "parish": "University of Edinburgh / George Square",
            "outcode": "EH8",
            "latitude": 55.9443,
            "longitude": -3.1880,
            "description": "University of Edinburgh / George Square Community",
        },
        "air_quality": {
            "status": "Fair",
            "aqi": 26,
            "pm2_5": 6.4,
            "pm10": 11.9,
            "source": "Open-Meteo Air Quality (11km regional grid forecast)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "carbon_intensity": {
            "index": "low",
            "forecast": 40,
            "unit": "gCO2/kWh",
            "clean_energy_percentage": 73.4,
            "top_source": "Wind (58.1%)",
            "source": "NESO Carbon Intensity API (National Grid ESO)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "green_spaces": [
            {
                "id": "george-square-gardens",
                "name": "George Square Gardens",
                "type": "Public Urban Park",
                "distance_km": 0.1,
                "latitude": 55.9441,
                "longitude": -3.1887,
            },
            {
                "id": "the-meadows",
                "name": "The Meadows",
                "type": "Community Green Space",
                "distance_km": 0.6,
                "latitude": 55.9412,
                "longitude": -3.1925,
            },
            {
                "id": "bristo-square",
                "name": "Bristo Square",
                "type": "Civic Square & Green",
                "distance_km": 0.3,
                "latitude": 55.9450,
                "longitude": -3.1900,
            },
        ],
    },
    "EH89AB": {
        "postcode": "EH8 9AB",
        "location": {
            "district": "City of Edinburgh",
            "parish": "University of Edinburgh / Southside",
            "outcode": "EH8",
            "latitude": 55.944703,
            "longitude": -3.187417,
            "description": "University of Edinburgh / Southside Community",
        },
        "air_quality": {
            "status": "Fair",
            "aqi": 26,
            "pm2_5": 6.4,
            "pm10": 11.9,
            "source": "Open-Meteo Air Quality (11km regional grid forecast)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        "carbon_intensity": {
            "index": "low",
            "forecast": 40,
            "unit": "gCO2/kWh",
            "clean_energy_percentage": 73.4,
            "top_source": "Wind (58.1%)",
            "source": "NESO Carbon Intensity API (National Grid ESO)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True,
        },
        # Real Overpass coordinates for central Edinburgh green spaces, with
        # straight-line distances from the seeded EH8 9AB community
        # (55.944703, -3.187417). Field shape matches the other entries.
        "green_spaces": [
            {
                "id": "george-square-gardens",
                "name": "George Square Gardens",
                "type": "Public Urban Park",
                "distance_km": 0.1,
                "latitude": 55.9441,
                "longitude": -3.1887,
            },
            {
                "id": "bristo-square",
                "name": "Bristo Square",
                "type": "Civic Square & Green",
                "distance_km": 0.2,
                "latitude": 55.9450,
                "longitude": -3.1900,
            },
            {
                "id": "the-meadows",
                "name": "The Meadows",
                "type": "Community Green Space",
                "distance_km": 0.5,
                "latitude": 55.9412,
                "longitude": -3.1925,
            },
            {
                "id": "princes-street-gardens",
                "name": "Princes Street Gardens",
                "type": "Public Urban Park",
                "distance_km": 0.9,
                "latitude": 55.9508,
                "longitude": -3.1970,
            },
            {
                "id": "holyrood-park",
                "name": "Holyrood Park",
                "type": "Royal Natural Park",
                "distance_km": 1.5,
                "latitude": 55.9510,
                "longitude": -3.1670,
            },
        ],
    },
}

# Per-provider source metadata for fixture sections. The fixture payloads
# themselves carry C's original "source" strings; these add the canonical
# documentation URLs and an honest "demo fixture snapshot" attribution.
PROVIDER_META: dict[str, tuple[str, str, str]] = {
    "carbon_intensity": (
        "NESO Carbon Intensity API (National Grid ESO)",
        "https://carbon-intensity.github.io/api-definitions/",
        "UK carbon intensity (National Grid ESO) — demo fixture snapshot, not live.",
    ),
    "air_quality": (
        "Open-Meteo Air Quality (11km regional grid forecast)",
        "https://open-meteo.com/en/docs/air-quality-api",
        "European AQI from Open-Meteo — demo fixture snapshot, not live.",
    ),
    "greenspace": (
        "OpenStreetMap Overpass API",
        "https://overpass-api.de/api/interpreter",
        "Green spaces © OpenStreetMap contributors — demo fixture snapshot, not live.",
    ),
}

_PROVIDER_PAYLOAD_KEY = {
    "carbon_intensity": "carbon_intensity",
    "air_quality": "air_quality",
    "greenspace": "green_spaces",
}


def normalize_key(postcode: str) -> str:
    """C's normalisation: strip, drop internal spaces, uppercase."""
    if not postcode:
        return ""
    return postcode.strip().replace(" ", "").upper()


def _parse_iso_to_epoch(value: object) -> int | None:
    """Parse an ISO-8601 timestamp (Z or offset suffix) to epoch seconds."""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def lookup(postcode: str) -> dict | None:
    """Whole fixture entry for a postcode, or None when not a demo postcode."""
    return DEMO_CACHE.get(normalize_key(postcode))


def fixture_section(postcode: str, provider: str) -> dict | None:
    """Provider-specific fixture payload plus source metadata.

    Returns None when the postcode is not in the demo cache or the entry
    carries no payload for the provider. ``fetched_at`` is the fixture
    snapshot timestamp when one is present, else None.
    """
    entry = lookup(postcode)
    if entry is None:
        return None
    data = entry.get(_PROVIDER_PAYLOAD_KEY.get(provider, ""))
    if data is None:
        return None
    source, source_url, attribution = PROVIDER_META[provider]
    fetched_at = _parse_iso_to_epoch(
        (entry.get("air_quality") or {}).get("timestamp")
    ) or _parse_iso_to_epoch(
        (entry.get("carbon_intensity") or {}).get("timestamp")
    )
    return {
        "data": data,
        "source": source,
        "source_url": source_url,
        "attribution": attribution,
        "fetched_at": fetched_at,
    }
