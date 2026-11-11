# Refreshes this folder from GitHub in place. Run via update.cmd.
# The extension notices the new files within ~30 seconds and reloads itself.
$ErrorActionPreference = 'Stop'
$dest = Split-Path -Parent $PSScriptRoot
if (Test-Path (Join-Path $dest '.git')) {
  if (Get-Command git -ErrorAction SilentlyContinue) { git -C $dest pull --ff-only; exit $LASTEXITCODE }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path $env:TEMP ('testpad-pocket-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host 'Downloading the latest TestPad Pocket...'
  $zip = Join-Path $tmp 'main.zip'
  Invoke-WebRequest 'https://codeload.github.com/ayeepat/testpad-pocket/zip/refs/heads/main' -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp
  $src = Join-Path $tmp 'testpad-pocket-main'
  if (-not (Test-Path (Join-Path $src 'manifest.json'))) { throw 'The download has no manifest.json.' }
  # update.cmd is running right now, so leave it; manifest.json goes last: its new version number is what triggers the reload.
  robocopy $src $dest /E /XF manifest.json update.cmd /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)." }
  Copy-Item (Join-Path $src 'manifest.json') (Join-Path $dest 'manifest.json') -Force
  $version = (Get-Content (Join-Path $dest 'manifest.json') -Raw | ConvertFrom-Json).version
  Write-Host "Done: version $version. The extension reloads itself within 30 seconds (or click its icon)."
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
