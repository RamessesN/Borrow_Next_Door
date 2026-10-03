"""Postcode -> community resolution and persistence (spec 4.3 / 8.2).

Flow for GET /communities/resolve:

1. trim, uppercase, collapse whitespace; quick regex pre-check (422 on
   shape failure) — the regex is only a fast reject, never the authority.
2. a previously verified `communities` row (seed fixture or an earlier
   resolve) confirms the postcode without another upstream call.
3. otherwise call the replaceable postcode adapter (HTTP, no transaction
   open yet); on success upsert `communities` with source_kind="live" and
   snapshot the payload into `external_cache`, all inside one short
   BEGIN IMMEDIATE transaction.
4. on upstream failure fall back to a verified `external_cache` row and
   upsert with source_kind="cached"; for the hackathon demo postcodes a
   curated fixture snapshot (C's demo cache) is upserted with
   source_kind="fixture"; without any of these -> 503 UPSTREAM_UNAVAILABLE.
   Upstream 404 -> 422 INVALID_POSTCODE.

Resolving a postcode never touches `users`: the caller's identity and home
community stay unchanged (spec 4.3).
"""

from __future__ import annotations

import json
import re
import sqlite3
import uuid

from app.adapters import c_demo_cache
from app.adapters import postcode as postcode_adapter
from app.adapters.postcode import PostcodeNotFoundError
from app.db import connection, epoch_to_iso, utc_now, write_transaction
from app.errors import AppError

POSTCODE_PROVIDER = "postcodes_io"
POSTCODE_SOURCE_URL = "https://postcodes.io/"
POSTCODE_ATTRIBUTION = "Powered by postcodes.io"
POSTCODE_CACHE_SCHEMA_VERSION = "1"

# Lifetimes for verified postcode snapshots kept in external_cache.
POSTCODE_FRESH_TTL = 86400         # 24 h
POSTCODE_STALE_TTL = 30 * 86400    # 30 days

_WHITESPACE_RE = re.compile(r"\s+")
# Fast shape pre-check only (spec 4.3): final validity comes from the
# upstream answer or from a previously verified cache row.
_COMPACT_RE = re.compile(r"^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$")

_PAYLOAD_FIELDS = ("postcode", "outcode", "latitude", "longitude", "country")


def normalize_postcode(raw: str) -> str:
    """Trim, uppercase and collapse internal whitespace."""
    return _WHITESPACE_RE.sub(" ", (raw or "").strip()).upper()


def _to_canonical(compact: str) -> str:
    """Insert the single space before the inward code: EH89AB -> EH8 9AB."""
    if compact == "GIR0AA":
        return "GIR 0AA"
    return f"{compact[:-3]} {compact[-3:]}"


def precheck(raw: str) -> str:
    """Normalise and format, raising INVALID_POSTCODE on a shape mismatch."""
    compact = normalize_postcode(raw).replace(" ", "")
    if not compact or not _COMPACT_RE.match(compact):
        raise AppError("INVALID_POSTCODE")
    return _to_canonical(compact)


def postcode_cache_key(postcode: str) -> str:
    """external_cache key for a verified postcode snapshot."""
    return f"postcode:{postcode}"


def community_dict(row: sqlite3.Row) -> dict:
    """CommunityResponse-shaped dict from a communities row."""
    return {
        "id": row["id"],
        "postcode": row["postcode"],
        "outcode": row["outcode"],
        "latitude": row["latitude"],
        "longitude": row["longitude"],
        "country": row["country"],
        "source": row["source"],
        "source_kind": row["source_kind"],
        "fetched_at": epoch_to_iso(row["fetched_at"]),
    }


def _validated_payload(data: object, postcode: str) -> dict | None:
    """Coerce upstream/cache fields into the communities row shape; None if bad."""
    if not isinstance(data, dict):
        return None
    try:
        outcode = str(data["outcode"]).strip().upper()
        latitude = float(data["latitude"])
        longitude = float(data["longitude"])
        country = str(data["country"]).strip()
    except (KeyError, TypeError, ValueError):
        return None
    if not outcode or not country:
        return None
    if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
        return None
    return {
        "postcode": postcode,
        "outcode": outcode,
        "latitude": latitude,
        "longitude": longitude,
        "country": country,
    }


def _read_postcode_cache(conn: sqlite3.Connection, postcode: str, now: int) -> dict | None:
    """Verified external_cache snapshot, or None when missing/expired/bad."""
    row = conn.execute(
        "SELECT payload_json, fetched_at, fresh_until, stale_until "
        "FROM external_cache WHERE cache_key = ? AND provider = ?",
        (postcode_cache_key(postcode), POSTCODE_PROVIDER),
    ).fetchone()
    if row is None:
        return None
    stale_until = row["stale_until"]
    if stale_until is not None and now > stale_until:
        return None  # cache window fully expired: not a confirmation any more
    try:
        payload = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        return None
    validated = _validated_payload(payload, postcode)
    if validated is None:
        return None
    return {"payload": validated, "fetched_at": row["fetched_at"]}


