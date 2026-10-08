# Only the new dashboard hostname may be created. Existing routing is preserved.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name='server.ethanyanxu.com'
$target='finprint.ethanyanxu.com'
$settings=Get-Content 'C:\ProgramData\YanLearn\secrets\cloudflare-ddns.json' -Raw|ConvertFrom-Json
Add-Type -AssemblyName System.Security
$plain=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([IO.File]::ReadAllText($settings.TokenPath)),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
$headers=@{Authorization=('Bearer '+[Text.Encoding]::UTF8.GetString($plain))}
[Array]::Clear($plain,0,$plain.Length)
$base='https://api.cloudflare.com/client/v4/zones/'+$settings.ZoneId+'/dns_records'
try {
    $existing=Invoke-RestMethod -Uri ($base+'?name='+$name) -Headers $headers -TimeoutSec 20
    if(-not $existing.success){throw 'DNS lookup failed.'}
    $records=@($existing.result)
    if($records.Count -eq 1 -and $records[0].type -eq 'CNAME' -and $records[0].content -eq $target -and -not $records[0].proxied){Write-Output 'DNS already points to finprint-host.';exit 0}
    if($records.Count -ne 0){throw 'An explicit DNS record already exists. No record was changed.'}
    $body=@{type='CNAME';name=$name;content=$target;ttl=60;proxied=$false;comment='YanServer status dashboard on finprint-host'}|ConvertTo-Json
    $created=Invoke-RestMethod -Uri $base -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 20
    if(-not $created.success){throw 'DNS creation failed.'}
    [IO.File]::WriteAllText('C:\ProgramData\YanServer\dns-created.json',($created.result|Select-Object id,name,type,content,proxied|ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
    $verified=Invoke-RestMethod -Uri ($base+'?name='+$name) -Headers $headers -TimeoutSec 20
    if(-not $verified.success -or $verified.result.Count -ne 1 -or $verified.result[0].content -ne $target){throw 'DNS verification failed.'}
    Write-Output 'server.ethanyanxu.com now follows finprint.ethanyanxu.com (DNS only).'
} finally {$headers=$null}
