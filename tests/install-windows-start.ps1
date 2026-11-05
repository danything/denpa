param([string]$Installer = (Join-Path $PSScriptRoot '../install.ps1'))

# インストールせず、生成された起動スクリプトを偽のネットワークと wslc で動かす。
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput(
    [IO.File]::ReadAllText((Resolve-Path $Installer)), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in 'Write-Text', 'Write-StartScript') {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $definition) { throw "Missing function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$work = Join-Path ([IO.Path]::GetTempPath()) "denpa-start-test-$([Guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $work
$shell = (Get-Process -Id $PID).Path
$utf8 = New-Object Text.UTF8Encoding $true
$cases = @(
    @{ Name = 'no network discovery'; Port = 25252 },
    @{ Name = 'custom port'; Port = 31000 },
    @{ Name = 'unchanged container'; Port = 25252; Existing = $true },
    @{ Name = 'replace empty host'; Port = 25252; Existing = $true; OldAgent = 'https://:25252#pair=test-token' },
    @{ Name = 'replace LAN host'; Port = 25252; Existing = $true; OldAgent = 'https://192.168.1.2:25252#pair=test-token' }
)
foreach ($case in $cases) {
    $Prefix = Join-Path $work ([Guid]::NewGuid().ToString('N'))
    $DenpaDir = $Prefix
    $Media = $Prefix
    $Port = $case.Port
    $Container = 'denpa-test'
    $Volume = 'denpa-test-data'
    $null = New-Item -ItemType Directory -Path $Prefix
    [IO.File]::WriteAllText((Join-Path $Prefix 'denpa.env'), "TZ=Asia/Tokyo`n")
    $generated = Write-StartScript 'ghcr.io/danything/denpa:2.30.1' 'test-token'
    $casePath = Join-Path $Prefix 'case.json'
    [IO.File]::WriteAllText($casePath, ($case | ConvertTo-Json), $utf8)
    $runner = Join-Path $Prefix 'runner.ps1'
    $harness = @'
param([string]$CaseFile, [string]$Generated)
$ErrorActionPreference = 'Stop'
$global:fixture = Get-Content -LiteralPath $CaseFile -Raw | ConvertFrom-Json
$global:callFile = Join-Path (Split-Path $CaseFile) 'calls.jsonl'
function Get-NetIPAddress { throw 'Network discovery must not run.' }
function wslc {
    $arguments = @($args)
    [IO.File]::AppendAllText($global:callFile, (ConvertTo-Json -InputObject $arguments -Compress) + "`n")
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'inspect') {
        if ($global:fixture.Existing) {
            $hash = (Get-FileHash (Join-Path (Split-Path $CaseFile) 'denpa.env')).Hash
            ConvertTo-Json -Depth 5 -InputObject @(@{ Config = @{
                Image = 'ghcr.io/danything/denpa:2.30.1'
                Env = @($(if ($global:fixture.OldAgent) { "TUNER_AGENT_URL=$($global:fixture.OldAgent)" } else { "TUNER_AGENT_URL=https://host.wslc.internal:$($global:fixture.Port)#pair=test-token" }))
                Labels = @{ 'denpa.env' = $hash }
            } })
        } else { $global:LASTEXITCODE = 1 }
    }
}
& $Generated
'@
    [IO.File]::WriteAllText($runner, $harness, $utf8)
    # 5.1 は子プロセスの stderr も PowerShell のエラーとして扱う。失敗ケースは終了コードで確かめる。
    $ErrorActionPreference = 'Continue'
    $output = & $shell -NoProfile -ExecutionPolicy Bypass -File $runner -CaseFile $casePath -Generated $generated 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $callFile = Join-Path $Prefix 'calls.jsonl'
    $calls = @()
    if (Test-Path -LiteralPath $callFile) {
        $calls = @(Get-Content -LiteralPath $callFile | ForEach-Object { ,(ConvertFrom-Json $_) })
    }
    if ($case.Existing -and -not $case.OldAgent) {
        if ($code -ne 0 -or $calls.Count -ne 2 -or $calls[1][0] -ne 'start') { throw "$($case.Name): should reuse container: $output" }
    } else {
        $run = @($calls | Where-Object { $_[0] -eq 'run' })
        $expected = "TUNER_AGENT_URL=https://host.wslc.internal:$($case.Port)#pair=test-token"
        if ($code -ne 0 -or $run.Count -ne 1 -or $run[0] -notcontains $expected) { throw "$($case.Name): wrong container environment: $output" }
        if ($run[0] -notcontains 'denpa-test-data:/data') { throw 'Database volume was not retained.' }
        if ($case.OldAgent -and (($calls | ForEach-Object { $_[0] }) -join ',') -ne 'inspect,stop,rm,run') { throw 'Expected the old container to stop before replacement.' }
    }
    Write-Host "PASS: $($case.Name)"
}
Write-Host "Passed $($cases.Count) cases. Temporary files: $work"
