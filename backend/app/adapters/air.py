"""Air quality provider adapter (ported from C's get_air_quality).

Live source: Open-Meteo Air Quality API,
``GET https://air-quality-api.open-meteo.com/v1/air-quality`` with
``current=european_aqi,pm10,pm2_5``. Parsing logic (European AQI status
label thresholds, validity window from the model timestamp) is C's,
re-implemented on httpx with the B envelope contract:

    fetch(*, postcode, outcode, latitude, longitude) -> AdapterEnvelope

- status "ok"          -> data = {status, aqi, pm2_5, pm10, source, scope, timestamp}
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

PROVIDER = "air_quality"
SOURCE = "Open-Meteo Air Quality (11km regional grid forecast)"
SOURCE_URL = "https://open-meteo.com/en/docs/air-quality-api"
ATTRIBUTION = "European air quality index from Open-Meteo"
ENDPOINT_TEMPLATE = (
    "https://air-quality-api.open-meteo.com/v1/air-quality"
    "?latitude={latitude}&longitude={longitude}"
    "&current=european_aqi,pm10,pm2_5"
)
TIMEOUT_SECONDS = 3.5
USER_AGENT = "BorrowNextDoor-AdaHack/1.0 (greener-postcode-community)"


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


def _status_label(aqi: float) -> str:
    """C's European AQI banding."""
    if aqi <= 20:
        return "Good"
    if aqi <= 40:
        return "Fair"
    if aqi <= 60:
        return "Moderate"
    if aqi <= 80:
        return "Poor"
    return "Very Poor"


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
        # Open-Meteo returns the model timestamp without an offset; the
        # default timezone for the air-quality API is UTC.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _parse(payload: dict) -> dict | None:
    """C's Open-Meteo current-conditions parsing; None when malformed."""
    try:
        current = payload["current"]
        aqi = current["european_aqi"]
        pm2_5 = current["pm2_5"]
        pm10 = current["pm10"]
        timestamp = current["time"]
        interval = current.get("interval", 3600)
    except (KeyError, TypeError):
        return None
    if not isinstance(aqi, (int, float)):
        return None

    return {
        "status": _status_label(aqi),
        "aqi": aqi,
        "pm2_5": pm2_5,
        "pm10": pm10,
        "source": SOURCE,
        "scope": "Regional forecast (~11km grid)",
        "timestamp": timestamp,
        "_interval": interval if isinstance(interval, int) else 3600,
    }


def fetch(
    *,
    postcode: str,
    outcode: str,
    latitude: float,
    longitude: float,
) -> AdapterEnvelope:
    """Current European AQI / particulate reading for the coordinates."""
    _ = postcode, outcode  # gridded lookup keys on the coordinates
    url = ENDPOINT_TEMPLATE.format(latitude=latitude, longitude=longitude)
    try:
        payload = _fetch_json(url)
        data = _parse(payload)
    except Exception:  # noqa: BLE001 - upstream failure -> unavailable, never raise
        return _unavailable()
    if data is None:
        return _unavailable()

    interval = data.pop("_interval")
    valid_from = _parse_iso_to_epoch(data["timestamp"])
    valid_to = valid_from + interval if valid_from is not None else None

    return AdapterEnvelope(
        provider=PROVIDER,
        status="ok",
        data=data,
        source=SOURCE,
        source_url=SOURCE_URL,
        attribution=ATTRIBUTION,
        fetched_at=utc_now(),
        valid_time_from=valid_from,
        valid_time_to=valid_to,
    )
