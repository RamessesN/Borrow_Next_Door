"""Environment section aggregation and external_cache orchestration (spec 8.2).

Division of ownership:
- Task C owns the external HTTP adapters (`app/adapters/{carbon,air,greenspace}.py`);
  each returns an `AdapterEnvelope` and must never raise.
- This module (task B) owns the `external_cache` table read/write, the
  fresh/stale fallback rules and the per-provider envelope aggregation that
  GET /communities/{id}/environment returns.

Rules:
- every provider section is built independently; one provider failing never
  breaks the others (all adapter calls are additionally guarded).
- HTTP always happens before any transaction: cache reads use plain short
  reads, cache writes open their own BEGIN IMMEDIATE transaction afterwards.
- a fresh cache entry short-circuits the adapter call; a stale (but not
  expired) entry is served when the adapter cannot deliver; an expired entry
  is ignored.
- data served from cache is labelled source_kind="cached" (fixture-labelled
  payloads stay "fixture"); only a successful live adapter answer gets "live".
- when the adapter cannot deliver and no cache entry exists, the hackathon
  demo postcodes fall back to C's curated fixture snapshot
  (``app/adapters/c_demo_cache.py``), served with source_kind="fixture".
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

from app.adapters import air as air_adapter
from app.adapters import c_demo_cache
from app.adapters import carbon as carbon_adapter
from app.adapters import greenspace as greenspace_adapter
from app.adapters.base import ADAPTER_STATUSES, AdapterEnvelope
from app.db import connection, epoch_to_iso, utc_now, write_transaction
from app.errors import AppError

logger = logging.getLogger("borrow_next_door.environment")

# Section key -> adapter module. C replaces the modules, not this mapping.
ENV_PROVIDERS: tuple[tuple[str, Any], ...] = (
    ("carbon_intensity", carbon_adapter),
    ("air_quality", air_adapter),
    ("greenspace", greenspace_adapter),
)

# Cache lifetimes in seconds, used when an adapter does not supply its own.
FRESH_TTL: dict[str, int] = {
    "carbon_intensity": 1800,   # half-hourly intensity data
    "air_quality": 3600,        # hourly model output
    "greenspace": 86400,        # OSM snapshot, one day
}
STALE_TTL: dict[str, int] = {
    "carbon_intensity": 7200,
    "air_quality": 21600,
    "greenspace": 604800,
}
CACHE_SCHEMA_VERSION = "1"

POSTCODE_PROVIDER = "postcodes_io"
POSTCODE_SOURCE_URL = "https://postcodes.io/"


def cache_key(provider: str, outcode: str) -> str:
    """external_cache key for one provider within an outcode area."""
    return f"env:{provider}:{outcode}"


# --- cache access -----------------------------------------------------------


def _read_cache(conn: sqlite3.Connection, provider: str, outcode: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM external_cache WHERE cache_key = ? AND provider = ?",
        (cache_key(provider, outcode), provider),
    ).fetchone()


def _lifetimes(provider: str, envelope: dict, now: int) -> tuple[int, int, int]:
    """(fetched_at, fresh_until, stale_until) for a live adapter answer."""
    fetched = envelope.get("fetched_at")
    if not isinstance(fetched, int):
        fetched = now
    fresh = envelope.get("fresh_until")
    if not isinstance(fresh, int):
        fresh = fetched + FRESH_TTL.get(provider, 3600)
    stale = envelope.get("stale_until")
    if not isinstance(stale, int):
        stale = fetched + STALE_TTL.get(provider, 86400)
    return fetched, fresh, max(stale, fresh)


def _write_cache(provider: str, community_row: sqlite3.Row, envelope: dict, now: int) -> None:
    """Persist a successful live answer (own short transaction, after HTTP)."""
    fetched, fresh, stale = _lifetimes(provider, envelope, now)
    payload = envelope.get("data")
    try:
        payload_json = json.dumps(
            payload if payload is not None else {}, ensure_ascii=False
        )
    except (TypeError, ValueError):
        logger.warning("Non-JSON payload for provider %s; cache write skipped", provider)
        return
    try:
        with connection() as conn:
            with write_transaction(conn):
                conn.execute(
                    "INSERT INTO external_cache "
                    "(cache_key, provider, schema_version, payload_json, "
                    " source_url, attribution, source_kind, fetched_at, "
                    " valid_time_from, valid_time_to, fresh_until, stale_until) "
                    "VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?) "
                    "ON CONFLICT(cache_key) DO UPDATE SET "
                    "payload_json = excluded.payload_json, "
                    "source_url = excluded.source_url, "
                    "attribution = excluded.attribution, "
                    "source_kind = excluded.source_kind, "
                    "fetched_at = excluded.fetched_at, "
                    "valid_time_from = excluded.valid_time_from, "
                    "valid_time_to = excluded.valid_time_to, "
                    "fresh_until = excluded.fresh_until, "
                    "stale_until = excluded.stale_until",
                    (
                        cache_key(provider, community_row["outcode"]),
                        provider,
                        CACHE_SCHEMA_VERSION,
                        payload_json,
                        str(envelope.get("source_url") or ""),
                        str(envelope.get("attribution") or ""),
                        fetched,
                        _as_int_or_none(envelope.get("valid_time_from")),
                        _as_int_or_none(envelope.get("valid_time_to")),
                        fresh,
                        stale,
                    ),
                )
    except sqlite3.Error:  # pragma: no cover - defensive: never fail the read
        logger.warning("external_cache write failed for provider %s", provider, exc_info=True)


def _as_int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _iso(value: object) -> str | None:
    return epoch_to_iso(value) if isinstance(value, int) and not isinstance(value, bool) else None


# --- section builders -------------------------------------------------------


def _safe_fetch(module: Any, community_row: sqlite3.Row) -> dict:
    """Call an adapter without ever letting it break the response."""
    provider = str(getattr(module, "PROVIDER", "") or getattr(module, "__name__", "unknown"))
    try:
        envelope = module.fetch(
            postcode=community_row["postcode"],
            outcode=community_row["outcode"],
            latitude=community_row["latitude"],
            longitude=community_row["longitude"],
        )
    except Exception:  # noqa: BLE001 - one broken provider must not sink the rest
        logger.warning("Adapter %s raised", provider, exc_info=True)
        return dict(AdapterEnvelope(provider=provider, status="unavailable"))
    if not isinstance(envelope, dict) or envelope.get("status") not in ADAPTER_STATUSES:
        return dict(AdapterEnvelope(provider=provider, status="unavailable"))
    return dict(envelope)


def _from_adapter(envelope: dict) -> dict:
    """Section dict for an adapter answer that is not ok (no data to show)."""
    status = envelope.get("status")
    if status not in ("not_implemented", "unavailable"):
        status = "unavailable"
    return {
        "provider": str(envelope.get("provider") or ""),
        "status": status,
        "data": None,
        "source_kind": None,
        "source": str(envelope.get("source") or ""),
        "source_url": str(envelope.get("source_url") or ""),
        "attribution": str(envelope.get("attribution") or ""),
        "fetched_at": _iso(envelope.get("fetched_at")),
        "valid_time_from": _iso(envelope.get("valid_time_from")),
        "valid_time_to": _iso(envelope.get("valid_time_to")),
        "fresh_until": None,
        "stale_until": None,
    }


def _from_live(provider: str, envelope: dict, now: int) -> dict:
    """Section dict for a fresh successful live adapter answer."""
    fetched, fresh, stale = _lifetimes(provider, envelope, now)
    return {
        "provider": str(envelope.get("provider") or provider),
        "status": "ok",
        "data": envelope.get("data"),
        "source_kind": "live",
        "source": str(envelope.get("source") or ""),
        "source_url": str(envelope.get("source_url") or ""),
        "attribution": str(envelope.get("attribution") or ""),
        "fetched_at": _iso(fetched),
        "valid_time_from": _iso(envelope.get("valid_time_from")),
        "valid_time_to": _iso(envelope.get("valid_time_to")),
        "fresh_until": _iso(fresh),
        "stale_until": _iso(stale),
    }


def _from_cache(provider: str, row: sqlite3.Row) -> dict:
    """Section dict served from external_cache (never pretends to be live)."""
    try:
        data = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        data = None
    stored_kind = row["source_kind"]
    source_kind = "fixture" if stored_kind == "fixture" else "cached"
    return {
        "provider": str(row["provider"] or provider),
        "status": "cached",
        "data": data,
        "source_kind": source_kind,
        "source": str(row["source_url"] or ""),
        "source_url": str(row["source_url"] or ""),
        "attribution": str(row["attribution"] or ""),
        "fetched_at": _iso(row["fetched_at"]),
        "valid_time_from": _iso(row["valid_time_from"]),
        "valid_time_to": _iso(row["valid_time_to"]),
        "fresh_until": _iso(row["fresh_until"]),
        "stale_until": _iso(row["stale_until"]),
    }


def _from_fixture(provider: str, fixture: dict) -> dict:
    """Section dict served from C's demo fixture cache (never pretends live)."""
    return {
        "provider": provider,
        "status": "ok",
        "data": fixture.get("data"),
        "source_kind": "fixture",
        "source": str(fixture.get("source") or ""),
        "source_url": str(fixture.get("source_url") or ""),
        "attribution": str(fixture.get("attribution") or ""),
        "fetched_at": _iso(fixture.get("fetched_at")),
        "valid_time_from": None,
        "valid_time_to": None,
        "fresh_until": None,
        "stale_until": None,
    }


