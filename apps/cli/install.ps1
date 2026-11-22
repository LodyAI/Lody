param(
  [ValidateSet('stable','next','nightly')][string]$Channel='stable',
  [string]$Auth='',
  [switch]$NoStart,
  [switch]$Replace,
  [switch]$NoModifyPath
)
$ErrorActionPreference='Stop'
$base=if($env:LODY_INSTALL_BASE_URL){$env:LODY_INSTALL_BASE_URL.TrimEnd('/')}else{'__LODY_INSTALL_ORIGIN__'}
$origin=[Uri]$base
if($origin.Scheme -ne 'https' -and -not($origin.Scheme -eq 'http' -and $origin.IsLoopback)){throw 'Installer origin must use HTTPS'}
$architecture=[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$platform=switch($architecture){'x64'{'win32-x64'} 'arm64'{'win32-arm64'} default{throw 'Unsupported Windows architecture'}}
$tmp=Join-Path ([IO.Path]::GetTempPath()) ('lody-install-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tmp) | Out-Null
try {
  $response=Invoke-WebRequest -UseBasicParsing -Uri "$base/api/install/daemon/$Channel/$platform" -TimeoutSec 120
  if($response.Content.Length -gt 131072){throw 'Oversized release metadata'}
  $lines=([string]$response.Content).TrimEnd("`n").Split("`n")
  if($lines.Count -ne 11 -or $lines[0] -ne 'LODY-DAEMON-INSTALL-1' -or $lines[1] -ne 'lody-cloud' -or $lines[4] -ne $Channel -or $lines[5] -ne $platform -or $lines[6] -ne 'daemon.gz'){throw 'Release identity mismatch'}
  $distribution=if($Channel -eq 'next'){'lody-cloud-next-daemon'}else{'lody-cloud-daemon'}
  if($lines[2] -ne $distribution -or $lines[3] -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$'){throw 'Invalid release distribution/version'}
  foreach($index in @(7,9)){if($lines[$index] -notmatch '^[a-f0-9]{64}$'){throw 'Invalid SHA-256'}}
  foreach($index in @(8,10)){if($lines[$index] -notmatch '^[1-9][0-9]{0,9}$' -or [long]$lines[$index] -gt 1073741824){throw 'Invalid release size'}}
  $releaseBase="$base/api/runtimes/$distribution/$($lines[3])/$platform"
  $archive=Join-Path $tmp 'daemon.gz'; $exe=Join-Path $tmp 'daemon.exe'; $node=Join-Path $tmp 'node.gz'
  Write-Host "Downloading Lody $($lines[3]) for $platform..."
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/daemon.gz" -OutFile $archive -TimeoutSec 600
  if((Get-Item -LiteralPath $archive).Length -ne [long]$lines[8] -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lines[7]){throw 'Downloaded archive failed SHA-256/size verification'}
  $inputStream=[IO.File]::OpenRead($archive); $outputStream=[IO.File]::Create($exe)
  $gzip=[IO.Compression.GZipStream]::new($inputStream,[IO.Compression.CompressionMode]::Decompress)
  try{$gzip.CopyTo($outputStream)}finally{$gzip.Dispose();$inputStream.Dispose();$outputStream.Dispose()}
  if((Get-Item -LiteralPath $exe).Length -ne [long]$lines[10] -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lines[9]){throw 'Executable failed SHA-256/size verification'}
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/node.gz" -OutFile $node -TimeoutSec 600
  & $exe __sea-install-node $node
  if($LASTEXITCODE -ne 0){throw 'Managed Node verification/installation failed'}
  if($NoStart -and $Auth){throw '-Auth connects and starts this machine; it cannot be combined with -NoStart.'}
  $installArgs=if($NoStart){@('daemon','install')}elseif($Auth){@('daemon','install','--start','--autostart','--auth',$Auth)}else{@('daemon','install','--start','--autostart')}
  if($Replace){$installArgs+='--replace'}
  if($NoModifyPath){$installArgs+='--no-modify-path'}
  & $exe @installArgs
  if($LASTEXITCODE -ne 0){throw 'Daemon installation/start failed'}
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
