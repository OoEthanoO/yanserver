[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$Sha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Commit,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$runtimeRoot = 'C:\ProgramData\YanServer'
$mainCaddy = 'C:\Users\ethan\finprint\scripts\selfhost\Caddyfile'
$caddy = 'C:\Users\ethan\AppData\Local\Microsoft\WinGet\Links\caddy.exe'
$utf8 = New-Object Text.UTF8Encoding $false
function Json-Write($File, $Value) { [IO.File]::WriteAllText($File, ($Value|ConvertTo-Json -Depth 8), $utf8) }
function Native-Check($File, [string[]]$ArgumentList) {
    $previous=$ErrorActionPreference; $ErrorActionPreference='Continue'
    try { & $File @ArgumentList >> (Join-Path $runtimeRoot 'logs\install.log') 2>&1; $code=$LASTEXITCODE } finally {$ErrorActionPreference=$previous}
    if($code -ne 0){throw "Command failed ($code): $File. See install.log."}
}
function Stop-Owned($state) {
    if (-not $state) {return}
    $expectedPrefix = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'releases')).TrimEnd('\') + '\'
    $resolvedRelease = [IO.Path]::GetFullPath($state.release)
    if(-not $resolvedRelease.StartsWith($expectedPrefix,[StringComparison]::OrdinalIgnoreCase) -or $state.task -notmatch '^yanserver-web-[a-f0-9]{12}-\d{14}$'){throw 'Refusing to stop a task with invalid ownership metadata.'}
    $task=Get-ScheduledTask -TaskName $state.task -ErrorAction SilentlyContinue
    if($task){
        if(-not $task.Actions.Arguments.Contains($resolvedRelease)){throw 'Task ownership mismatch.'}
        Disable-ScheduledTask -TaskName $state.task | Out-Null
        Stop-ScheduledTask -TaskName $state.task
    }
    $entry = Join-Path $resolvedRelease 'server.mjs'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($entry)} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
New-Item -ItemType Directory -Force -Path $runtimeRoot,(Join-Path $runtimeRoot 'logs'),(Join-Path $runtimeRoot 'releases'),(Join-Path $runtimeRoot 'data') | Out-Null
$deployLock = [IO.File]::Open((Join-Path $runtimeRoot 'deploy.lock'),'OpenOrCreate','ReadWrite','None')
$stateFile = Join-Path $runtimeRoot 'active.json'
$previousState = if(Test-Path -LiteralPath $stateFile){Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json}else{$null}
$nextState = $null
try {
    $stream=[IO.File]::OpenRead($Archive);$hasher=[Security.Cryptography.SHA256]::Create()
    try{$actual=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','')}finally{$stream.Dispose();$hasher.Dispose()}
    if($actual -ne $Sha256){throw 'Archive checksum mismatch.'}
    $stamp=Get-Date -Format yyyyMMddHHmmss
    $release=Join-Path $runtimeRoot ('releases\'+$Commit.Substring(0,12)+'-'+$stamp)
    New-Item -ItemType Directory -Path $release | Out-Null
    Native-Check (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf',$Archive,'-C',$release)
    $port=if($previousState -and $previousState.port -eq 3800){3801}else{3800}
    if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){throw "Port $port is already occupied."}
    $taskName='yanserver-web-'+$Commit.Substring(0,12)+'-'+$stamp
    $nextState=[ordered]@{commit=$Commit;release=$release;port=$port;task=$taskName;installedAt=[DateTime]::UtcNow.ToString('o');published=[bool]$Publish}
    # Keep the current release serving until the candidate passes live readiness.
    # Only the release named by active.json writes shared history.
    $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}\deploy\run.ps1" -Release "{0}" -Port {1} -Commit {2}' -f $release,$port,$Commit
    $action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments -WorkingDirectory $release
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtStartup) -User SYSTEM -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $ready=$false
    for($i=0;$i -lt 25;$i++){
        Start-Sleep -Seconds 2
        try{
            $health=Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 3
            $status=Invoke-RestMethod "http://127.0.0.1:$port/api/status" -TimeoutSec 3
            if($health.commit -eq $Commit -and -not $status.stale -and -not $status.collectorStale -and $status.sites.Count -gt 0){$ready=$true;break}
        }catch{}
    }
    if(-not $ready){throw 'New release did not pass metrics and website readiness checks.'}
    Json-Write (Join-Path $runtimeRoot 'candidate.json') $nextState
    if($Publish){
        $sitePath=Join-Path $runtimeRoot 'Caddyfile'
        $mainBefore=[IO.File]::ReadAllText($mainCaddy)
        $siteBefore=if(Test-Path -LiteralPath $sitePath){[IO.File]::ReadAllText($sitePath)}else{$null}
        $snippet=@"
server.ethanyanxu.com {
    encode zstd gzip
    header X-YanServer-Host finprint-host
    reverse_proxy 127.0.0.1:$port
    log {
        output file C:/ProgramData/YanServer/logs/access.log {
            roll_size 5MB
            roll_keep 2
        }
    }
}
"@
        $nextMain=$mainBefore
        if(-not $mainBefore.Contains('# BEGIN YanServer (managed)')){$nextMain=$mainBefore.TrimEnd()+"`r`n`r`n# BEGIN YanServer (managed)`r`nimport C:/ProgramData/YanServer/Caddyfile`r`n# END YanServer (managed)`r`n"}
        [IO.File]::WriteAllText((Join-Path $runtimeRoot ('logs\Caddyfile-before-'+$stamp)), $mainBefore, $utf8)
        try {
            [IO.File]::WriteAllText($sitePath,$snippet,$utf8)
            if([IO.File]::ReadAllText($mainCaddy) -ne $mainBefore){throw 'Shared Caddyfile changed during deployment; retry.'}
            [IO.File]::WriteAllText($mainCaddy,$nextMain,$utf8)
            Native-Check $caddy @('validate','--config',$mainCaddy,'--adapter','caddyfile')
            Native-Check $caddy @('reload','--config',$mainCaddy,'--adapter','caddyfile')
        } catch {
            if([IO.File]::ReadAllText($mainCaddy) -eq $nextMain){[IO.File]::WriteAllText($mainCaddy,$mainBefore,$utf8)}
            if($null -ne $siteBefore){[IO.File]::WriteAllText($sitePath,$siteBefore,$utf8)}
            try{Native-Check $caddy @('reload','--config',$mainCaddy,'--adapter','caddyfile')}catch{}
            throw
        }
    }
    if($previousState){Json-Write (Join-Path $runtimeRoot 'previous.json') $previousState}
    Json-Write $stateFile $nextState
    if($previousState){Stop-Owned $previousState}
    Write-Output ("READY commit=$Commit port=$port sites="+$status.sites.Count)
} catch {
    if($nextState){try{Stop-Owned ([pscustomobject]$nextState)}catch{}}
    if($previousState){Enable-ScheduledTask -TaskName $previousState.task|Out-Null;Start-ScheduledTask -TaskName $previousState.task}
    Write-Output ('INSTALL FAILED: '+$_.Exception.Message)
    exit 1
} finally { $deployLock.Dispose() }
