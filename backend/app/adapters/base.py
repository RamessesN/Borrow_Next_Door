"""Adapter protocol and unified provider envelope shape (component C).

This module only defines the contract. Concrete adapters that perform real
external HTTP calls (postcodes.io, carbon intensity, Open-Meteo, Overpass)
are implemented by task C in a follow-up; this foundation release performs
no external HTTP requests.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

# status values an adapter envelope may carry
ADAPTER_STATUSES = ("ok", "not_implemented", "unavailable")


class AdapterEnvelope(dict):
    """Envelope shape shared by all provider adapters.

    Fields:
        provider:      provider slug, e.g. "postcodes_io"
        status:        "ok" | "not_implemented" | "unavailable"
        data:          provider-specific payload (None unless status == ok)
        source:        human-readable source name
        source_url:    canonical documentation / endpoint URL
        attribution:   attribution text shown in the UI
        fetched_at:    epoch seconds when the payload was fetched
        valid_time_from / valid_to: data validity window (epoch seconds, nullable)
        fresh_until:   epoch seconds until which the cache entry is fresh
        stale_until:   epoch seconds until which the cache entry may be served stale
    """

    def __init__(
        self,
        provider: str,
        status: str = "not_implemented",
        data: Any = None,
        source: str = "",
        source_url: str = "",
        attribution: str = "",
        fetched_at: int | None = None,
        valid_time_from: int | None = None,
        valid_time_to: int | None = None,
        fresh_until: int | None = None,
        stale_until: int | None = None,
    ) -> None:
        if status not in ADAPTER_STATUSES:
            raise ValueError(f"invalid adapter status: {status!r}")
        super().__init__(
            provider=provider,
            status=status,
            data=data,
            source=source,
            source_url=source_url,
            attribution=attribution,
            fetched_at=fetched_at,
            valid_time_from=valid_time_from,
            valid_time_to=valid_time_to,
            fresh_until=fresh_until,
            stale_until=stale_until,
        )


@runtime_checkable
class ProviderAdapter(Protocol):
    """Protocol every external data adapter must implement."""

    provider: str

    def fetch(self, *args: Any, **kwargs: Any) -> AdapterEnvelope:
        """Return an AdapterEnvelope. Never raise for upstream failures:
        return status="unavailable" instead."""
        ...


class NotImplementedAdapter:
    """Placeholder adapter used until task C wires up real HTTP calls."""

    def __init__(self, provider: str) -> None:
        self.provider = provider

    def fetch(self, *args: Any, **kwargs: Any) -> AdapterEnvelope:
        return AdapterEnvelope(
            provider=self.provider,
            status="not_implemented",
            source="",
            source_url="",
            attribution="",
        )
