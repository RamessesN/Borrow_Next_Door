"""Minimal replaceable postcode adapter (spec 2: P0 fallback authorised for B).

Performs the one external lookup B owns until task C ships its adapter set:
``GET https://api.postcodes.io/postcodes/{postcode}`` with a short timeout.
Input normalisation (strip / drop spaces / uppercase) and display formatting
are absorbed from C's ``normalize_postcode`` / ``format_uk_postcode``.

Contract (identical shape to app/adapters/base.py):

    fetch(postcode: str) -> AdapterEnvelope

- status "ok"          -> data = {postcode, outcode, latitude, longitude, country}
- status "unavailable" -> network error / timeout / non-200 upstream answer
- raises PostcodeNotFoundError -> upstream answered 404 (postcode does not
  exist); the service layer maps this to 422 INVALID_POSTCODE.

Never performs database access. Task C may replace this module wholesale as
long as the `fetch` signature and envelope shape are kept.
"""

from __future__ import annotations

from urllib.parse import quote

import httpx

from app.adapters.base import AdapterEnvelope
from app.db import utc_now

PROVIDER = "postcodes_io"
SOURCE = "postcodes.io"
SOURCE_URL = "https://postcodes.io/"
ATTRIBUTION = "Powered by postcodes.io"
ENDPOINT_TEMPLATE = "https://api.postcodes.io/postcodes/{postcode}"
TIMEOUT_SECONDS = 3.0

_REQUIRED_FIELDS = ("postcode", "outcode", "latitude", "longitude", "country")


class PostcodeNotFoundError(LookupError):
    """Upstream authoritatively answered 404: the postcode does not exist."""

    def __init__(self, postcode: str) -> None:
        super().__init__(f"postcode not found upstream: {postcode}")
        self.postcode = postcode


def normalize_postcode(postcode: str) -> str:
    """C's normalisation: strip whitespace, drop internal spaces, uppercase."""
    if not postcode:
        return ""
    return postcode.strip().replace(" ", "").upper()


def format_uk_postcode(normalized: str) -> str:
    """C's display formatting: 'EH144AS' -> 'EH14 4AS'."""
    if len(normalized) > 3:
        return f"{normalized[:-3]} {normalized[-3:]}"
    return normalized


def _unavailable() -> AdapterEnvelope:
    return AdapterEnvelope(
        provider=PROVIDER,
        status="unavailable",
        data=None,
        source=SOURCE,
        source_url=SOURCE_URL,
        attribution=ATTRIBUTION,
    )


def fetch(postcode: str) -> AdapterEnvelope:
    """Look one postcode up on api.postcodes.io (never raises upstream errors)."""
    url = ENDPOINT_TEMPLATE.format(
        postcode=quote(normalize_postcode(postcode), safe="")
    )
    try:
        response = httpx.get(url, timeout=TIMEOUT_SECONDS)
    except httpx.HTTPError:
        # Network failure, timeout, DNS error, ... -> caller may fall back to
        # a previously verified cache row.
        return _unavailable()

    if response.status_code == 404:
        # Definitive upstream answer, not an outage.
        raise PostcodeNotFoundError(postcode)
    if response.status_code != 200:
        return _unavailable()

    try:
        result = response.json().get("result") or {}
        if any(result.get(field) is None for field in _REQUIRED_FIELDS):
            return _unavailable()
        data = {
            "postcode": str(result["postcode"]),
            "outcode": str(result["outcode"]),
            "latitude": float(result["latitude"]),
            "longitude": float(result["longitude"]),
            "country": str(result["country"]),
        }
    except (AttributeError, TypeError, ValueError):
        # Malformed body or JSON decode failure.
        return _unavailable()

    if not (-90.0 <= data["latitude"] <= 90.0 and -180.0 <= data["longitude"] <= 180.0):
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
