"""Carbon intensity provider adapter (ported from C's get_carbon_intensity).

Live source: NESO (National Grid ESO) Carbon Intensity API,
``GET https://api.carbonintensity.org.uk/regional/postcode/{outcode}``
regional endpoint. Parsing logic (clean-energy percentage over the
generation mix, top source, validity window) is C's, re-implemented on
httpx with the B envelope contract:

    fetch(*, postcode, outcode, latitude, longitude) -> AdapterEnvelope

- status "ok"          -> data = {index, forecast, unit, clean_energy_percentage,
                                 top_source, source, scope, timestamp}
- status "unavailable" -> network error / timeout / non-200 / malformed body;
  the adapter never raises for upstream failures.

HTTP always happens inside the adapter, outside any transaction, with a
short timeout. The service layer owns caching and the demo-fixture
fallback; this module only talks to the upstream API.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from app.adapters.base import AdapterEnvelope
from app.db import utc_now

PROVIDER = "carbon_intensity"
SOURCE = "NESO Carbon Intensity API (National Grid ESO)"
SOURCE_URL = "https://carbon-intensity.github.io/api-definitions/"
ATTRIBUTION = "UK carbon intensity data from National Grid ESO"
ENDPOINT_TEMPLATE = "https://api.carbonintensity.org.uk/regional/postcode/{outcode}"
TIMEOUT_SECONDS = 3.5
USER_AGENT = "BorrowNextDoor-AdaHack/1.0 (greener-postcode-community)"

# Fuels C counts towards the clean-energy percentage.
_CLEAN_FUELS = {"wind", "solar", "hydro", "nuclear", "biomass"}


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


def _parse_iso_to_epoch(value: object) -> int | None:
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


def _parse(payload: dict, outcode: str) -> tuple[dict, object, object] | None:
    """C's NESO regional-postcode parsing; None when the body is malformed.

    Returns (data, valid_from, valid_to) with the raw ISO timestamps.
    """
    try:
        region_data = payload["data"][0]
        intensity_info = region_data["data"][0]
        intensity = intensity_info["intensity"]
        gen_mix = intensity_info["generationmix"]
        forecast = intensity["forecast"]
        index = intensity["index"]
        valid_from = intensity_info["from"]
        valid_to = intensity_info["to"]
    except (KeyError, IndexError, TypeError):
        return None
    if not isinstance(forecast, int) or not isinstance(index, str):
        return None

    clean_pct = sum(
        item["perc"] for item in gen_mix if item.get("fuel") in _CLEAN_FUELS
    )
    top_fuel = (
        max(gen_mix, key=lambda x: x["perc"])
        if gen_mix
        else {"fuel": "Wind", "perc": 50}
    )

    data = {
        "index": index,
        "forecast": forecast,
        "unit": "gCO2/kWh",
        "clean_energy_percentage": round(clean_pct, 1),
        "top_source": f"{top_fuel['fuel'].title()} ({top_fuel['perc']}%)",
        "source": SOURCE,
        "scope": f"Regional grid zone ({outcode})",
        "timestamp": valid_to,
    }
    return data, valid_from, valid_to


def fetch(
    *,
    postcode: str,
    outcode: str,
    latitude: float,
    longitude: float,
) -> AdapterEnvelope:
    """Regional carbon intensity for the community's outcode (never raises)."""
    _ = postcode, latitude, longitude  # regional lookup keys on the outcode
    clean_outcode = (outcode or "").strip().upper()
    url = ENDPOINT_TEMPLATE.format(outcode=clean_outcode)
    try:
        payload = _fetch_json(url)
        parsed = _parse(payload, clean_outcode)
    except Exception:  # noqa: BLE001 - upstream failure -> unavailable, never raise
        return _unavailable()
    if parsed is None:
        return _unavailable()
    data, valid_from, valid_to = parsed

    return AdapterEnvelope(
        provider=PROVIDER,
        status="ok",
        data=data,
        source=SOURCE,
        source_url=SOURCE_URL,
        attribution=ATTRIBUTION,
        fetched_at=utc_now(),
        valid_time_from=_parse_iso_to_epoch(valid_from),
        valid_time_to=_parse_iso_to_epoch(valid_to),
    )
