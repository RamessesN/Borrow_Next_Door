"""Pydantic request/response models for the tools endpoints (spec 8.2 / 8.3).

Every model here forbids unknown fields so a client can never smuggle in
owner_id / status / is_archived (spec 4.2).
"""

from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

from app.constants import TOOL_AVAILABILITY, TOOL_CATEGORIES
from app.schemas_common import CommunityResponse, Envelope, ListEnvelope, OwnerBrief

# Frozen category / availability slugs (spec 5.1 / 5.3).
ToolCategory = Literal[
    "litter_picker",
    "reusable_gloves",
    "watering_can",
    "hand_trowel",
]
ToolAvailability = Literal["available", "reserved", "on_loan", "archived"]

# Keep the OpenAPI enums locked to the shared constants.
assert set(get_args(ToolCategory)) == set(TOOL_CATEGORIES), (
    "ToolCategory is out of sync with constants.TOOL_CATEGORIES"
)
assert set(get_args(ToolAvailability)) == set(TOOL_AVAILABILITY), (
    "ToolAvailability is out of sync with constants.TOOL_AVAILABILITY"
)


class ToolCreateRequest(BaseModel):
    """POST /api/v1/tools body: exactly name, category, description (spec 8.2)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    category: ToolCategory
    description: str = Field(default="", max_length=500)


class ToolResponse(BaseModel):
    """ToolResponse (spec 8.3). distance_m is null without a reference
    community — never 0 pretending to be a computed value."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    category: ToolCategory
    description: str
    owner: OwnerBrief
    community: CommunityResponse
    availability: ToolAvailability
    is_archived: bool
    distance_m: float | None
    created_at: str
    updated_at: str


class EmptyBody(BaseModel):
    """Body model for endpoints that take no input (archive, transitions)."""

    model_config = ConfigDict(extra="forbid")


class ToolEnvelope(Envelope[ToolResponse]):
    pass


class ToolListEnvelope(ListEnvelope[ToolResponse]):
    pass
