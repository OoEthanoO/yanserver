[CmdletBinding()]
param([switch]$PrepareDns)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$remoteRoot='C:\ProgramData\YanServer'
function Remote([string]$Script) {
    $payload=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    $saved=$ErrorActionPreference;$ErrorActionPreference='Continue'
    try{& 'C:\Windows\System32\OpenSSH\ssh.exe' -o BatchMode=yes finprint-host "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand $payload" 2>$null | Out-Host;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$saved}
    if($code -ne 0){throw "Remote step failed ($code)."}
}
Set-Location -LiteralPath $repo
$commit=(& git.exe rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$'){throw 'A committed release is required.'}
if(& git.exe status --porcelain){throw 'Commit changes before deployment.'}
& npm.cmd run check
if($LASTEXITCODE -ne 0){throw 'Syntax checks failed.'}
& npm.cmd test
if($LASTEXITCODE -ne 0){throw 'Tests failed.'}
$archive=Join-Path $env:TEMP ('yanserver-'+[guid]::NewGuid().ToString('N')+'.tar')
try {
    & git.exe archive --format=tar --output $archive $commit
    if($LASTEXITCODE -ne 0){throw 'Archive failed.'}
    $sha=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    Remote "New-Item -ItemType Directory -Force -Path '$remoteRoot','$remoteRoot\incoming' | Out-Null; & icacls.exe '$remoteRoot' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null; if (`$LASTEXITCODE -ne 0){exit 1}"
    & 'C:\Windows\System32\OpenSSH\scp.exe' -q $archive 'finprint-host:C:/ProgramData/YanServer/incoming/release.tar'
    if($LASTEXITCODE -ne 0){throw 'Archive upload failed.'}
    & 'C:\Windows\System32\OpenSSH\scp.exe' -q (Join-Path $PSScriptRoot 'install.ps1') (Join-Path $PSScriptRoot 'dns.ps1') 'finprint-host:C:/ProgramData/YanServer/'
    if($LASTEXITCODE -ne 0){throw 'Installer upload failed.'}
    if($PrepareDns){Remote "& '$remoteRoot\dns.ps1'"; Write-Output 'Verify public DNS before running the publish step.'; return}
    Remote "& '$remoteRoot\install.ps1' -Archive '$remoteRoot\incoming\release.tar' -Sha256 '$sha' -Commit '$commit' -Publish"
    $health=& 'C:\Windows\System32\curl.exe' --silent --show-error --fail --max-time 30 --ssl-revoke-best-effort 'https://server.ethanyanxu.com/api/health'
    if($LASTEXITCODE -ne 0){throw 'Public HTTPS verification failed.'}
    $obj=$health|ConvertFrom-Json
    if($obj.commit -ne $commit){throw 'Public server returned an unexpected release.'}
    Write-Output "Published https://server.ethanyanxu.com ($commit)"
} finally {if(Test-Path -LiteralPath $archive){Remove-Item -LiteralPath $archive -Force}}
