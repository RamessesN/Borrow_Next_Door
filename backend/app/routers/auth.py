"""Demo authentication routes: login, logout, current user (spec 4.1 / 8.2)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.auth import (
    CurrentUser,
    create_demo_session,
    get_current_user,
    require_demo_mode,
    revoke_session,
)
from app.db import connection
from app.errors import AppError
from app.idempotency import compute_fingerprint, require_idempotency_key
from app.schemas_common import CommunityResponse, Envelope, success
from app.services import community as community_service

router = APIRouter(prefix="/api/v1", tags=["auth"])


# --- Request / response models (all Pydantic, extra=forbid) ----------------


class DemoLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_alias: str = Field(min_length=1, max_length=80)
    # Kept only for backward compatibility with older clients: the demo access
    # code was removed by user decision, so any value here is accepted and
    # ignored. It never reaches create_demo_session.
    access_code: str | None = Field(default=None, max_length=200)


class DemoUser(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    alias: str
    display_name: str
    community_id: str


class DemoSessionData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    access_token: str
    token_type: str
    expires_at: str | None
    user: DemoUser


class DemoSessionResponse(Envelope[DemoSessionData]):
    pass


class LogoutData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revoked: bool


class LogoutResponse(Envelope[LogoutData]):
    pass


class MeData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    display_name: str
    community: CommunityResponse
    mode: str


class MeResponse(Envelope[MeData]):
    pass


class MoveCommunityRequest(BaseModel):
    """Body of the demo's "move my street" write (POST /me/community)."""

    model_config = ConfigDict(extra="forbid")

    postcode: str = Field(min_length=1, max_length=20)


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


def _load_community(community_id: str) -> dict:
    """CommunityResponse-shaped dict for the /me payload."""
    with connection() as conn:
        row = conn.execute(
            "SELECT id, postcode, outcode, latitude, longitude, country, "
            "source, source_kind, fetched_at "
            "FROM communities WHERE id = ?",
            (community_id,),
        ).fetchone()
    if row is None:
        raise AppError("NOT_FOUND")
    return community_service.community_dict(row)


def _me_data(user: CurrentUser, community: dict) -> dict:
    return {
        "id": user.id,
        "display_name": user.display_name,
        "community": community,
        "mode": "demo",
    }


# --- Routes -----------------------------------------------------------------


@router.post(
    "/demo/sessions",
    response_model=DemoSessionResponse,
    status_code=201,
    summary="Create a demo session",
)
def demo_login(request: Request, body: DemoLoginRequest) -> dict:
    require_demo_mode()
    ip = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        ip = forwarded.split(",")[0].strip()
    session = create_demo_session(body.user_alias, ip)
    return success(session, _rid(request))


@router.post(
    "/sessions/logout",
    response_model=LogoutResponse,
    summary="Revoke the current session",
)
def logout(request: Request) -> dict:
    header = request.headers.get("authorization") or ""
    parts = header.split(None, 1)
    token = parts[1].strip() if len(parts) == 2 else ""
    if not token:
        raise AppError("UNAUTHENTICATED")
    revoked = revoke_session(token)
    if not revoked:
        # Already revoked or unknown token: same 401 as any bad token.
        raise AppError("UNAUTHENTICATED")
    return success({"revoked": True}, _rid(request))


@router.get("/me", response_model=MeResponse, summary="Current user profile")
def me(request: Request, user: CurrentUser = Depends(get_current_user)) -> dict:
    community = _load_community(user.community_id)
    return success(_me_data(user, community), _rid(request))


# Demo "move my street" action (spec 2.1/4.2): the postcode form points the
# account's own home community at the checked postcode instead of a read-only
# browse, so the header, environment, tools, tasks and publishing all follow.
@router.post(
    "/me/community",
    response_model=MeResponse,
    summary="Move the demo account's home community",
)
def move_me_community(
    request: Request,
    response: Response,
    body: MoveCommunityRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Resolve the postcode and point the caller's users.community_id at it.

    Returns the same shape as GET /me. Requires an Idempotency-Key like every
    other business write (spec 6.3); an invalid postcode is 422 INVALID_POSTCODE
    and leaves the caller's home community unchanged.
    """
    key = require_idempotency_key(request.headers.get("idempotency-key"))
    fingerprint = compute_fingerprint("POST", request.url.path, body.model_dump())
    community, replayed = community_service.move_user_community(
        user=user, postcode=body.postcode, key=key, fingerprint=fingerprint
    )
    if replayed:
        response.headers["Idempotency-Replayed"] = "true"
    return success(_me_data(user, community), _rid(request))