def _persist(
    postcode: str,
    payload: dict,
    *,
    source_kind: str,
    source: str,
    fetched_at: int,
    snapshot: bool,
) -> dict:
    """Upsert the community row (and optionally the external_cache snapshot).

    HTTP has already finished by the time this runs: only short database
    work happens inside the BEGIN IMMEDIATE transaction.
    """
    now = utc_now()
    fresh_until = now + POSTCODE_FRESH_TTL
    stale_until = now + POSTCODE_STALE_TTL
    with connection() as conn:
        with write_transaction(conn):
            existing = conn.execute(
                "SELECT id, source_kind FROM communities WHERE postcode = ?",
                (postcode,),
            ).fetchone()
            if existing is None:
                community_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO communities "
                    "(id, postcode, outcode, latitude, longitude, country, "
                    " source, source_kind, fetched_at, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        community_id, postcode, payload["outcode"],
                        payload["latitude"], payload["longitude"],
                        payload["country"], source, source_kind,
                        fetched_at, now,
                    ),
                )
            elif existing["source_kind"] == "fixture":
                # Demo snapshot stays labelled fixture; never relabel it live.
                community_id = existing["id"]
            else:
                community_id = existing["id"]
                conn.execute(
                    "UPDATE communities SET outcode = ?, latitude = ?, "
                    "longitude = ?, country = ?, source = ?, source_kind = ?, "
                    "fetched_at = ? WHERE id = ?",
                    (
                        payload["outcode"], payload["latitude"],
                        payload["longitude"], payload["country"], source,
                        source_kind, fetched_at, community_id,
                    ),
                )
            if snapshot:
                conn.execute(
                    "INSERT INTO external_cache "
                    "(cache_key, provider, schema_version, payload_json, "
                    " source_url, attribution, source_kind, fetched_at, "
                    " valid_time_from, valid_time_to, fresh_until, stale_until) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) "
                    "ON CONFLICT(cache_key) DO UPDATE SET "
                    "payload_json = excluded.payload_json, "
                    "source_url = excluded.source_url, "
                    "attribution = excluded.attribution, "
                    "source_kind = excluded.source_kind, "
                    "fetched_at = excluded.fetched_at, "
                    "fresh_until = excluded.fresh_until, "
                    "stale_until = excluded.stale_until",
                    (
                        postcode_cache_key(postcode), POSTCODE_PROVIDER,
                        POSTCODE_CACHE_SCHEMA_VERSION,
                        json.dumps(payload, ensure_ascii=False),
                        POSTCODE_SOURCE_URL, POSTCODE_ATTRIBUTION,
                        source_kind, fetched_at, fresh_until, stale_until,
                    ),
                )
            row = conn.execute(
                "SELECT * FROM communities WHERE id = ?", (community_id,)
            ).fetchone()
    return community_dict(row)


def resolve_postcode(raw_postcode: str) -> dict:
    """Resolve one postcode input to a canonical CommunityResponse dict."""
    postcode = precheck(raw_postcode)

    # 1. Previously verified row (fixture snapshot or earlier resolve).
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM communities WHERE postcode = ?", (postcode,)
        ).fetchone()
    if row is not None:
        return community_dict(row)

    # 2. Upstream check — always outside any transaction.
    envelope = None
    try:
        envelope = postcode_adapter.fetch(postcode)
    except PostcodeNotFoundError:
        # Upstream authoritatively says this postcode does not exist.
        raise AppError("INVALID_POSTCODE")
    except Exception:  # noqa: BLE001 - adapter must not raise, but never 500 on it
        envelope = None

    if isinstance(envelope, dict) and envelope.get("status") == "ok":
        payload = _validated_payload(envelope.get("data"), postcode)
        if payload is not None:
            fetched_at = envelope.get("fetched_at")
            if not isinstance(fetched_at, int):
                fetched_at = utc_now()
            return _persist(
                postcode,
                payload,
                source_kind="live",
                source=str(envelope.get("source") or POSTCODE_PROVIDER),
                fetched_at=fetched_at,
                snapshot=True,
            )

    # 3. Upstream failed: fall back to a previously verified cache snapshot.
    now = utc_now()
    with connection() as conn:
        cached = _read_postcode_cache(conn, postcode, now)
    if cached is not None:
        return _persist(
            postcode,
            cached["payload"],
            source_kind="cached",
            source=POSTCODE_PROVIDER,
            fetched_at=cached["fetched_at"] if isinstance(cached["fetched_at"], int) else now,
            snapshot=False,
        )

    # 3b. Hackathon demo postcodes: C's curated fixture snapshot, honestly
    # labelled fixture — never presented as a live upstream answer.
    fixture = c_demo_cache.lookup(postcode)
    if fixture is not None:
        location = fixture.get("location") or {}
        payload = _validated_payload(
            {
                "outcode": location.get("outcode"),
                "latitude": location.get("latitude"),
                "longitude": location.get("longitude"),
                "country": "Scotland",
            },
            postcode,
        )
        if payload is not None:
            return _persist(
                postcode,
                payload,
                source_kind="fixture",
                source="fixture",
                fetched_at=now,
                snapshot=False,
            )

    # 4. No confirmation available at all.
    raise AppError("UPSTREAM_UNAVAILABLE")
