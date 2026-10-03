"""Demo authentication routes: login, logout, current user (spec 4.1 / 8.2)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.auth import (
    CurrentUser,
    create_demo_session,
    get_current_user,
    require_demo_mode,
    revoke_session,
)
from app.db import connection, epoch_to_iso
from app.errors import AppError
from app.schemas_common import CommunityResponse, Envelope, success

router = APIRouter(prefix="/api/v1", tags=["auth"])


# --- Request / response models (all Pydantic, extra=forbid) ----------------


class DemoLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_alias: str = Field(min_length=1, max_length=80)
    access_code: str = Field(min_length=1, max_length=200)


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


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


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
    session = create_demo_session(body.user_alias, body.access_code, ip)
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
    with connection() as conn:
        row = conn.execute(
            "SELECT id, postcode, outcode, latitude, longitude, country, "
            "source, source_kind, fetched_at "
            "FROM communities WHERE id = ?",
            (user.community_id,),
        ).fetchone()
    if row is None:
        raise AppError("NOT_FOUND")

    community = CommunityResponse(
        id=row["id"],
        postcode=row["postcode"],
        outcode=row["outcode"],
        latitude=row["latitude"],
        longitude=row["longitude"],
        country=row["country"],
        source=row["source"],
        source_kind=row["source_kind"],
        fetched_at=epoch_to_iso(row["fetched_at"]),
    )
    data = {
        "id": user.id,
        "display_name": user.display_name,
        "community": community.model_dump(),
        "mode": "demo",
    }
    return success(data, _rid(request))
