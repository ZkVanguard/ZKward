# Control script for the local AI stack served through Cloudflare Tunnel.
# Usage:
#   bun run local:status
#   bun run local:pause
#   bun run local:resume
#   bun run local:rerun

param(
  [Parameter(Position=0)][ValidateSet('status','pause','resume','rerun')][string]$Command = 'status',
  [Parameter(Position=1)][ValidateSet('all','model','tunnel','zk')][string]$Target = 'all'
)

function Write-Status {
  Write-Host ""
  Write-Host "== Local AI stack status =="

  $svc = Get-Service -Name 'cloudflared' -EA SilentlyContinue
  if ($svc) {
    Write-Host "  cloudflared (SYSTEM):  $($svc.Status)  StartType=$($svc.StartType)"
  } else {
    Write-Host "  cloudflared (SYSTEM):  NOT INSTALLED"
  }

  foreach ($t in @('AI-Zkward Model','ZK-API')) {
    $task = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
    if ($task) {
      $info = Get-ScheduledTaskInfo -TaskName $t
      Write-Host "  $t : $($task.State)  last=$($info.LastRunTime)  result=$($info.LastTaskResult)"
    } else {
      Write-Host "  $t : NOT REGISTERED"
    }
  }

  Write-Host ""
  Write-Host "== Public health =="
  try {
    $r = Invoke-RestMethod -Uri 'https://ai.zkward.com/health' -TimeoutSec 5 -EA Stop
    Write-Host "  ai.zkward.com:         HTTP 200  model=$($r.model) device=$($r.device)"
  } catch {
    Write-Host "  ai.zkward.com:         unreachable"
  }
  try {
    $r = Invoke-RestMethod -Uri 'https://zk-api.starknova.xyz/' -TimeoutSec 5 -EA Stop
    Write-Host "  zk-api.starknova.xyz:  HTTP 200  status=$($r.status) version=$($r.version)"
  } catch {
    Write-Host "  zk-api.starknova.xyz:  unreachable"
  }
  Write-Host ""
}

function Stop-One {
  param([string]$name)
  $t = Get-ScheduledTask -TaskName $name -EA SilentlyContinue
  if (-not $t) {
    Write-Host "  $name not registered - skipping"
    return
  }
  if ($t.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $name
    Write-Host "  stopped $name"
  } else {
    Write-Host "  $name already idle"
  }
  if ($name -eq 'AI-Zkward Model') {
    wsl -e bash -lc "pkill -9 -f 'serve-model.py' 2>/dev/null" 2>$null
  } elseif ($name -eq 'ZK-API') {
    Get-Process python -EA SilentlyContinue | Where-Object { $_.SessionId -ne 0 } | Stop-Process -Force -EA SilentlyContinue
    Get-Process cloudflared -EA SilentlyContinue | Where-Object { $_.SessionId -ne 0 } | Stop-Process -Force -EA SilentlyContinue
  }
}

function Start-One {
  param([string]$name)
  $t = Get-ScheduledTask -TaskName $name -EA SilentlyContinue
  if (-not $t) {
    Write-Host "  $name not registered"
    return
  }
  Start-ScheduledTask -TaskName $name
  Start-Sleep 2
  $info = Get-ScheduledTaskInfo -TaskName $name
  if ($info.LastTaskResult -eq 267009 -or $info.LastTaskResult -eq 0) {
    Write-Host "  started $name  (result=$($info.LastTaskResult))"
  } else {
    Write-Host "  FAILED to start $name  (result=$($info.LastTaskResult))"
  }
}

function Warn-CloudflaredAdmin {
  Write-Host "  cloudflared service state needs admin - run in an elevated shell:"
  Write-Host "    Stop-Service cloudflared      # to pause tunnel"
  Write-Host "    Start-Service cloudflared     # to resume tunnel"
  Write-Host "    Restart-Service cloudflared   # to rerun tunnel"
}

switch ($Command) {
  'status' {
    Write-Status
  }
  'pause' {
    Write-Host "Pausing local AI stack..."
    if ($Target -eq 'all' -or $Target -eq 'model')  { Stop-One 'AI-Zkward Model' }
    if ($Target -eq 'all' -or $Target -eq 'zk')     { Stop-One 'ZK-API' }
    if ($Target -eq 'all' -or $Target -eq 'tunnel') {
      $svc = Get-Service -Name 'cloudflared' -EA SilentlyContinue
      if ($svc -and $svc.Status -eq 'Running') {
        try { Stop-Service cloudflared -EA Stop; Write-Host "  stopped cloudflared (SYSTEM)" }
        catch { Warn-CloudflaredAdmin }
      } else {
        Write-Host "  cloudflared already stopped or not installed"
      }
    }
    Write-Status
  }
  'resume' {
    Write-Host "Resuming local AI stack..."
    if ($Target -eq 'all' -or $Target -eq 'tunnel') {
      $svc = Get-Service -Name 'cloudflared' -EA SilentlyContinue
      if ($svc) {
        if ($svc.Status -ne 'Running') {
          try { Start-Service cloudflared -EA Stop; Write-Host "  started cloudflared (SYSTEM)" }
          catch { Warn-CloudflaredAdmin }
        } else {
          Write-Host "  cloudflared already running"
        }
      }
    }
    if ($Target -eq 'all' -or $Target -eq 'zk')    { Start-One 'ZK-API' }
    if ($Target -eq 'all' -or $Target -eq 'model') { Start-One 'AI-Zkward Model' }
    Write-Status
  }
  'rerun' {
    Write-Host "Restarting local AI stack ($Target)..."
    if ($Target -eq 'all' -or $Target -eq 'model')  { Stop-One 'AI-Zkward Model' }
    if ($Target -eq 'all' -or $Target -eq 'zk')     { Stop-One 'ZK-API' }
    if ($Target -eq 'all' -or $Target -eq 'tunnel') {
      $svc = Get-Service -Name 'cloudflared' -EA SilentlyContinue
      if ($svc -and $svc.Status -eq 'Running') {
        try { Restart-Service cloudflared -EA Stop; Write-Host "  restarted cloudflared (SYSTEM)" }
        catch { Warn-CloudflaredAdmin }
      }
    }
    Start-Sleep 2
    if ($Target -eq 'all' -or $Target -eq 'model') { Start-One 'AI-Zkward Model' }
    if ($Target -eq 'all' -or $Target -eq 'zk')    { Start-One 'ZK-API' }
    Write-Status
  }
}
