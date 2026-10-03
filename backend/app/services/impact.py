"""Community impact counters, computed live from application rows (spec 8.2).

GET /communities/{id}/impact returns exactly four fields:

- active_tools_count:   tools in the community with is_archived = 0
- returned_loans_count: loans with status = 'returned' whose tool belongs
                        to the community
- completed_tasks_count: tasks in the community with status = 'completed'
- as_of:                ISO 8601 UTC timestamp of this computation

No external factor, no estimated emissions: every number comes from this
application's own database at request time.
"""

from __future__ import annotations

from app.db import connection, epoch_to_iso, utc_now
from app.errors import AppError


def get_impact(community_id: str) -> dict:
    """Return the impact counters for one community (404 when unknown)."""
    with connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM communities WHERE id = ?", (community_id,)
        ).fetchone()
        if exists is None:
            raise AppError("NOT_FOUND")

        active_tools = conn.execute(
            "SELECT COUNT(*) AS n FROM tools "
            "WHERE community_id = ? AND is_archived = 0",
            (community_id,),
        ).fetchone()["n"]

        # Loans carry no community of their own: scope via the tool.
        returned_loans = conn.execute(
            "SELECT COUNT(*) AS n FROM loans l "
            "JOIN tools t ON t.id = l.tool_id "
            "WHERE t.community_id = ? AND l.status = 'returned'",
            (community_id,),
        ).fetchone()["n"]

        completed_tasks = conn.execute(
            "SELECT COUNT(*) AS n FROM tasks "
            "WHERE community_id = ? AND status = 'completed'",
            (community_id,),
        ).fetchone()["n"]

    return {
        "active_tools_count": int(active_tools),
        "returned_loans_count": int(returned_loans),
        "completed_tasks_count": int(completed_tasks),
        "as_of": epoch_to_iso(utc_now()),
    }
