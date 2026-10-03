"""Pydantic response models for the community / environment / impact routes.

Everything here feeds the auto-generated OpenAPI schema (spec 8.1: no
untyped dict responses). Envelope and CommunityResponse are reused from
app.schemas_common.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas_common import CommunityResponse, Envelope

# Adapter-level statuses come from app/adapters/base.py ("ok",
# "not_implemented", "unavailable"); the API additionally reports "cached"
# when a section is served from the external_cache table.
ProviderStatus = Literal["ok", "not_implemented", "unavailable", "cached"]

# Overall environment status (spec 8.2): ok | partial | unavailable.
OverallStatus = Literal["ok", "partial", "unavailable"]


class ResolveResponse(Envelope[CommunityResponse]):
    """GET /communities/resolve -> Envelope[CommunityResponse]."""


class ProviderEnvelope(BaseModel):
    """One provider section inside the environment response (spec 8.2)."""

    model_config = ConfigDict(extra="forbid")

    provider: str
    status: ProviderStatus
    data: Any = None
    source_kind: str | None = None
    source: str = ""
    source_url: str = ""
    attribution: str = ""
    fetched_at: str | None = None
    valid_time_from: str | None = None
    valid_time_to: str | None = None
    fresh_until: str | None = None
    stale_until: str | None = None


class EnvironmentData(BaseModel):
    """Provider sections at the top level plus the overall status (spec 8.2)."""

    model_config = ConfigDict(extra="forbid")

    status: OverallStatus
    postcode: ProviderEnvelope
    carbon_intensity: ProviderEnvelope
    air_quality: ProviderEnvelope
    greenspace: ProviderEnvelope


class EnvironmentResponse(Envelope[EnvironmentData]):
    """GET /communities/{id}/environment."""


class ImpactData(BaseModel):
    """Impact counters, all computed from application rows (spec 8.2)."""

    model_config = ConfigDict(extra="forbid")

    active_tools_count: int = Field(ge=0)
    returned_loans_count: int = Field(ge=0)
    completed_tasks_count: int = Field(ge=0)
    as_of: str


class ImpactResponse(Envelope[ImpactData]):
    """GET /communities/{id}/impact."""
