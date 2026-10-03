#!/usr/bin/env bash
# Start the Borrow Next Door dev server (single uvicorn worker, port 8000).
# Usage (from backend/):  DEMO_ACCESS_CODE=<team-code> ./scripts/dev_server.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${DEMO_ACCESS_CODE:-}" ]]; then
  echo "ERROR: DEMO_ACCESS_CODE must be set (>=16 chars, see .env.example)." >&2
  exit 1
fi

export APP_MODE="${APP_MODE:-demo}"
export DATABASE_PATH="${DATABASE_PATH:-./var/borrow-next-door.sqlite3}"

# Ensure the database exists (migrate + seed, idempotent).
.venv/bin/python scripts/reset_db.py

exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
