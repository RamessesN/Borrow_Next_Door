"""Pydantic request/response models for the tasks endpoints (spec 7 / 8.2-8.4).

Every request model uses extra=forbid so clients cannot smuggle in
``status``/``outcome``/``creator`` style fields. Integer fields are strict:
booleans must never be accepted as 0/1 (spec 5).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas_common import Envelope, ListEnvelope, OwnerBrief

TaskStatusLiteral = Literal["open", "completed"]

RequirementStateLiteral = Literal[
    "self_supplied",
    "pending",
    "confirmed",
    "in_use",
    "fulfilled",
    "match_available",
    "missing",
]

PlaceSourceLiteral = Literal["osm", "manual", "fixture"]


# --- Requests ---------------------------------------------------------------


class PlaceInput(BaseModel):
    """Client-supplied meeting point (spec 8.4). Coordinates are validated
    server-side (finite, lat/lon range, <=2000 m from the community centre);
    for source=osm the name/coordinates are replaced by cached values."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    latitude: float
    longitude: float
    source: str = Field(min_length=1, max_length=20)
    source_id: str | None = Field(default=None, max_length=200)


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, max_length=64)
    place: PlaceInput | None = None
    title: str | None = Field(default=None, min_length=1, max_length=120)


class SelfSupplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    self_supplied: bool = Field(strict=True)


class CompleteTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome_note: str = Field(min_length=1, max_length=500)
    # strict=True: bool / float / numeric-string must not pass as an integer.
    bags_collected: int | None = Field(default=None, strict=True, ge=0, le=1000)
    volunteer_minutes: int | None = Field(default=None, strict=True, ge=0, le=10000)


# --- Response bodies --------------------------------------------------------


class PlaceView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    latitude: float
    longitude: float
    source: PlaceSourceLiteral
    source_id: str | None = None


class RequirementView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    category: str
    quantity: int
    self_supplied: bool
    state: RequirementStateLiteral
    active_loan_id: str | None = None
    candidate_tool_ids: list[str] = Field(default_factory=list)


class TaskOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: str
    bags_collected: int | None = None
    volunteer_minutes: int | None = None
    verification: Literal["self_reported"] = "self_reported"


class TaskData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    creator: OwnerBrief
    community_id: str
    template_id: str
    place: PlaceView
    status: TaskStatusLiteral
    requirements: list[RequirementView]
    coordination_ready: bool
    completion_eligible: bool
    outcome: TaskOutcome | None = None
    created_at: str
    completed_at: str | None = None


class TaskResponse(Envelope[TaskData]):
    pass


class TaskSummaryData(BaseModel):
    """List row for GET /tasks: public summary without borrowing details
    (no requirement/loan payloads, no active_loan_id, no candidate list)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    creator: OwnerBrief
    community_id: str
    template_id: str
    place: PlaceView
    status: TaskStatusLiteral
    coordination_ready: bool
    completion_eligible: bool
    outcome: TaskOutcome | None = None
    created_at: str
    completed_at: str | None = None


class TaskListResponse(ListEnvelope[TaskSummaryData]):
    pass


class TemplateRequirementView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str
    quantity: int


class TaskTemplateData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    description: str
    requirements: list[TemplateRequirementView]


class TaskTemplateListResponse(ListEnvelope[TaskTemplateData]):
    pass
