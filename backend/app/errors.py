"""Application error type, error-code table (spec 8.5) and handlers."""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("borrow_next_door.errors")

# --- Error codes (spec 8.5) with default HTTP status ---------------------

ERROR_STATUS: dict[str, int] = {
    # 400
    "IDEMPOTENCY_KEY_REQUIRED": 400,
    "IDEMPOTENCY_KEY_INVALID": 400,
    # 401
    "UNAUTHENTICATED": 401,
    # 403
    "FORBIDDEN": 403,
    "SELF_BORROW_FORBIDDEN": 403,
    # 404
    "NOT_FOUND": 404,
    # 409
    "TOOL_UNAVAILABLE": 409,
    "TOOL_ARCHIVED": 409,
    "ACTIVE_LOAN_EXISTS": 409,
    "REQUIREMENT_OCCUPIED": 409,
    "REQUIREMENT_LOCKED": 409,
    "REQUIREMENT_ALREADY_FULFILLED": 409,
    "INVALID_TRANSITION": 409,
    "TASK_NOT_READY": 409,
    "TASK_ALREADY_COMPLETED": 409,
    "IDEMPOTENCY_KEY_REUSED": 409,
    # 422
    "VALIDATION_ERROR": 422,
    "INVALID_POSTCODE": 422,
    "CATEGORY_MISMATCH": 422,
    "OUT_OF_RANGE": 422,
    # 429
    "RATE_LIMITED": 429,
    # 503
    "DATABASE_BUSY": 503,
    "UPSTREAM_UNAVAILABLE": 503,
    # 500
    "INTERNAL_ERROR": 500,
}

DEFAULT_MESSAGES: dict[str, str] = {
    "IDEMPOTENCY_KEY_REQUIRED": "Idempotency-Key header is required for this write.",
    "IDEMPOTENCY_KEY_INVALID": "Idempotency-Key must be a UUID.",
    "UNAUTHENTICATED": "Authentication required.",
    "FORBIDDEN": "You do not have permission to perform this action.",
    "SELF_BORROW_FORBIDDEN": "You cannot borrow your own tool.",
    "NOT_FOUND": "Resource not found.",
    "TOOL_UNAVAILABLE": "This tool is already reserved or on loan.",
    "TOOL_ARCHIVED": "This tool is archived.",
    "ACTIVE_LOAN_EXISTS": "This tool already has an active loan.",
    "REQUIREMENT_OCCUPIED": "This requirement is already covered by another loan.",
    "REQUIREMENT_LOCKED": "This requirement cannot be changed in its current state.",
    "REQUIREMENT_ALREADY_FULFILLED": "This requirement has already been fulfilled.",
    "INVALID_TRANSITION": "The loan is not in a state that allows this action.",
    "TASK_NOT_READY": "The task does not meet its completion conditions.",
    "TASK_ALREADY_COMPLETED": "The task is already completed.",
    "IDEMPOTENCY_KEY_REUSED": "This Idempotency-Key was used for a different request.",
    "VALIDATION_ERROR": "Request validation failed.",
    "INVALID_POSTCODE": "The postcode could not be resolved.",
    "CATEGORY_MISMATCH": "The tool category does not match the requirement.",
    "OUT_OF_RANGE": "A value is outside the allowed range.",
    "RATE_LIMITED": "Too many requests. Please retry later.",
    "DATABASE_BUSY": "The database is busy. Please retry shortly.",
    "UPSTREAM_UNAVAILABLE": "An upstream data provider is unavailable.",
    "INTERNAL_ERROR": "An unexpected internal error occurred.",
}


class AppError(Exception):
    """Structured application error mapped to the spec 8.1 error envelope."""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        http_status: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        if code not in ERROR_STATUS:
            # Unknown codes fall back to 500 but keep behaviour explicit.
            logger.warning("AppError raised with unknown code %r", code)
        self.code = code
        self.message = message or DEFAULT_MESSAGES.get(code, "Request failed.")
        self.http_status = http_status if http_status is not None else ERROR_STATUS.get(code, 500)
        self.details = details or {}
        super().__init__(f"{self.code}: {self.message}")


def is_database_locked(exc: sqlite3.OperationalError) -> bool:
    msg = str(exc).lower()
    return "database is locked" in msg or "database table is locked" in msg


def error_payload(code: str, message: str, request_id: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "error": {"code": code, "message": message, "details": details or {}},
        "meta": {"request_id": request_id},
    }


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "") or ""


def _json_safe_details(details: dict[str, Any]) -> dict[str, Any]:
    """Keep only field names; never echo sensitive input values."""
    safe: dict[str, Any] = {}
    forbidden = ("access_code", "authorization", "token", "password", "secret")
    for key, value in details.items():
        if any(f in key.lower() for f in forbidden):
            continue
        if isinstance(value, dict):
            safe[key] = _json_safe_details(value)
        elif isinstance(value, list):
            safe[key] = [
                _json_safe_details(v) if isinstance(v, dict) else None for v in value
            ]
        else:
            safe[key] = value
    return safe


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        headers = {}
        if exc.code == "DATABASE_BUSY":
            headers["Retry-After"] = "1"
        return JSONResponse(
            status_code=exc.http_status,
            content=error_payload(exc.code, exc.message, _request_id(request), _json_safe_details(exc.details)),
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = []
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", []) if p != "body"]
            fields.append({"field": ".".join(loc) or "body", "message": err.get("msg", "invalid value")})
        return JSONResponse(
            status_code=422,
            content=error_payload(
                "VALIDATION_ERROR",
                DEFAULT_MESSAGES["VALIDATION_ERROR"],
                _request_id(request),
                {"fields": fields},
            ),
        )

    @app.exception_handler(sqlite3.IntegrityError)
    async def _integrity_handler(request: Request, exc: sqlite3.IntegrityError) -> JSONResponse:
        logger.warning("IntegrityError mapped to conflict: %s", exc)
        return JSONResponse(
            status_code=409,
            content=error_payload(
                "INVALID_TRANSITION",
                "The request conflicts with the current state.",
                _request_id(request),
            ),
        )

    @app.exception_handler(sqlite3.OperationalError)
    async def _operational_handler(request: Request, exc: sqlite3.OperationalError) -> JSONResponse:
        if is_database_locked(exc):
            return JSONResponse(
                status_code=503,
                content=error_payload(
                    "DATABASE_BUSY",
                    DEFAULT_MESSAGES["DATABASE_BUSY"],
                    _request_id(request),
                ),
                headers={"Retry-After": "1"},
            )
        logger.exception("Unhandled OperationalError")
        return JSONResponse(
            status_code=500,
            content=error_payload("INTERNAL_ERROR", DEFAULT_MESSAGES["INTERNAL_ERROR"], _request_id(request)),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception_handler(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        status = exc.status_code
        if status == 404:
            code = "NOT_FOUND"
        elif status == 405:
            code = "VALIDATION_ERROR"
        elif 400 <= status < 500:
            code = "VALIDATION_ERROR"
        else:
            code = "INTERNAL_ERROR"
        message = exc.detail if isinstance(exc.detail, str) else DEFAULT_MESSAGES.get(code, "Request failed.")
        return JSONResponse(
            status_code=status,
            content=error_payload(code, message, _request_id(request)),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception")
        return JSONResponse(
            status_code=500,
            content=error_payload("INTERNAL_ERROR", DEFAULT_MESSAGES["INTERNAL_ERROR"], _request_id(request)),
        )
