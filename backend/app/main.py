"""FastAPI application factory for Borrow Next Door."""

from __future__ import annotations

import logging
import re
import uuid

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import SettingsError, get_settings
from app.errors import install_error_handlers
from app.routers import auth as auth_router
from app.routers import community as community_router
from app.routers import health as health_router
from app.routers import loans as loans_router
from app.routers import tasks as tasks_router
from app.routers import tools as tools_router

logger = logging.getLogger("borrow_next_door")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def create_app() -> FastAPI:
    # Fail fast on bad configuration (missing/placeholder access code,
    # APP_MODE=production without real auth, etc.).
    try:
        settings = get_settings()
    except SettingsError as exc:
        raise SystemExit(f"Configuration error: {exc}") from exc

    app = FastAPI(
        title="Borrow Next Door API",
        version="0.1.0",
        description=(
            "Neighbourhood tool-sharing API (demo mode). "
            "Shared envelope: {data, meta} on success, "
            "{error, meta} on failure."
        ),
    )

    install_error_handlers(app)

    # CORS for the frontend dev server (Vite on port 5173). Origins are
    # pinned to the two loopback spellings; methods/headers are open-ended
    # so Authorization, Idempotency-Key and Content-Type all pass.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-Id"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        incoming = request.headers.get("x-request-id", "").strip()
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else str(uuid.uuid4())
        request.state.request_id = request_id
        response: Response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        return response

    # Health lives at the root path; everything else under /api/v1.
    app.include_router(health_router.router)

    if settings.app_mode == "demo":
        app.include_router(auth_router.router)

    # Shell routers reserved for follow-up tasks (tools / loans / tasks /
    # community) — they carry no endpoints yet but are registered so their
    # paths appear in OpenAPI once filled in.
    app.include_router(tools_router.router)
    app.include_router(loans_router.router)
    app.include_router(tasks_router.router)
    app.include_router(community_router.router)

    return app


app = create_app()


def run() -> None:  # pragma: no cover - manual entry point
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, workers=1)


if __name__ == "__main__":  # pragma: no cover
    run()
