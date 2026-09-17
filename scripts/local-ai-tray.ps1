# System-tray icon for the local AI stack.
# Green = 3/3 running · yellow = partial · red = 0/3.
# Right-click menu: status, pause/resume/restart, quick-open URLs, exit.
# Launch via `bun run local:tray` (hidden window) or shell:startup shortcut.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) { $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$localAiScript = Join-Path $scriptRoot 'local-ai.ps1'

function Get-CircleIcon {
  param([System.Drawing.Color]$Color)
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush $Color
  $g.FillEllipse($brush, 1, 1, 14, 14)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 1
  $g.DrawEllipse($pen, 1, 1, 14, 14)
  $g.Dispose(); $brush.Dispose(); $pen.Dispose()
  $handle = $bmp.GetHicon()
  return [System.Drawing.Icon]::FromHandle($handle)
}

function Get-Status {
  $svc = Get-Service -Name 'cloudflared' -EA SilentlyContinue
  $model = Get-ScheduledTask -TaskName 'AI-Zkward Model' -EA SilentlyContinue
  $zk = Get-ScheduledTask -TaskName 'ZK-API' -EA SilentlyContinue
  $running = @(); $stopped = @()
  if ($svc -and $svc.Status -eq 'Running') { $running += 'cloudflared' } else { $stopped += 'cloudflared' }
  if ($model -and $model.State -eq 'Running') { $running += 'model' } else { $stopped += 'model' }
  if ($zk -and $zk.State -eq 'Running') { $running += 'zk-api' } else { $stopped += 'zk-api' }
  return [pscustomobject]@{ Running = $running; Stopped = $stopped }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Visible = $true

function Update-Icon {
  $s = Get-Status
  $n = $s.Running.Count
  $color = if ($n -eq 3) { [System.Drawing.Color]::FromArgb(52, 199, 89) }
           elseif ($n -eq 0) { [System.Drawing.Color]::FromArgb(255, 59, 48) }
           else { [System.Drawing.Color]::FromArgb(255, 204, 0) }
  $old = $tray.Icon
  $tray.Icon = Get-CircleIcon $color
  if ($old) { $old.Dispose() }
  $tip = "ZkWard AI: $n/3 running"
  if ($s.Stopped.Count -gt 0) { $tip += "  (down: $($s.Stopped -join ', '))" }
  $tray.Text = $tip
}

function Invoke-LocalAi {
  param([string]$Command)
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$localAiScript,$Command)
  Start-Process powershell -WindowStyle Hidden -ArgumentList $args -Wait
  Update-Icon
  $s = Get-Status
  $tray.ShowBalloonTip(2000, "local-ai $Command", "$($s.Running.Count)/3 running", 'Info')
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$mStatus = $menu.Items.Add('Show status')
$mStatus.Add_Click({
  $s = Get-Status
  $msg = "Running:  " + ($(if ($s.Running.Count) { $s.Running -join ', ' } else { '(none)' })) + `
         "`nStopped:  " + ($(if ($s.Stopped.Count) { $s.Stopped -join ', ' } else { '(none)' }))
  [System.Windows.Forms.MessageBox]::Show($msg, 'ZkWard local AI') | Out-Null
})

[void]$menu.Items.Add('-')

$mPause = $menu.Items.Add('Pause all')
$mPause.Add_Click({ Invoke-LocalAi 'pause' })

$mResume = $menu.Items.Add('Resume all')
$mResume.Add_Click({ Invoke-LocalAi 'resume' })

$mRestart = $menu.Items.Add('Restart all')
$mRestart.Add_Click({ Invoke-LocalAi 'rerun' })

[void]$menu.Items.Add('-')

$mOpenAi = $menu.Items.Add('Open ai.zkward.com/health')
$mOpenAi.Add_Click({ Start-Process 'https://ai.zkward.com/health' })

$mOpenZk = $menu.Items.Add('Open zk-api.starknova.xyz')
$mOpenZk.Add_Click({ Start-Process 'https://zk-api.starknova.xyz/' })

$mOpenAgents = $menu.Items.Add('Open zkward.com/agents')
$mOpenAgents.Add_Click({ Start-Process 'https://www.zkward.com/agents' })

[void]$menu.Items.Add('-')

$mStartup = $menu.Items.Add('Install as startup')
$mStartup.Add_Click({
  $lnkDir = [Environment]::GetFolderPath('Startup')
  $lnkPath = Join-Path $lnkDir 'ZkWard-AI-Tray.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = 'powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($MyInvocation.MyCommand.Path)`""
  $lnk.WorkingDirectory = $scriptRoot
  $lnk.WindowStyle = 7
  $lnk.Save()
  [System.Windows.Forms.MessageBox]::Show("Installed at $lnkPath", 'ZkWard local AI') | Out-Null
})

$mExit = $menu.Items.Add('Exit tray')
$mExit.Add_Click({
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu
$tray.Add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Update-Icon } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.Add_Tick({ Update-Icon })
$timer.Start()

Update-Icon
[System.Windows.Forms.Application]::Run()
