"""Task templates, task lifecycle and requirement endpoints (spec 7 / 8.2-8.4).

Writes use the shared idempotency primitives: the record is written in the
same transaction as the business change, replays return the original payload
with `Idempotency-Replayed: true` and the current request_id.
"""

from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth import CurrentUser, get_current_user
from app.db import connection, utc_now, write_transaction
from app.idempotency import (
    check_idempotent,
    compute_fingerprint,
    record_idempotent,
    require_idempotency_key,
)
from app.schemas_common import list_success, success
from app.schemas_tasks import (
    CompleteTaskRequest,
    CreateTaskRequest,
    SelfSupplyRequest,
    TaskListResponse,
    TaskResponse,
    TaskTemplateListResponse,
)
from app.services import tasks as task_service

router = APIRouter(prefix="/api/v1", tags=["tasks"])

Scope = Literal["mine", "community"]


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


def _canonical(data: dict) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def require_task_viewer(request: Request) -> CurrentUser:
    """Authenticated viewer for every task route (spec 8.5).

    Missing, invalid, expired or revoked bearer token -> 401
    UNAUTHENTICATED, regardless of any ``X-User-Id`` header: that header is
    never an identity source (spec 4.1), so it can neither unlock data nor
    change the status code.
    """
    return get_current_user(request)


# --- Read endpoints ---------------------------------------------------------


@router.get(
    "/task-templates",
    response_model=TaskTemplateListResponse,
    summary="List the fixed task templates",
)
def list_task_templates(
    request: Request, user: CurrentUser = Depends(require_task_viewer)
) -> dict:
    _ = user
    with connection() as conn:
        items = task_service.template_payload(conn)
    return list_success(items, _rid(request), limit=20, offset=0, total=len(items))


@router.get(
    "/tasks",
    response_model=TaskListResponse,
    summary="List tasks (mine or community scope)",
)
def list_tasks(
    request: Request,
    scope: Scope = "mine",
    community_id: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: CurrentUser = Depends(require_task_viewer),
) -> dict:
    with connection() as conn:
        items, total = task_service.list_tasks(
            conn, user, scope, community_id, limit, offset
        )
    return list_success(items, _rid(request), limit, offset, total)


@router.get(
    "/tasks/{task_id}",
    response_model=TaskResponse,
    summary="Task detail with public requirement states",
)
def get_task(
    task_id: str,
    request: Request,
    user: CurrentUser = Depends(require_task_viewer),
) -> dict:
    with connection() as conn:
        task = task_service.get_task_row(conn, task_id)
        data = task_service.build_task_data(conn, task, user.id)
    return success(data, _rid(request))


# --- Write endpoints --------------------------------------------------------


@router.post(
    "/tasks",
    response_model=TaskResponse,
    status_code=201,
    summary="Create a task from a template",
)
def create_task(
    body: CreateTaskRequest,
    request: Request,
    response: Response,
    user: CurrentUser = Depends(require_task_viewer),
) -> dict:
    key = require_idempotency_key(request.headers.get("Idempotency-Key"))
    fingerprint = compute_fingerprint(
        request.method, request.url.path, body.model_dump(mode="json")
    )
    with connection() as conn:
        with write_transaction(conn):
            replay = check_idempotent(conn, user.id, key, fingerprint)
            if replay["is_replay"]:
                response.headers["Idempotency-Replayed"] = "true"
                return success(json.loads(replay["response_json"]), _rid(request))
            data = task_service.create_task(conn, user, body)
            record_idempotent(
                conn,
                user.id,
                key,
                fingerprint,
                201,
                _canonical(data),
                utc_now(),
            )
    return success(data, _rid(request))


@router.put(
    "/tasks/{task_id}/requirements/{requirement_id}/self-supply",
    response_model=TaskResponse,
    summary="Set the self-supplied flag of one requirement",
)
def put_self_supply(
    task_id: str,
    requirement_id: str,
    body: SelfSupplyRequest,
    request: Request,
    response: Response,
    user: CurrentUser = Depends(require_task_viewer),
) -> dict:
    key = require_idempotency_key(request.headers.get("Idempotency-Key"))
    fingerprint = compute_fingerprint(
        request.method, request.url.path, body.model_dump(mode="json")
    )
    with connection() as conn:
        with write_transaction(conn):
            replay = check_idempotent(conn, user.id, key, fingerprint)
            if replay["is_replay"]:
                response.headers["Idempotency-Replayed"] = "true"
                return success(json.loads(replay["response_json"]), _rid(request))
            data = task_service.set_self_supply(
                conn, user, task_id, requirement_id, body.self_supplied
            )
            record_idempotent(
                conn,
                user.id,
                key,
                fingerprint,
                200,
                _canonical(data),
                utc_now(),
            )
    return success(data, _rid(request))


@router.post(
    "/tasks/{task_id}/complete",
    response_model=TaskResponse,
    summary="Complete a task with a self-reported outcome",
)
def complete_task(
    task_id: str,
    body: CompleteTaskRequest,
    request: Request,
    response: Response,
    user: CurrentUser = Depends(require_task_viewer),
) -> dict:
    key = require_idempotency_key(request.headers.get("Idempotency-Key"))
    fingerprint = compute_fingerprint(
        request.method, request.url.path, body.model_dump(mode="json")
    )
    with connection() as conn:
        with write_transaction(conn):
            replay = check_idempotent(conn, user.id, key, fingerprint)
            if replay["is_replay"]:
                response.headers["Idempotency-Replayed"] = "true"
                return success(json.loads(replay["response_json"]), _rid(request))
            data = task_service.complete_task(conn, user, task_id, body)
            record_idempotent(
                conn,
                user.id,
                key,
                fingerprint,
                200,
                _canonical(data),
                utc_now(),
            )
    return success(data, _rid(request))
