# ============================================================
#  Web3 Analytics Dashboard — Local Quick Start (PowerShell)
# ============================================================
#  Usage:  .\start-local.ps1
#  Or:     npm run start:local
#
#  This script launches everything in the correct order:
#    1. PostgreSQL (Docker)
#    2. Hardhat local node
#    3. Deploy & seed contracts
#    4. Backend ingestor
#    5. Opens the dashboard in your browser
# ============================================================

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot

Write-Host ""
Write-Host "  =====================================================" -ForegroundColor Cyan
Write-Host "   Web3 Analytics Dashboard — Local Quick Start" -ForegroundColor Cyan
Write-Host "  =====================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. PostgreSQL via Docker ────────────────────────────────
Write-Host "[1/5] " -NoNewline -ForegroundColor Yellow
Write-Host "Starting PostgreSQL (Docker)..."
docker-compose -f "$root\docker-compose.yml" up -d
Write-Host "       PostgreSQL is up!" -ForegroundColor Green
Start-Sleep -Seconds 3

# ── 2. Hardhat Node ─────────────────────────────────────────
Write-Host "[2/5] " -NoNewline -ForegroundColor Yellow
Write-Host "Starting Hardhat local node (background)..."
$hardhatJob = Start-Process -FilePath "npx" `
    -ArgumentList "--no-install", "hardhat", "node" `
    -WorkingDirectory "$root\blockchain" `
    -WindowStyle Minimized `
    -PassThru
Write-Host "       Hardhat node PID: $($hardhatJob.Id)" -ForegroundColor Green
Start-Sleep -Seconds 4

# ── 3. Deploy & Seed ────────────────────────────────────────
Write-Host "[3/5] " -NoNewline -ForegroundColor Yellow
Write-Host "Deploying AnalyticsToken & seeding transactions..."
Push-Location "$root\blockchain"
npx --no-install hardhat run scripts/deploy.js --network localhost
npx --no-install hardhat run scripts/seed.js --network localhost
Pop-Location
Write-Host "       Deploy & seed complete!" -ForegroundColor Green

# ── 4. Backend Ingestor ─────────────────────────────────────
Write-Host "[4/5] " -NoNewline -ForegroundColor Yellow
Write-Host "Starting backend ingestor (background)..."
$backendJob = Start-Process -FilePath "node" `
    -ArgumentList "src/server.js" `
    -WorkingDirectory "$root\backend" `
    -WindowStyle Minimized `
    -PassThru
Write-Host "       Backend PID: $($backendJob.Id)" -ForegroundColor Green
Start-Sleep -Seconds 3

# ── 5. Open Dashboard ──────────────────────────────────────
Write-Host "[5/5] " -NoNewline -ForegroundColor Yellow
Write-Host "Opening dashboard in browser..."
Start-Process "http://localhost:3001"

Write-Host ""
Write-Host "  =====================================================" -ForegroundColor Green
Write-Host "   All systems GO!" -ForegroundColor Green
Write-Host "  =====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Hardhat Node    : http://localhost:8545  (PID $($hardhatJob.Id))" -ForegroundColor White
Write-Host "  Backend API     : http://localhost:3001  (PID $($backendJob.Id))" -ForegroundColor White
Write-Host "  Dashboard       : http://localhost:3001  (browser)" -ForegroundColor White
Write-Host ""
Write-Host "  To stop everything:" -ForegroundColor Gray
Write-Host "    Stop-Process -Id $($hardhatJob.Id),$($backendJob.Id)" -ForegroundColor DarkGray
Write-Host "    docker-compose down" -ForegroundColor DarkGray
Write-Host ""
