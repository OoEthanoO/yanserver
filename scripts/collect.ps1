$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$warnings = @()
$osInfo = Get-CimInstance Win32_OperatingSystem
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{name=[string]$_.DeviceID; totalBytes=[double]$_.Size; freeBytes=[double]$_.FreeSpace}
})
$processes = @(Get-Process | Where-Object {$_.Id -ne 0} | ForEach-Object {
    [ordered]@{pid=$_.Id;name=[string]$_.ProcessName;cpuSeconds=[double]$_.CPU;memoryBytes=[double]$_.WorkingSet64}
})
$network = $null
try {
    $stats = @(Get-NetAdapter -Physical | Where-Object {$_.Status -eq 'Up'} | Get-NetAdapterStatistics)
    if($stats.Count -gt 0) { $network = [ordered]@{received=[double](($stats|Measure-Object ReceivedBytes -Sum).Sum);sent=[double](($stats|Measure-Object SentBytes -Sum).Sum)} }
} catch { $warnings += 'Network counters unavailable.' }
$gpus = @()
try {
    $smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
    if(Test-Path -LiteralPath $smi) {
        $lines = & $smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
        if ($LASTEXITCODE -eq 0) {
            function Number-OrNull($value) { $n=0.0; if([double]::TryParse($value.Trim(),[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture,[ref]$n)){return $n};return $null }
            $gpus = @($lines | ForEach-Object { $p=$_ -split ',\s*'; if($p.Count -eq 6){[ordered]@{name=$p[0];utilization=(Number-OrNull $p[1]);memoryUsedMb=(Number-OrNull $p[2]);memoryTotalMb=(Number-OrNull $p[3]);temperature=(Number-OrNull $p[4]);powerWatts=(Number-OrNull $p[5])}}})
        }
    }
} catch { $warnings += 'GPU sensors unavailable.' }
$tasks = @()
try {
    $tasks = @(Get-ScheduledTask | Where-Object {$_.TaskPath -eq '\' -and $_.State -ne 'Disabled' -and $_.TaskName -match '^(yan|finprint|map|chem|freedom|portfolio|strhistory|stroj|bare-metal|ethanyanxu)'} | ForEach-Object {
        $info=Get-ScheduledTaskInfo -TaskName $_.TaskName
        $periodic=$_.TaskName -match '(deploy|ddns|sync|reminders|routing)$'
        $state = if($_.State -eq 'Running'){'running'}elseif($info.LastTaskResult -eq 0 -and $periodic){'ready'}elseif($info.LastTaskResult -eq 267011){'pending'}else{'warning'}
        $commit = if($_.TaskName -match '-web-([a-f0-9]{12})-'){$Matches[1]}else{$null}
        [ordered]@{name=[string]$_.TaskName;state=$state;schedulerState=[string]$_.State;periodic=$periodic;lastResult=[long]$info.LastTaskResult;lastRun=$info.LastRunTime.ToUniversalTime().ToString('o');nextRun=if($info.NextRunTime -gt [datetime]'2000-01-01'){$info.NextRunTime.ToUniversalTime().ToString('o')}else{$null};commit=$commit}
    })
} catch { $warnings += 'Scheduled job inventory unavailable.' }
$services = @()
try {
    $services = @(Get-CimInstance Win32_Service | Where-Object {$_.Name -match '^(sshd|Amnezia|Tailscale|W3SVC|caddy|postgres|redis|docker|com\.docker|ollama)' } | ForEach-Object { [ordered]@{name=[string]$_.Name;displayName=[string]$_.DisplayName;state=[string]$_.State;startMode=[string]$_.StartMode} })
} catch { $warnings += 'Windows service inventory unavailable.' }
$listeners = @()
try { $listeners = @(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -lt 15000} | Select-Object -Property @{n='address';e={[string]$_.LocalAddress}},@{n='port';e={$_.LocalPort}},@{n='pid';e={$_.OwningProcess}}) } catch {}
[ordered]@{os=[string]$osInfo.Caption;boot=$osInfo.LastBootUpTime.ToUniversalTime().ToString('o');disks=$disks;processes=$processes;network=$network;gpus=$gpus;tasks=$tasks;services=$services;listeners=$listeners;warnings=$warnings} | ConvertTo-Json -Depth 5 -Compress
