"""Health check endpoints (spec 8.2): GET /health/live and /health/ready."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict

from app.db import connection, epoch_to_iso, utc_now
from app.migrations import MIGRATION_VERSION, applied_versions
from app.schemas_common import Envelope, success

router = APIRouter(tags=["health"])


class LiveData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    time: str


class ReadyData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str


class LiveResponse(Envelope[LiveData]):
    pass


class ReadyResponse(Envelope[ReadyData]):
    pass


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


@router.get("/health/live", response_model=LiveResponse, summary="Liveness probe")
def live(request: Request) -> dict:
    """Process is alive. Never touches the database or external APIs."""
    data = {"status": "live", "time": epoch_to_iso(utc_now())}
    return success(data, _rid(request))


@router.get("/health/ready", response_model=ReadyResponse, summary="Readiness probe")
def ready(request: Request, response: Response) -> dict:
    """200 only when the DB is readable and all migrations are applied."""
    try:
        with connection() as conn:
            versions = applied_versions(conn)
        ok = MIGRATION_VERSION in versions
    except Exception:
        ok = False
    if not ok:
        response.status_code = 503
        # Deliberately no file path or SQL detail in the payload.
        return success({"status": "not_ready"}, _rid(request))
    return success({"status": "ready"}, _rid(request))
