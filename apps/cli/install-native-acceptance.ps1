param([string]$Fixture,[string]$Installer,[string]$Probe)
$ErrorActionPreference='Stop'
function Invoke-WebRequest {
  param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile,[int]$TimeoutSec)
  if($Uri -like '*/api/install/daemon/*'){return [pscustomobject]@{Content=[IO.File]::ReadAllText((Join-Path $Fixture 'metadata'))}}
  $source=if($Uri.EndsWith('/daemon.gz')){'daemon.gz'}elseif($Uri.EndsWith('/node.gz')){'node.gz'}else{throw 'Unexpected installer request'}
  Copy-Item -LiteralPath (Join-Path $Fixture $source) -Destination $OutFile
}
& $Installer -Channel $env:LODY_NATIVE_INSTALL_CHANNEL -NoStart
if($LASTEXITCODE -ne 0){throw 'Standalone PowerShell installation failed'}
# Optional system integration: register a uniquely named task but never launch it.
# Always remove only the task created for this isolated test profile.
$id=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($env:LODY_DATA_DIR)))).Replace('-','').ToLowerInvariant().Substring(0,12)
$name="lody-daemon-$id"; $marker="Lody managed daemon $id"
if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw 'Existing task name collision; no task was changed'}
try {
  & $Probe daemon install --autostart
  if($LASTEXITCODE -ne 0){throw 'Optional startup registration command failed'}
  $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if($task){
    if($task.Description -ne $marker){throw 'Unexpected task owner'}
    if($task.Settings.ExecutionTimeLimit -ne 'PT0S' -or $task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries){throw 'Daemon task has a duration or battery stop policy'}
    Write-Host 'Windows scheduled-task settings verified'
  } else {Write-Host 'Windows scheduled-task registration unavailable; initial installation still succeeded'}
} finally {
  $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if($task -and $task.Description -eq $marker){Unregister-ScheduledTask -TaskName $name -Confirm:$false}
}
