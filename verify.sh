#!/usr/bin/env bash
# Full verification: everything that must pass before this ships.
#
# Exists because "it works" was previously spread across half a dozen
# commands that had to be remembered and run in the right order, against a
# database in the right state. A single command that either passes or fails
# is the difference between verification being routine and being skipped.
#
# Fails fast and loudly - a partial pass is not a pass.
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${CYAN}==> $1${NC}"; }
fail() { echo -e "${RED}FAILED: $1${NC}"; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

step "Checking Postgres is reachable"
# Verification that silently skips the database would be worthless - most
# of the test suite runs against a real one.
pg_isready -q || fail "Postgres isn't running. Start it and retry."

step "Installing backend dependencies"
(cd backend && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null) || fail "backend install"

step "Applying migrations"
(cd backend && npm run migrate) || fail "migrations"

step "Backend lint"
(cd backend && npx eslint . --ignore-pattern node_modules --ignore-pattern uploads) || fail "backend lint"

step "Backend tests"
(cd backend && npm test) || fail "backend tests"

step "Installing frontend dependencies"
(cd frontend && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null) || fail "frontend install"

step "Frontend lint"
(cd frontend && npx eslint . --ignore-pattern node_modules --ignore-pattern dist) || fail "frontend lint"

step "Frontend build"
(cd frontend && npx vite build) || fail "frontend build"

step "Smoke test against a real running server"
# Checked before starting the server so a missing .env produces the actual
# instruction rather than a connection-refused and an opaque 000.
if [ ! -f "$ROOT/backend/.env" ]; then
  fail "backend/.env is missing. Copy backend/.env.example to backend/.env and set JWT_SECRET, then re-run."
fi
# A passing build proves imports resolve, not that the process starts or
# that authentication still applies. This starts the actual server and
# checks a few endpoints over HTTP, including that protected ones still
# refuse anonymous callers - a 200 there would mean auth had silently
# stopped being enforced, which no unit test would necessarily catch.
(cd "$ROOT/backend" && node server.js > /tmp/verify_server.log 2>&1 & echo $! > /tmp/verify_server.pid)
sleep 5
SERVER_PID="$(cat /tmp/verify_server.pid)"

smoke() { # smoke <label> <path> <expected-status>
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:4000$2" || echo 000)"
  if [ "$code" = "$3" ]; then
    echo -e "  ${GREEN}ok${NC} $1 ($code)"
  else
    kill "$SERVER_PID" 2>/dev/null || true
    fail "$1 - expected $3, got $code"
  fi
}

smoke "health"             "/api/health"             "200"
smoke "public listings"    "/api/listings"           "200"
smoke "marketplace config" "/api/meta/config"        "200"
smoke "auth required"      "/api/transactions/mine"  "401"
smoke "admin required"     "/api/analytics/platform" "401"
smoke "privacy export gated" "/api/privacy/export"   "401"
# Must NOT exist on the public app: operational data (including unresolved
# payment discrepancies) moved to a separate internal listener, and a 200
# here would mean it had been reinstated.
smoke "metrics off public app" "/metrics"             "404"

kill "$SERVER_PID" 2>/dev/null || true

echo -e "\n${GREEN}All checks passed.${NC}"
