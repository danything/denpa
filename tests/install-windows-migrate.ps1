param([string]$Installer = (Join-Path $PSScriptRoot '../install.ps1'))

# install.ps1 の Move-FromWslc (前のバージョンの wslc の本体から DB を写す) を、偽の wslc で流す。
# 入れずに関数だけを取り出して動かすので、Linux の pwsh でも流せる (test.yml の install-linux)。
# 見ること: 前のバージョンが無ければ何もしない / コンテナを止めてから DB を写して外す / denpa.env のこの PC の送信元を
# ループバックに書き換える / 流し直しても写し直さない / wslc が無ければ止まる
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput(
    [IO.File]::ReadAllText((Resolve-Path $Installer)), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in 'Say', 'Write-Text', 'Use-Continue', 'Move-FromWslc') {
    $definition = $ast.Find({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if (-not $definition) { throw "Missing function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

# 権限を整える (Windows の ACL と icacls) 代わりに、フォルダを作るだけ
function Set-DataDir { New-Item -ItemType Directory -Force -Path $Data | Out-Null }
function Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$TaskName)
    $script:unregistered += $TaskName
}
$Tar = 'tar'
$Container = 'denpa'
$Volume = 'denpa-data'
$DenpaTask = 'denpa'

$root = Join-Path ([IO.Path]::GetTempPath()) "denpa-migrate-test-$([Guid]::NewGuid().ToString('N'))"
$fixture = Join-Path $root 'volume'
New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'logos') | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'denpa.db'), 'db')
[IO.File]::WriteAllText((Join-Path $fixture 'logos/1.png'), 'png')

function Set-Case([bool]$Old, [bool]$Container) {
    $script:case = Join-Path $root ([Guid]::NewGuid().ToString('N'))
    $script:OldPrefix = Join-Path $case 'old'
    $script:DenpaDir = Join-Path $case 'home'
    $script:Data = Join-Path $case 'data'
    $script:calls = @()
    $script:unregistered = @()
    $script:hasContainer = $Container
    New-Item -ItemType Directory -Force -Path $OldPrefix, $DenpaDir | Out-Null
    if ($Old) {
        [IO.File]::WriteAllText((Join-Path $OldPrefix 'denpa-start.ps1'), '# old')
        [IO.File]::WriteAllText((Join-Path $DenpaDir 'denpa.env'), "TZ=Asia/Tokyo`nTRUSTED_NETWORKS=169.254.0.0/16,192.168.0.0/16`n")
    }
}

function wslc {
    $script:calls += , @($args)
    $global:LASTEXITCODE = 0
    switch ($args[0]) {
        'inspect' { if (-not $script:hasContainer) { $global:LASTEXITCODE = 1 } }
        'rm' { $script:hasContainer = $false }
        'run' {
            $out = ($args[5] -replace ':/o$', '')
            & tar -C $fixture -cf (Join-Path $out 'data.tar') .
            $global:LASTEXITCODE = $LASTEXITCODE
        }
    }
}
$verbs = { ($calls | ForEach-Object { $_[0] }) -join ',' }

# 前のバージョンが無い: 何もしない
Set-Case $false $false
Move-FromWslc
if ($calls.Count -ne 0 -or (Test-Path $Data)) { throw 'no old install: should not touch wslc' }
Write-Host 'PASS: no old install'

# 前のバージョン: 止めてから写し、外す
Set-Case $true $true
Move-FromWslc
if ((& $verbs) -ne 'info,inspect,stop,run,rm') { throw "old install: wrong wslc calls: $(& $verbs)" }
if ([IO.File]::ReadAllText((Join-Path $Data 'denpa.db')) -ne 'db') { throw 'old install: DB not copied' }
if (-not (Test-Path (Join-Path $Data 'logos/1.png'))) { throw 'old install: logos not copied' }
$envText = [IO.File]::ReadAllText((Join-Path $Data 'denpa.env'))
if ($envText -notmatch 'TRUSTED_NETWORKS=127\.0\.0\.0/8,::1/128,192\.168\.0\.0/16') { throw "old install: denpa.env not rewritten: $envText" }
if (-not (Test-Path (Join-Path $DenpaDir 'denpa.env.wslc'))) { throw 'old install: old denpa.env not moved aside' }
if (Test-Path (Join-Path $OldPrefix 'denpa-start.ps1')) { throw 'old install: denpa-start.ps1 left' }
if ($unregistered -notcontains 'denpa') { throw 'old install: logon task left' }
if ($calls | Where-Object { $_[0] -eq 'volume' }) { throw 'old install: the volume must stay' }
Write-Host 'PASS: old install'

# 途中で止まったあとの流し直し: 写した DB があれば写し直さない。コンテナが残っていれば外す
Set-Case $true $true
New-Item -ItemType Directory -Force -Path $Data | Out-Null
[IO.File]::WriteAllText((Join-Path $Data 'denpa.db'), 'copied')
Move-FromWslc
if ((& $verbs) -ne 'info,inspect,stop,rm') { throw "rerun: wrong wslc calls: $(& $verbs)" }
if ([IO.File]::ReadAllText((Join-Path $Data 'denpa.db')) -ne 'copied') { throw 'rerun: DB copied again' }
Write-Host 'PASS: rerun'

# wslc が無い: DB を置いたまま止まる (denpa-start.ps1 は残し、次に流したときにまた写しに行く)
Set-Case $true $true
Remove-Item function:wslc
$failed = $false
try { Move-FromWslc } catch { $failed = $true }
if (-not $failed) { throw 'no wslc: should stop' }
if (-not (Test-Path (Join-Path $OldPrefix 'denpa-start.ps1'))) { throw 'no wslc: denpa-start.ps1 removed' }
Write-Host 'PASS: no wslc'

Remove-Item -Recurse -Force -LiteralPath $root
