"""Loans routes: listing, details, events, creation, state machine (spec 6 / 8.2)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth import CurrentUser, get_current_user
from app.idempotency import compute_fingerprint, require_idempotency_key
from app.schemas_common import list_success, success
from app.schemas_loans import (
    EmptyBody,
    LoanCreateRequest,
    LoanEnvelope,
    LoanEventListEnvelope,
    LoanListEnvelope,
    LoanStatus,
)
from app.services import loans as loans_svc

router = APIRouter(prefix="/api/v1", tags=["loans"])


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
    "/loans",
    response_model=LoanListEnvelope,
    summary="List my loans",
)
def list_loans(
    request: Request,
    role: Literal["borrower", "owner"] = Query(
        "borrower", description="borrower (default) or owner."
    ),
    status: LoanStatus | None = Query(None, description="Filter by loan status."),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Only loans the current user borrows, or loans of tools the current
    user owns (spec 4.2 / 8.2)."""
    items, total = loans_svc.list_loans(
        user=user, role=role, status=status, limit=limit, offset=offset
    )
    return list_success(items, _rid(request), limit, offset, total)


@router.get(
    "/loans/{loan_id}",
    response_model=LoanEnvelope,
    summary="Read one loan",
)
def get_loan(
    loan_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Readable by the borrower and the tool owner only; everyone else
    gets 404 (spec 4.2)."""
    data = loans_svc.get_loan(user=user, loan_id=loan_id)
    return success(data, _rid(request))


@router.get(
    "/loans/{loan_id}/events",
    response_model=LoanEventListEnvelope,
    summary="Read a loan's event stream",
)
def list_loan_events(
    loan_id: str,
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Immutable events ordered by created_at then id; parties only
    (spec 8.2)."""
    items, total = loans_svc.list_loan_events(
        user=user, loan_id=loan_id, limit=limit, offset=offset
    )
    return list_success(items, _rid(request), limit, offset, total)


@router.post(
    "/loans",
    response_model=LoanEnvelope,
    status_code=201,
    summary="Request to borrow a tool",
)
def create_loan(
    request: Request,
    response: Response,
    body: LoanCreateRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Creates a pending loan after the server-side archive, identity,
    distance and requirement checks (spec 6.2). Requires Idempotency-Key."""
    key = require_idempotency_key(request.headers.get("idempotency-key"))
    payload = body.model_dump()
    data, status, replayed = loans_svc.create_loan(
        user=user,
        body=payload,
        key=key,
        fingerprint=compute_fingerprint("POST", request.url.path, payload),
    )
    return _finish(response, request, data, status, replayed)


def _transition(
    loan_id: str,
    request: Request,
    response: Response,
    action: str,
    user: CurrentUser,
) -> dict:
    key = require_idempotency_key(request.headers.get("idempotency-key"))
    payload = {}  # empty-body endpoints still fingerprint their (empty) body
    data, status, replayed = loans_svc.transition_loan(
        user=user,
        loan_id=loan_id,
        action=action,
        key=key,
        fingerprint=compute_fingerprint("POST", request.url.path, payload),
    )
    return _finish(response, request, data, status, replayed)


@router.post(
    "/loans/{loan_id}/accept",
    response_model=LoanEnvelope,
    summary="Accept a pending request (owner)",
)
def accept_loan(
    loan_id: str,
    request: Request,
    response: Response,
    body: EmptyBody | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    return _transition(loan_id, request, response, "accept", user)


@router.post(
    "/loans/{loan_id}/reject",
    response_model=LoanEnvelope,
    summary="Reject a pending request (owner)",
)
def reject_loan(
    loan_id: str,
    request: Request,
    response: Response,
    body: EmptyBody | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    return _transition(loan_id, request, response, "reject", user)


@router.post(
    "/loans/{loan_id}/cancel",
    response_model=LoanEnvelope,
    summary="Cancel a pending/accepted request (either party)",
)
def cancel_loan(
    loan_id: str,
    request: Request,
    response: Response,
    body: EmptyBody | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    return _transition(loan_id, request, response, "cancel", user)


@router.post(
    "/loans/{loan_id}/hand-over",
    response_model=LoanEnvelope,
    summary="Hand the tool over (owner)",
)
def hand_over_loan(
    loan_id: str,
    request: Request,
    response: Response,
    body: EmptyBody | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    return _transition(loan_id, request, response, "hand-over", user)


@router.post(
    "/loans/{loan_id}/return",
    response_model=LoanEnvelope,
    summary="Confirm the tool came back (owner)",
)
def return_loan(
    loan_id: str,
    request: Request,
    response: Response,
    body: EmptyBody | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    return _transition(loan_id, request, response, "return", user)
