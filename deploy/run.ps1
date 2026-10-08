param([string]$Release, [int]$Port, [string]$Commit)
$ErrorActionPreference = 'Stop'
$env:PORT = [string]$Port
$env:PUBLIC_ORIGIN = 'https://server.ethanyanxu.com'
$env:YANSERVER_DATA = 'C:\ProgramData\YanServer\data'
$env:YANSERVER_COMMIT = $Commit
$env:NODE_ENV = 'production'
Set-Location -LiteralPath $Release
$log = 'C:\ProgramData\YanServer\logs\server-' + $Port + '.log'
while ($true) {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force }
    $ErrorActionPreference = 'Continue'
    & 'C:\Program Files\nodejs\node.exe' (Join-Path $Release 'server.mjs') >> $log 2>&1
    $ErrorActionPreference = 'Stop'
    Start-Sleep -Seconds 5
}
