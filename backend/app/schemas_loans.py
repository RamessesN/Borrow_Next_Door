"""Pydantic request/response models for the loans endpoints (spec 6 / 8.3).

POST /api/v1/loans accepts only tool_id, requirement_id and note — never
borrower_id or status, which the server derives itself (spec 4.2 / 8.2).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas_common import Envelope, ListEnvelope
from app.schemas_tools import EmptyBody

# Frozen loan statuses (spec 6.1).
LoanStatus = Literal[
    "pending",
    "accepted",
    "on_loan",
    "returned",
    "rejected",
    "cancelled",
]

# Object ids: UUIDs for API-created rows, plus the mnemonic seed ids
# (t1111111-…, r… ) the fixtures use. Anything syntactically plausible but
# unknown still resolves to 404 in the service.
_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"


class LoanCreateRequest(BaseModel):
    """POST /api/v1/loans body (spec 8.2 / 8.4)."""

    model_config = ConfigDict(extra="forbid")

    tool_id: str = Field(pattern=_ID_PATTERN)
    requirement_id: str | None = Field(default=None, pattern=_ID_PATTERN)
    note: str | None = Field(default=None, max_length=300)


class LoanResponse(BaseModel):
    """LoanResponse (spec 8.3); every timestamp is ISO 8601 UTC or null."""

    model_config = ConfigDict(extra="forbid")

    id: str
    tool_id: str
    tool_name: str
    owner_id: str
    borrower_id: str
    requirement_id: str | None
    task_id: str | None
    status: LoanStatus
    note: str
    created_at: str
    updated_at: str
    accepted_at: str | None
    handed_over_at: str | None
    returned_at: str | None
    rejected_at: str | None
    cancelled_at: str | None


class LoanEventResponse(BaseModel):
    """One immutable loan_events row (spec 8.2 GET /loans/{id}/events)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    loan_id: str
    actor_id: str
    action: str
    from_status: str | None
    to_status: str
    created_at: str


class LoanEnvelope(Envelope[LoanResponse]):
    pass


class LoanListEnvelope(ListEnvelope[LoanResponse]):
    pass


class LoanEventListEnvelope(ListEnvelope[LoanEventResponse]):
    pass


__all__ = [
    "EmptyBody",
    "LoanCreateRequest",
    "LoanEnvelope",
    "LoanEventListEnvelope",
    "LoanEventResponse",
    "LoanListEnvelope",
    "LoanResponse",
    "LoanStatus",
]
