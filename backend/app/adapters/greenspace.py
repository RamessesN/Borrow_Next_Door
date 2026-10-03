"""Greenspace provider adapter (ported from C's get_nearby_green_spaces).

Live source: OpenStreetMap Overpass API,
``GET https://overpass-api.de/api/interpreter`` with a park/garden query
bounded to ~1.5 km around the community coordinates. Parsing logic
(haversine distance, unnamed-element skip, distance sort, top-5 cap) is
C's, re-implemented on httpx with the B envelope contract:

    fetch(*, postcode, outcode, latitude, longitude) -> AdapterEnvelope

- status "ok"          -> data = [{id, name, type, distance_km, latitude,
                                 longitude, source}, ...] (possibly empty when
                         the upstream answers but has no named greenspaces)
- status "unavailable" -> network error / timeout / non-200 / malformed body;
  the adapter never raises for upstream failures.

HTTP always happens inside the adapter, outside any transaction, with a
short timeout. The service layer owns caching and the demo-fixture
fallback; this module only talks to the upstream API.
"""

from __future__ import annotations

import math
from urllib.parse import quote

import httpx

from app.adapters.base import AdapterEnvelope
from app.db import utc_now

PROVIDER = "greenspace"
SOURCE = "OpenStreetMap Overpass API"
SOURCE_URL = "https://overpass-api.de/api/interpreter"
ATTRIBUTION = "Green space data © OpenStreetMap contributors"
ENDPOINT = "https://overpass-api.de/api/interpreter?data={query}"
TIMEOUT_SECONDS = 4.0
USER_AGENT = "BorrowNextDoor-AdaHack/1.0 (greener-postcode-community)"
SEARCH_RADIUS_METERS = 1500
MAX_RESULTS = 5

_OVERPASS_QUERY = """
[out:json][timeout:3];
(
  node["leisure"="park"](around:{radius},{latitude},{longitude});
  way["leisure"="park"](around:{radius},{latitude},{longitude});
  node["leisure"="garden"](around:{radius},{latitude},{longitude});
);
out center {max_results};
"""


def _unavailable() -> AdapterEnvelope:
    return AdapterEnvelope(
        provider=PROVIDER,
        status="unavailable",
        data=None,
        source=SOURCE,
        source_url=SOURCE_URL,
        attribution=ATTRIBUTION,
    )


def _fetch_json(url: str) -> dict:
    """GET one JSON document with a short timeout (module-level for tests)."""
    response = httpx.get(
        url, timeout=TIMEOUT_SECONDS, headers={"User-Agent": USER_AGENT}
    )
    response.raise_for_status()
    return response.json()


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """C's approximate great-circle distance in kilometres."""
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(r * c, 2)


def _parse(payload: dict, latitude: float, longitude: float) -> list[dict]:
    """C's Overpass element parsing: named parks/gardens, nearest first."""
    elements = payload.get("elements")
    if not isinstance(elements, list):
        return []
    results: list[dict] = []
    for idx, el in enumerate(elements):
        if not isinstance(el, dict):
            continue
        tags = el.get("tags") or {}
        name = tags.get("name")
        if not name:
            continue
        el_lat = el.get("lat") or (el.get("center") or {}).get("lat")
        el_lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if not (
            isinstance(el_lat, (int, float)) and isinstance(el_lon, (int, float))
        ):
            continue
        results.append(
            {
                "id": f"osm-{el.get('id', idx)}",
                "name": name,
                "type": str(tags.get("leisure", "Park")).title(),
                "distance_km": haversine_distance_km(
                    latitude, longitude, el_lat, el_lon
                ),
                "latitude": el_lat,
                "longitude": el_lon,
                "source": SOURCE,
            }
        )
    results.sort(key=lambda x: x["distance_km"])
    return results[:MAX_RESULTS]


def fetch(
    *,
    postcode: str,
    outcode: str,
    latitude: float,
    longitude: float,
) -> AdapterEnvelope:
    """Named parks/gardens within ~1.5 km of the community (never raises)."""
    _ = postcode, outcode  # radius search keys on the coordinates
    query = _OVERPASS_QUERY.format(
        radius=SEARCH_RADIUS_METERS,
        latitude=latitude,
        longitude=longitude,
        max_results=MAX_RESULTS,
    )
    url = ENDPOINT.format(query=quote(query, safe=""))
    try:
        payload = _fetch_json(url)
        data = _parse(payload, latitude, longitude)
    except Exception:  # noqa: BLE001 - upstream failure -> unavailable, never raise
        return _unavailable()

    return AdapterEnvelope(
        provider=PROVIDER,
        status="ok",
        data=data,
        source=SOURCE,
        source_url=SOURCE_URL,
        attribution=ATTRIBUTION,
        fetched_at=utc_now(),
    )
