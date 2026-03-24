#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  TradeFlow — PostgreSQL Setup Script
#  Run this from inside the tradeflow-merged/ folder
#  Usage: bash setup-postgres.sh
# ══════════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
err()  { echo -e "${RED}  ✗ $1${NC}"; exit 1; }
info() { echo -e "${BLUE}  → $1${NC}"; }

echo ""
echo -e "${BLUE}══════════════════════════════════════════${NC}"
echo -e "${BLUE}   TradeFlow — PostgreSQL Setup           ${NC}"
echo -e "${BLUE}══════════════════════════════════════════${NC}"
echo ""

# ── Check Docker is running ───────────────────────────────────
info "Checking Docker..."
docker info > /dev/null 2>&1 || err "Docker is not running. Please start Docker Desktop first."
ok "Docker is running"

# ── Load .env if present ──────────────────────────────────────
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
  ok "Loaded .env"
else
  warn ".env not found — using defaults (tradeflow / tradeflow_secret)"
fi

PGUSER=${POSTGRES_USER:-tradeflow}
PGPASS=${POSTGRES_PASSWORD:-tradeflow_secret}
PGDB=${POSTGRES_DB:-tradeflow}

# ── Start only postgres (+ dependencies) ─────────────────────
info "Starting PostgreSQL container..."
docker compose up -d postgres

# ── Wait for postgres to be healthy ──────────────────────────
info "Waiting for PostgreSQL to be ready..."
TRIES=0
MAX=30
until docker exec tf_postgres pg_isready -U "$PGUSER" -q 2>/dev/null; do
  TRIES=$((TRIES+1))
  if [ $TRIES -ge $MAX ]; then
    err "PostgreSQL did not become ready after ${MAX} attempts. Run: docker compose logs postgres"
  fi
  echo -n "."
  sleep 2
done
echo ""
ok "PostgreSQL is ready"

# ── Check if already initialised ─────────────────────────────
TABLE_COUNT=$(docker exec tf_postgres psql -U "$PGUSER" -d "$PGDB" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" 2>/dev/null || echo "0")

if [ "$TABLE_COUNT" -ge "15" ]; then
  warn "Database already has $TABLE_COUNT tables. Skipping init."
  warn "To reset: run 'bash setup-postgres.sh --reset'"
else
  info "Running schema migration (init.sql)..."
  docker exec -i tf_postgres psql -U "$PGUSER" -d "$PGDB" < docker/init.sql
  ok "Schema created"
fi

# ── Verify all 15 tables ──────────────────────────────────────
echo ""
info "Verifying tables..."
docker exec tf_postgres psql -U "$PGUSER" -d "$PGDB" -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name;" \
  2>/dev/null

TABLE_COUNT=$(docker exec tf_postgres psql -U "$PGUSER" -d "$PGDB" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
ok "$TABLE_COUNT tables present"

# ── Verify seed data ──────────────────────────────────────────
echo ""
info "Verifying seed data..."
INSTR_COUNT=$(docker exec tf_postgres psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT COUNT(*) FROM instruments;")
ok "$INSTR_COUNT instruments seeded"

ADMIN_EXISTS=$(docker exec tf_postgres psql -U "$PGUSER" -d "$PGDB" -tAc \
  "SELECT COUNT(*) FROM users WHERE email='admin@tradeflow.in';")
if [ "$ADMIN_EXISTS" -ge "1" ]; then
  ok "Admin user exists (admin@tradeflow.in / Admin@123)"
else
  warn "Admin user not found"
fi

# ── Show connection info ──────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  PostgreSQL is ready!                    ${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
echo "  Host:     localhost"
echo "  Port:     5432"
echo "  Database: $PGDB"
echo "  User:     $PGUSER"
echo "  Password: $PGPASS"
echo ""
echo "  Connect with any Postgres client:"
echo "  postgresql://$PGUSER:$PGPASS@localhost:5432/$PGDB"
echo ""
echo "  Or via terminal:"
echo "  docker exec -it tf_postgres psql -U $PGUSER -d $PGDB"
echo ""

# ── Handle --reset flag ───────────────────────────────────────
if [[ "$1" == "--reset" ]]; then
  echo ""
  warn "RESET mode — this will DELETE all data!"
  read -p "  Are you sure? (yes/no): " CONFIRM
  if [ "$CONFIRM" == "yes" ]; then
    docker compose down -v
    docker compose up -d postgres
    sleep 5
    docker exec -i tf_postgres psql -U "$PGUSER" -d "$PGDB" < docker/init.sql
    ok "Database reset and re-initialised"
  else
    info "Reset cancelled"
  fi
fi
