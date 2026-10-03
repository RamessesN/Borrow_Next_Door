"""Shared Pydantic v2 envelope schemas used by every endpoint."""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class EnvelopeMeta(BaseModel):
    """Meta block of every envelope; list responses fill limit/offset/total."""

    model_config = ConfigDict(extra="forbid")

    request_id: str
    limit: int | None = None
    offset: int | None = None
    total: int | None = None


class Envelope(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")

    data: T
    meta: EnvelopeMeta


class ListEnvelope(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")

    data: list[T]
    meta: EnvelopeMeta


class ErrorBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    details: dict = Field(default_factory=dict)


class ErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: ErrorBody
    meta: EnvelopeMeta


class CommunityResponse(BaseModel):
    """Canonical community representation (spec 8.3)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    postcode: str
    outcode: str
    latitude: float
    longitude: float
    country: str
    source: str
    source_kind: str
    fetched_at: str | None = None


class OwnerBrief(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    display_name: str


def success(data: dict | list | object, request_id: str) -> dict:
    """Build a single-item success envelope as a plain dict."""
    return {"data": data, "meta": {"request_id": request_id}}


def list_success(
    items: list, request_id: str, limit: int, offset: int, total: int
) -> dict:
    """Build a list success envelope as a plain dict."""
    return {
        "data": items,
        "meta": {
            "request_id": request_id,
            "limit": limit,
            "offset": offset,
            "total": total,
        },
    }
