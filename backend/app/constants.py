"""Frozen shared constants for the Borrow Next Door backend.

These constants are a shared contract used by every module and by the
parallel follow-up tasks (tools / loans / tasks / community). Do not rename.
"""

TOOL_CATEGORIES = (
    "litter_picker",
    "reusable_gloves",
    "watering_can",
    "hand_trowel",
)

LOAN_STATUSES = (
    "pending",
    "accepted",
    "on_loan",
    "returned",
    "rejected",
    "cancelled",
)
ACTIVE_LOAN_STATUSES = ("pending", "accepted", "on_loan")

TOOL_AVAILABILITY = ("available", "reserved", "on_loan", "archived")

TASK_STATUSES = ("open", "completed")

REQUIREMENT_STATES = (
    "self_supplied",
    "pending",
    "confirmed",
    "in_use",
    "fulfilled",
    "match_available",
    "missing",
)

PLACE_SOURCES = ("osm", "manual", "fixture")
SOURCE_KINDS = ("live", "cached", "fixture")

# Fixed task templates (spec 5.1). quantity is always 1 per requirement.
TASK_TEMPLATES = {
    "park_cleanup": {
        "title": "Park cleanup",
        "description": (
            "Collect litter at a local park. Bring bags; "
            "litter pickers and reusable gloves are borrowed from neighbours."
        ),
        "requirements": [("litter_picker", 1), ("reusable_gloves", 1)],
    },
    "flowerbed_care": {
        "title": "Flowerbed care",
        "description": (
            "Water and weed a neighbourhood flowerbed. "
            "Borrow a watering can and hand trowel from nearby helpers."
        ),
        "requirements": [("watering_can", 1), ("hand_trowel", 1)],
    },
}
