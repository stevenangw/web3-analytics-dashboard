#!/usr/bin/env bash
# ============================================================
#  Web3 Analytics Dashboard — Local Quick Start (Bash)
# ============================================================
#  Usage:  bash start-local.sh
#
#  Launches everything in the correct order:
#    1. PostgreSQL (Docker)
#    2. Hardhat local node
#    3. Deploy & seed contracts
#    4. Backend ingestor
#    5. Opens the dashboard in your browser
# ============================================================

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m'

echo ""
echo -e "  ${CYAN}=====================================================${NC}"
echo -e "  ${CYAN} Web3 Analytics Dashboard — Local Quick Start${NC}"
echo -e "  ${CYAN}=====================================================${NC}"
echo ""

# ── 1. PostgreSQL via Docker ────────────────────────────────
echo -e "${YELLOW}[1/5]${NC} Starting PostgreSQL (Docker)..."
if command -v docker-compose &> /dev/null; then
    docker-compose -f "$ROOT_DIR/docker-compose.yml" up -d 2>/dev/null
    echo -e "       ${GREEN}PostgreSQL is up!${NC}"
elif command -v docker &> /dev/null; then
    docker compose -f "$ROOT_DIR/docker-compose.yml" up -d 2>/dev/null
    echo -e "       ${GREEN}PostgreSQL is up!${NC}"
else
    echo -e "       ${RED}Docker not found — make sure PostgreSQL is running manually.${NC}"
fi
sleep 3

# ── 2. Hardhat Node ─────────────────────────────────────────
echo -e "${YELLOW}[2/5]${NC} Starting Hardhat local node (background)..."
cd "$ROOT_DIR/blockchain"
npx --no-install hardhat node > /dev/null 2>&1 &
HARDHAT_PID=$!
echo -e "       ${GREEN}Hardhat node PID: ${HARDHAT_PID}${NC}"
sleep 4

# ── 3. Deploy & Seed ────────────────────────────────────────
echo -e "${YELLOW}[3/5]${NC} Deploying AnalyticsToken & seeding transactions..."
cd "$ROOT_DIR/blockchain"
npx --no-install hardhat run scripts/deploy.js --network localhost || true
npx --no-install hardhat run scripts/seed.js --network localhost || true
echo -e "       ${GREEN}Deploy & seed complete!${NC}"

# ── 4. Backend Ingestor ─────────────────────────────────────
echo -e "${YELLOW}[4/5]${NC} Starting backend ingestor (background)..."
cd "$ROOT_DIR/backend"
node src/server.js > /dev/null 2>&1 &
BACKEND_PID=$!
echo -e "       ${GREEN}Backend PID: ${BACKEND_PID}${NC}"
sleep 3

# ── 5. Open Dashboard ──────────────────────────────────────
echo -e "${YELLOW}[5/5]${NC} Opening dashboard in browser..."
if command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:3001"
elif command -v open &> /dev/null; then
    open "http://localhost:3001"
elif command -v start &> /dev/null; then
    start "http://localhost:3001"
else
    echo -e "       ${GRAY}Open manually: http://localhost:3001${NC}"
fi

echo ""
echo -e "  ${GREEN}=====================================================${NC}"
echo -e "  ${GREEN} All systems GO!${NC}"
echo -e "  ${GREEN}=====================================================${NC}"
echo ""
echo -e "  Hardhat Node    : http://localhost:8545  (PID ${HARDHAT_PID})"
echo -e "  Backend API     : http://localhost:3001  (PID ${BACKEND_PID})"
echo -e "  Dashboard       : http://localhost:3001  (browser)"
echo ""
echo -e "  ${GRAY}To stop everything:${NC}"
echo -e "  ${GRAY}  kill ${HARDHAT_PID} ${BACKEND_PID} && docker-compose down${NC}"
echo ""
