# ============================================================
#  Web3 Analytics Dashboard — Stop All Services (PowerShell)
# ============================================================
#  Usage:  .\stop-all.ps1
# ============================================================

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "  Stopping Web3 Analytics Dashboard..." -ForegroundColor Yellow
Write-Host ""

# Stop Hardhat node
Write-Host "  Stopping Hardhat nodes..." -ForegroundColor Gray
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.MainModule.FileName -match "hardhat" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue

# Stop backend (node processes on port 3001)
Write-Host "  Stopping backend server..." -ForegroundColor Gray
$backendPids = netstat -ano 2>$null | Select-String ":3001" | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique
foreach ($pid in $backendPids) {
    if ($pid -match '^\d+$' -and $pid -ne '0') {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
}

# Stop Docker PostgreSQL
Write-Host "  Stopping PostgreSQL container..." -ForegroundColor Gray
docker-compose down 2>$null

Write-Host ""
Write-Host "  All services stopped." -ForegroundColor Green
Write-Host ""
