"""Tools routes: nearby listing, detail, publishing, archiving (spec 8.2)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth import CurrentUser, get_current_user
from app.idempotency import compute_fingerprint, require_idempotency_key
from app.schemas_common import list_success, success
from app.schemas_tools import (
    EmptyBody,
    ToolAvailability,
    ToolCategory,
    ToolCreateRequest,
    ToolEnvelope,
    ToolListEnvelope,
)
from app.services import tools as tools_svc

router = APIRouter(prefix="/api/v1", tags=["tools"])


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


def _finish(
    response: Response,
    request: Request,
    data: dict,
    status: int,
    replayed: bool,
) -> dict:
    """Apply the idempotent status/echo header and wrap in the envelope."""
    response.status_code = status
    if replayed:
        response.headers["Idempotency-Replayed"] = "true"
    return success(data, _rid(request))


@router.get(
    "/tools",
    response_model=ToolListEnvelope,
    summary="List tools near a community",
)
def list_tools(
    request: Request,
    community_id: str = Query(..., description="Reference community (required)."),
    radius_m: int = Query(
        2000, ge=100, le=2000, description="Search radius in metres (100-2000)."
    ),
    category: ToolCategory | None = Query(
        None, description="Filter by category slug."
    ),
    availability: ToolAvailability | None = Query(
        None, description="Filter by computed availability."
    ),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Tools within radius_m of the reference community centre, ordered
    same community first, then distance, created_at, id (spec 4.3 / 5.3)."""
    items, total = tools_svc.list_tools(
        community_id=community_id,
        radius_m=radius_m,
        category=category,
        availability=availability,
        limit=limit,
        offset=offset,
    )
    return list_success(items, _rid(request), limit, offset, total)


@router.get(
    "/tools/{tool_id}",
    response_model=ToolEnvelope,
    summary="Read one tool",
)
def get_tool(
    tool_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Readable by any authenticated user, including archived tools
    (spec 8.2). This route has no reference community, so distance_m is null."""
    data = tools_svc.get_tool(tool_id)
    return success(data, _rid(request))


@router.post(
    "/tools",
    response_model=ToolEnvelope,
    status_code=201,
    summary="Publish a tool",
)
def create_tool(
    request: Request,
    response: Response,
    body: ToolCreateRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Owner and home community come from the session, never from the body
    (spec 4.2). Requires Idempotency-Key."""
    key = require_idempotency_key(request.headers.get("idempotency-key"))
    payload = body.model_dump()
    data, status, replayed = tools_svc.create_tool(
        user=user,
        body=payload,
        key=key,
        fingerprint=compute_fingerprint("POST", request.url.path, payload),
    )
    return _finish(response, request, data, status, replayed)


@router.post(
    "/tools/{tool_id}/archive",
    response_model=ToolEnvelope,
    summary="Archive a tool",
)
def archive_tool(
    tool_id: str,
    request: Request,
    response: Response,
    body: EmptyBody | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Owner only; 409 ACTIVE_LOAN_EXISTS while a loan is pending/accepted/
    on_loan; already archived is a 200 no-op (spec 4.2 / 6.3)."""
    key = require_idempotency_key(request.headers.get("idempotency-key"))
    payload = {} if body is None else body.model_dump()
    data, status, replayed = tools_svc.archive_tool(
        user=user,
        tool_id=tool_id,
        key=key,
        fingerprint=compute_fingerprint("POST", request.url.path, payload),
    )
    return _finish(response, request, data, status, replayed)
