#!/usr/bin/env bash
# Borrow Next Door — one-command demo launcher
#
# Starts the backend (FastAPI :8000) and the frontend (:5173) together,
# prepares everything from a fresh clone and opens the app in your browser.
# Ctrl+C stops both. No access code is required to sign in.
#
#   ./start.sh            # normal start (creates venv/DB on first run)
#   ./start.sh --reset    # also rebuild the demo database
#   ./start.sh --help
#
# Windows: run inside WSL/Git-Bash, or start the two processes manually
# (see README.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
VENV="$BACKEND/.venv"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
LOG_DIR="$BACKEND/var/log"
RESET_DB=0

for arg in "$@"; do
  case "$arg" in
    --reset) RESET_DB=1 ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m[borrow-next-door]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[borrow-next-door]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[borrow-next-door]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- checks ----------
command -v node >/dev/null 2>&1 || die "Node.js is required (https://nodejs.org)."
command -v curl >/dev/null 2>&1 || die "curl is required."

PY=""
for cand in python3.13 python3.12 python3.11 python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[[ -n "$PY" ]] || die "Python 3.11+ is required."
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || die "Python 3.11+ is required ($PY is older)."

port_busy() {
  # True when something already listens on the port.
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}
if port_busy "$BACKEND_PORT"; then
  die "Port $BACKEND_PORT is already in use — stop the other backend (or set BACKEND_PORT=...)."
fi
if port_busy "$FRONTEND_PORT"; then
  die "Port $FRONTEND_PORT is already in use — stop the other frontend (or set FRONTEND_PORT=...)."
fi

# ---------- runtime config ----------
# No access code: demo sign-in only needs a user alias (alice/bob/carol).
# A stale DEMO_ACCESS_CODE in the environment is ignored by the backend.
unset DEMO_ACCESS_CODE
export APP_MODE="${APP_MODE:-demo}"
export DATABASE_PATH="${DATABASE_PATH:-./var/borrow-next-door.sqlite3}"

# ---------- backend environment ----------
say "Preparing Python environment ($PY)…"
if [[ ! -d "$VENV" ]]; then
  "$PY" -m venv "$VENV" || die "Failed to create virtualenv at $VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$BACKEND/requirements.txt"

# ---------- database ----------
if [[ "$RESET_DB" == "1" || ! -f "$BACKEND/var/borrow-next-door.sqlite3" ]]; then
  say "Initialising demo database…"
  (cd "$BACKEND" && "$VENV/bin/python" scripts/reset_db.py) >/dev/null
else
  say "Existing demo database kept (use ./start.sh --reset to rebuild)."
fi

# ---------- start processes ----------
mkdir -p "$LOG_DIR"
BACKEND_LOG="$LOG_DIR/uvicorn.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

say "Starting backend  → http://127.0.0.1:$BACKEND_PORT  (log: ${BACKEND_LOG#"$ROOT/"})"
(
  cd "$BACKEND"
  exec "$VENV/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
) >"$BACKEND_LOG" 2>&1 &
BACK_PID=$!

say "Starting frontend → http://127.0.0.1:$FRONTEND_PORT (log: ${FRONTEND_LOG#"$ROOT/"})"
FRONTEND_PORT="$FRONTEND_PORT" node "$ROOT/server.cjs" >"$FRONTEND_LOG" 2>&1 &
FRONT_PID=$!

cleanup() {
  trap - INT TERM EXIT
  echo
  say "Stopping…"
  kill "$BACK_PID" "$FRONT_PID" >/dev/null 2>&1 || true
  wait "$BACK_PID" "$FRONT_PID" >/dev/null 2>&1 || true
  say "Stopped. See you next time."
}
trap cleanup INT TERM EXIT

# ---------- readiness ----------
say "Waiting for the backend to become ready…"
ready=0
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/health/ready" >/dev/null 2>&1; then
    ready=1; break
  fi
  kill -0 "$BACK_PID" 2>/dev/null || die "Backend exited early — see ${BACKEND_LOG#"$ROOT/"}"
  sleep 0.5
done
[[ "$ready" == "1" ]] || die "Backend did not become ready in 20s — see ${BACKEND_LOG#"$ROOT/"}"

curl -sf "http://127.0.0.1:$FRONTEND_PORT/" >/dev/null 2>&1 \
  || die "Frontend did not start — see ${FRONTEND_LOG#"$ROOT/"}"

# ---------- open the browser (best effort) ----------
URL="http://127.0.0.1:$FRONTEND_PORT"
if command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi

# ---------- banner ----------
echo
say "──────────────────────────────────────────────────────"
say " Borrow Next Door is running"
say "   Frontend  $URL"
say "   Backend   http://127.0.0.1:$BACKEND_PORT  (API docs: /docs)"
say "   API base  http://127.0.0.1:$BACKEND_PORT/api/v1"
echo
say "   Sign in with a demo account: alice / bob / carol  (no access code)"
say "   Two-window demo: open $URL in a normal and a"
say "   private window, sign in as Alice and Bob — data is shared live."
say "   Reset data:      ./start.sh --reset"
say "   Stop:            Ctrl+C"
say "──────────────────────────────────────────────────────"
echo

wait "$BACK_PID" "$FRONT_PID"
