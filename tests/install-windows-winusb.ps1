param([string]$Installer = (Join-Path $PSScriptRoot '../install.ps1'))

# install.ps1 の Invoke-WinUsb (-WinUsb。挿さっているチューナーのドライバを WinUSB に替える) を、偽の機材と偽の wdi-simple で流す。
# 入れずに関数だけを取り出して動かすので、Linux の pwsh でも流せる (test.yml の install-linux)。
# 見ること: wdi-simple.exe が無ければ止まる / 機材が無ければ止まる / WinUSB の機材には何もしない / 聞いて y のときだけ替える /
# -Yes なら聞かずに替える / 同じ USB ID は 1 回で替える / wdi-simple が失敗したら終了コードを添えて止まる (ほかの機材は続ける) /
# px4d が開けなかった機材と Siano の機材も対象になる
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput(
    [IO.File]::ReadAllText((Resolve-Path $Installer)), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in 'Say', 'Get-UsbPnp', 'Get-WinUsbTarget', 'Get-WinUsbDevice', 'Invoke-WinUsb') {
    $definition = $ast.Find({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if (-not $definition) { throw "Missing function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$Installer = 'https://example.invalid/install.ps1'
$SianoUsbIds = @('3275:0080')
$root = Join-Path ([IO.Path]::GetTempPath()) "denpa-winusb-test-$([Guid]::NewGuid().ToString('N'))"

# 外を呼ぶところを偽物にする (機材の一覧・エージェントの表・px4d の答え・wdi-simple・人の答え・エージェントの起動し直し)
function Get-PnpDevice { return $script:pnp }
function Get-AgentUsbId {
    return @([pscustomobject]@{ usb = '054c:04b2'; name = 'Sony CECH-ZD1 J' }, [pscustomobject]@{ usb = '06b8:103b'; name = 'PIXELA PIX-DT295' })
}
function Get-Px4List { return $script:px4 }
function Invoke-WdiSimple([string]$Usb, [string]$Name, [string]$Work) {
    $script:replaced += $Usb
    if ($script:exitCodes.ContainsKey($Usb)) { return $script:exitCodes[$Usb] }
    return 0
}
function Read-Answer([string]$Prompt) {
    $script:asked++
    return $script:answer
}
function Restart-Agent { $script:restarted++ }

function New-Pnp([string]$Usb, [string]$Service, [string]$Serial = '1') {
    $id = $Usb.ToUpperInvariant() -split ':'
    return [pscustomobject]@{ InstanceId = "USB\VID_$($id[0])&PID_$($id[1])\$Serial"; Service = $Service; FriendlyName = 'tuner' }
}

function Set-Case([object[]]$Pnp, [string]$Answer = '', [switch]$NoWdi, [switch]$NoAgent) {
    $script:Prefix = Join-Path $root ([Guid]::NewGuid().ToString('N'))
    $script:WdiSimple = Join-Path $Prefix 'bin/libwdi/wdi-simple.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WdiSimple) | Out-Null
    if (-not $NoAgent) { [IO.File]::WriteAllText((Join-Path $Prefix 'bin/denpa-agent.exe'), '') }
    if (-not $NoWdi) { [IO.File]::WriteAllText($WdiSimple, '') }
    $script:pnp = $Pnp
    $script:px4 = $null
    $script:answer = $Answer
    $script:asked = 0
    $script:replaced = @()
    $script:restarted = 0
    $script:exitCodes = @{}
}

function Assert-Equal($Actual, $Expected, [string]$What) {
    if ("$Actual" -ne "$Expected") { throw "$What`: expected '$Expected', got '$Actual'" }
}

# 止まることと、止まったときのメッセージ
function Assert-Throw([scriptblock]$Block, [string]$Pattern, [string]$What) {
    $message = $null
    try { & $Block } catch { $message = $_.Exception.Message }
    if (-not $message) { throw "$What`: did not stop" }
    if ($message -notmatch $Pattern) { throw "$What`: stopped with '$message'" }
}

try {
    # denpa が入っていない・wdi-simple.exe が無い (古いバージョン) なら、何も呼ばずに止まる。古いバージョンでは Zadig を案内する
    Set-Case @(New-Pnp '054c:04b2' '') -NoAgent
    Assert-Throw { Invoke-WinUsb -Yes } 'denpa が入っていません' 'no agent'
    Set-Case @(New-Pnp '054c:04b2' '') -NoWdi
    Assert-Throw { Invoke-WinUsb -Yes } 'wdi-simple\.exe がありません.*Zadig' 'no wdi-simple'
    Assert-Equal $replaced.Count 0 'no wdi-simple: replaced'

    # 対応している機材が挿さっていなければ止まる (ほかの USB の機材は対象にしない)
    Set-Case @(New-Pnp '1234:5678' 'usbccgp')
    Assert-Throw { Invoke-WinUsb -Yes } '挿さっていません' 'no tuner'
    Assert-Equal $replaced.Count 0 'no tuner: replaced'

    # もう WinUSB の機材には何もしない (聞かない・替えない・エージェントも起動し直さない)
    Set-Case @(New-Pnp '054c:04b2' 'WinUSB') 'y'
    Invoke-WinUsb
    Assert-Equal $asked 0 'already WinUSB: asked'
    Assert-Equal $replaced.Count 0 'already WinUSB: replaced'
    Assert-Equal $restarted 0 'already WinUSB: restarted'

    # 聞いて、y でなければ替えない (何も入れずに Enter・n)
    foreach ($answer in '', 'n', 'no', 'yy') {
        Set-Case @(New-Pnp '054c:04b2' 'BDATuner') $answer
        Invoke-WinUsb
        Assert-Equal $asked 1 "answer '$answer': asked"
        Assert-Equal $replaced.Count 0 "answer '$answer': replaced"
        Assert-Equal $restarted 0 "answer '$answer': restarted"
    }

    # y なら替えて、エージェントを起動し直す。聞くのは機材ごと (WinUSB の機材は聞かない)
    Set-Case @((New-Pnp '054c:04b2' ''), (New-Pnp '06b8:103b' 'pxdt295'), (New-Pnp '3275:0080' 'WinUSB')) 'Y'
    Invoke-WinUsb
    Assert-Equal $asked 2 'answer y: asked'
    Assert-Equal ($replaced -join ',') '054c:04b2,06b8:103b' 'answer y: replaced'
    Assert-Equal $restarted 1 'answer y: restarted'

    # -Yes なら聞かずに替える
    Set-Case @(New-Pnp '3275:0080' 'smsusb')
    Invoke-WinUsb -Yes
    Assert-Equal $asked 0 '-Yes: asked'
    Assert-Equal ($replaced -join ',') '3275:0080' '-Yes: replaced'

    # 同じ USB ID の機材が 2 台なら、聞くのも替えるのも 1 回 (wdi-simple がまとめて替える)
    Set-Case @((New-Pnp '054c:04b2' '' 'a'), (New-Pnp '054c:04b2' '' 'b')) 'y'
    Invoke-WinUsb
    Assert-Equal $asked 1 'two of the same: asked'
    Assert-Equal ($replaced -join ',') '054c:04b2' 'two of the same: replaced'

    # wdi-simple が失敗したら、終了コードと Zadig を添えて止まる。ほかの機材は続けて替え、替えられた分でエージェントを起動し直す
    Set-Case @((New-Pnp '054c:04b2' ''), (New-Pnp '06b8:103b' ''))
    $exitCodes['054c:04b2'] = -12
    Assert-Throw { Invoke-WinUsb -Yes } '054c:04b2.*終了コード -12.*Zadig' 'wdi-simple fails'
    Assert-Equal ($replaced -join ',') '054c:04b2,06b8:103b' 'wdi-simple fails: replaced'
    Assert-Equal $restarted 1 'wdi-simple fails: restarted'

    # px4d が開けなかった px4-userland の機材も対象になる (USB ID は px4d が返す)。開けた機材は対象にしない
    Set-Case @((New-Pnp '0511:083f' 'PXQ3U4'), (New-Pnp '0511:0841' 'WinUSB'))
    $px4 = [pscustomobject]@{
        enclosures = @()
        ungrouped_usb_devices = @(
            [pscustomobject]@{ usb = '0511:083f'; model = 'PX-Q3U4'; status = 'open_failed'; port = '1-2' },
            [pscustomobject]@{ usb = '0511:0841'; model = 'PX-W3U4'; status = 'unsupported'; port = '1-3' })
    }
    Invoke-WinUsb -Yes
    Assert-Equal ($replaced -join ',') '0511:083f' 'px4: replaced'

    'ok'
} finally {
    Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction SilentlyContinue
}
