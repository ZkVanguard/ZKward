# PowerShell script for Windows Cloudflare Tunnel setup
# ======================================================

param(
    [string]$TunnelName = "zk-stark-api",
    [string]$Hostname = "zk-api.zkward.com"
)

Write-Host "🔐 ZK-STARK Cloudflare Tunnel Setup (Windows)" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# Check if cloudflared is installed
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    Write-Host "❌ cloudflared not found. Installing via winget..." -ForegroundColor Yellow
    winget install Cloudflare.cloudflared
    
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

Write-Host "✅ cloudflared is installed" -ForegroundColor Green

# Login to Cloudflare
Write-Host ""
Write-Host "📋 Step 1: Authenticate with Cloudflare" -ForegroundColor Yellow
Write-Host "This will open a browser window to authenticate..."
cloudflared tunnel login

# Create tunnel
Write-Host ""
Write-Host "📋 Step 2: Creating tunnel '$TunnelName'..." -ForegroundColor Yellow
cloudflared tunnel create $TunnelName

# Get tunnel ID
$tunnelInfo = cloudflared tunnel list | Select-String $TunnelName
$TunnelId = ($tunnelInfo -split '\s+')[0]
Write-Host "✅ Tunnel created with ID: $TunnelId" -ForegroundColor Green

# Create config directory
$configDir = "$env:USERPROFILE\.cloudflared"
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir | Out-Null
}

# Create config file
Write-Host ""
Write-Host "📋 Step 3: Creating configuration..." -ForegroundColor Yellow

$configContent = @"
# Cloudflare Tunnel Configuration for ZK-STARK API
tunnel: $TunnelId
credentials-file: $configDir\$TunnelId.json

ingress:
  - hostname: $Hostname
    service: http://localhost:8000
    originRequest:
      connectTimeout: 30s
      keepAliveTimeout: 120s
      http2Origin: true
      
  - service: http_status:404
"@

$configContent | Out-File -FilePath "$configDir\config.yml" -Encoding UTF8
Write-Host "✅ Configuration created at $configDir\config.yml" -ForegroundColor Green

# Route DNS
Write-Host ""
Write-Host "📋 Step 4: Setting up DNS routing..." -ForegroundColor Yellow
cloudflared tunnel route dns $TunnelName $Hostname
Write-Host "✅ DNS route created: $Hostname -> $TunnelName" -ForegroundColor Green

# Install as Windows service
Write-Host ""
Write-Host "📋 Step 5: Installing as Windows service..." -ForegroundColor Yellow
cloudflared service install
Write-Host "✅ Service installed" -ForegroundColor Green

# Start the service
Start-Service cloudflared
Write-Host "✅ Service started" -ForegroundColor Green

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "✅ Cloudflare Tunnel Setup Complete!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Your ZK-STARK API is now available at:" -ForegroundColor Cyan
Write-Host "  https://$Hostname" -ForegroundColor White
Write-Host ""
Write-Host "Update your .env with:" -ForegroundColor Cyan
Write-Host "  ZK_API_URL=https://$Hostname" -ForegroundColor White
Write-Host ""
Write-Host "To check tunnel status:" -ForegroundColor Cyan
Write-Host "  cloudflared tunnel info $TunnelName" -ForegroundColor White
Write-Host "  Get-Service cloudflared" -ForegroundColor White
Write-Host ""