def _postcode_section(community_row: sqlite3.Row) -> dict:
    """The community's own location snapshot as a provider section."""
    is_fixture = community_row["source_kind"] == "fixture"
    return {
        "provider": POSTCODE_PROVIDER,
        "status": "ok",
        "data": {
            "postcode": community_row["postcode"],
            "outcode": community_row["outcode"],
            "latitude": community_row["latitude"],
            "longitude": community_row["longitude"],
            "country": community_row["country"],
        },
        "source_kind": community_row["source_kind"],
        "source": community_row["source"],
        "source_url": POSTCODE_SOURCE_URL,
        "attribution": (
            "Demo fixture snapshot; not a live lookup."
            if is_fixture
            else "Powered by postcodes.io"
        ),
        "fetched_at": _iso(community_row["fetched_at"]),
        "valid_time_from": None,
        "valid_time_to": None,
        "fresh_until": None,
        "stale_until": None,
    }


def _provider_section(
    provider: str,
    module: Any,
    community_row: sqlite3.Row,
    cache_row: sqlite3.Row | None,
    now: int,
) -> dict:
    # Fresh cache short-circuits the adapter call entirely.
    if (
        cache_row is not None
        and cache_row["fresh_until"] is not None
        and now <= cache_row["fresh_until"]
    ):
        return _from_cache(provider, cache_row)

    envelope = _safe_fetch(module, community_row)
    if envelope.get("status") == "ok":
        _write_cache(provider, community_row, envelope, now)
        return _from_live(provider, envelope, now)

    # Adapter not ok: serve a stale-but-not-expired entry when one exists.
    if (
        cache_row is not None
        and cache_row["stale_until"] is not None
        and now <= cache_row["stale_until"]
    ):
        return _from_cache(provider, cache_row)

    # Last resort for the hackathon demo postcodes: C's curated fixture
    # snapshot, honestly labelled source_kind="fixture" — never live.
    fixture = c_demo_cache.fixture_section(community_row["postcode"], provider)
    if fixture is not None:
        return _from_fixture(provider, fixture)

    return _from_adapter(envelope)


def _overall_status(sections: dict[str, dict]) -> str:
    """ok when every environment provider has data, partial when some do,
    unavailable when none do (the postcode section is always present)."""
    flags = [
        sections[provider]["status"] in ("ok", "cached")
        for provider, _ in ENV_PROVIDERS
    ]
    if all(flags):
        return "ok"
    if any(flags):
        return "partial"
    return "unavailable"


# --- entry point ------------------------------------------------------------


def get_environment(community_id: str) -> dict:
    """Build the environment payload for one existing community (spec 8.2)."""
    with connection() as conn:
        community_row = conn.execute(
            "SELECT * FROM communities WHERE id = ?", (community_id,)
        ).fetchone()
        if community_row is None:
            raise AppError("NOT_FOUND")
        now = utc_now()
        # Cache reads happen here, before any adapter HTTP call.
        cache_rows = {
            provider: _read_cache(conn, provider, community_row["outcode"])
            for provider, _ in ENV_PROVIDERS
        }

    sections: dict[str, dict] = {"postcode": _postcode_section(community_row)}
    for provider, module in ENV_PROVIDERS:
        sections[provider] = _provider_section(
            provider, module, community_row, cache_rows[provider], now
        )

    return {"status": _overall_status(sections), **sections}
