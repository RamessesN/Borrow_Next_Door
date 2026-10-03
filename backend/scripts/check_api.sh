#!/usr/bin/env bash
# Borrow Next Door backend — API smoke check.
# Verifies health endpoints and a demo login against a running server.
#
# Usage (from backend/):
#   ./scripts/check_api.sh
#
# Demo login needs only USER_ALIAS; no access code is required.
# Environment:
#   BASE_URL          optional, default http://127.0.0.1:8000
#   USER_ALIAS        optional, default alice
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
USER_ALIAS="${USER_ALIAS:-alice}"

PY=".venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "ERROR: .venv/bin/python not found; create the venv first (see README.md)." >&2
  exit 1
fi

pass_count=0
fail_count=0

check() {
  local name="$1" url="$2" token="${3:-}"
  local args=(-sS -o /tmp/bnd_check_body -w "%{http_code}")
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  local code
  code="$(curl "${args[@]}" "$url")"
  if [[ "$code" =~ ^2 ]]; then
    echo "PASS $name (HTTP $code)"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL $name (HTTP $code): $(cat /tmp/bnd_check_body)"
    fail_count=$((fail_count + 1))
  fi
}

echo "== Borrow Next Door API smoke check =="
echo "base_url: $BASE_URL"

check "health/live"  "$BASE_URL/health/live"
check "health/ready" "$BASE_URL/health/ready"

login_body="$("$PY" - "$USER_ALIAS" <<'PYEOF'
import json, sys
print(json.dumps({"user_alias": sys.argv[1]}))
PYEOF
)"

code="$(curl -sS -o /tmp/bnd_check_body -w "%{http_code}" \
  -X POST "$BASE_URL/api/v1/demo/sessions" \
  -H "Content-Type: application/json" \
  -d "$login_body")"

if [[ "$code" == "201" ]]; then
  echo "POST /api/v1/demo/sessions (HTTP 201)"
  pass_count=$((pass_count + 1))
  token="$("$PY" -c 'import json; print(json.load(open("/tmp/bnd_check_body"))["data"]["access_token"])')"
  check "GET /api/v1/me" "$BASE_URL/api/v1/me" "$token"
else
  echo "FAIL POST /api/v1/demo/sessions (HTTP $code): $(cat /tmp/bnd_check_body)"
  fail_count=$((fail_count + 1))
fi

rm -f /tmp/bnd_check_body

echo "== result: $pass_count passed, $fail_count failed =="
[[ "$fail_count" -eq 0 ]]
