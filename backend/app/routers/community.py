"""Community, environment and impact endpoints (spec 8.2).

- GET /api/v1/communities/resolve?postcode=...
- GET /api/v1/communities/{id}/environment
- GET /api/v1/communities/{id}/impact

All three require Bearer authentication and are reads (no Idempotency-Key).
Responses use typed Pydantic models so they appear in the OpenAPI schema.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from app.auth import CurrentUser, get_current_user
from app.schemas_common import success
from app.schemas_community import (
    EnvironmentResponse,
    ImpactResponse,
    ResolveResponse,
)
from app.services import community as community_service
from app.services import environment as environment_service
from app.services import impact as impact_service

router = APIRouter(prefix="/api/v1", tags=["community"])


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


def resolve_user(request: Request) -> CurrentUser:
    """Authenticated user for GET /communities/resolve (spec 8.5).

    No credential at all — with or without a postcode query, with or without
    an ``X-User-Id`` header — is 401 UNAUTHENTICATED; X-User-Id is never an
    identity source.
    """
    return get_current_user(request)


@router.get(
    "/communities/resolve",
    response_model=ResolveResponse,
    summary="Resolve a postcode to a community",
)
def resolve_community(
    request: Request,
    user: CurrentUser = Depends(resolve_user),
    postcode: str = Query(
        ...,
        description="UK postcode, e.g. EH8 9AB (case and spacing are normalised).",
    ),
) -> dict:
    """Normalise the postcode, confirm it upstream (or via verified cache)
    and upsert the canonical community. Never changes the caller's identity
    or home community."""
    _ = user  # authentication enforced by the dependency
    data = community_service.resolve_postcode(postcode)
    return success(data, _rid(request))


@router.get(
    "/communities/{community_id}/environment",
    response_model=EnvironmentResponse,
    summary="Per-provider environment envelopes for a community",
)
def community_environment(
    community_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Independent envelope per provider plus an overall ok/partial/
    unavailable status; one failing provider never breaks the response."""
    _ = user
    data = environment_service.get_environment(community_id)
    return success(data, _rid(request))


@router.get(
    "/communities/{community_id}/impact",
    response_model=ImpactResponse,
    summary="Community impact counters",
)
def community_impact(
    community_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Active tools, returned loans and completed tasks counted from the
    application database at request time; 404 for unknown communities."""
    _ = user
    data = impact_service.get_impact(community_id)
    return success(data, _rid(request))
