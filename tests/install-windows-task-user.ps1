param([string]$Installer = (Join-Path $PSScriptRoot '../install.ps1'))

# install.ps1 の本体のタスクの実行ユーザー (Register-Server・Register-Loop・-User) を、偽のタスク スケジューラと偽の icacls で流す。
# 入れずに関数だけを取り出して動かすので、Linux の pwsh でも流せる (test.yml の install-linux)。
# 見ること: 初めて入れると流した人で載せる (Enter だけか、入力を受け付けない窓なら SYSTEM) / 上げ直しでは聞かずに、
# SYSTEM のタスクは SYSTEM のまま、人が変えた実行ユーザーのタスクは載せ直さず、
# そのユーザーに %ProgramData%\denpa と置き場とログの権限を足し直す / -User ならそのユーザーとパスワードで載せる /
# -User SYSTEM で SYSTEM に戻す / エージェントのタスクも、人が変えた実行ユーザーのまま残す
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput(
    [IO.File]::ReadAllText((Resolve-Path $Installer)), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in 'Say', 'Write-Text', 'Write-Loop', 'Set-DataDir', 'Test-SystemName', 'Get-TaskUser', 'Grant-Modify', 'Register-Loop', 'Register-Server', 'Select-ServerUser') {
    $definition = $ast.Find({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if (-not $definition) { throw "Missing function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$System = 'S-1-5-18'
$Administrators = 'S-1-5-32-544'
$DenpaTask = 'denpa'
$Port = 25252
$WebPort = 3000
$Url = 'http://localhost:3000'
$Prefix = 'C:\Program Files\denpa'
$Sids = @{ 'PC\alice' = 'S-1-5-21-1-1001'; 'PC\bob' = 'S-1-5-21-1-1002' }

# 偽のタスク スケジューラ。$tasks はタスクの名前 → 実行ユーザー
function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    if (-not $script:tasks.ContainsKey($TaskName)) { return $null }
    return [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = $script:tasks[$TaskName] } }
}
function Register-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [string]$Description, [switch]$Force,
        [string]$RunLevel, [string]$User, [string]$Password)
    $runAs = if ($User) { $User } else { $Principal.UserId }
    $script:registered += , @($TaskName, $runAs, $Password)
    $script:tasks[$TaskName] = $runAs
}
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument) return 'action' }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtStartup) return 'trigger' }
function New-ScheduledTaskPrincipal {
    [CmdletBinding()]
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId }
}
function New-ScheduledTaskSettingsSet {
    [CmdletBinding()]
    param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$DontStopOnIdleEnd, $ExecutionTimeLimit, [string]$MultipleInstances)
    return [pscustomobject]@{ Priority = 7 }
}
function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName) }
function Remove-NetFirewallRule { [CmdletBinding()] param([string]$Name) }
function New-NetFirewallRule { [CmdletBinding()] param($Name, $DisplayName, $Description, $Direction, $Protocol, $LocalPort, $Profile, $Action) }
function Test-Health { return $true }
# 権限を書く代わりに、誰に許したかを控える
function Set-Owned([string]$Path, [string[]]$Sids, [string]$Owner) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $script:owned = $Sids
}
function Get-UserSid([string]$Name) {
    if (-not $Sids.ContainsKey($Name)) { throw "no user $Name" }
    return $Sids[$Name]
}
function icacls.exe {
    $script:grants += , @($args[0], $args[2])
    $global:LASTEXITCODE = 0
}

$root = Join-Path ([IO.Path]::GetTempPath()) "denpa-task-user-test-$([Guid]::NewGuid().ToString('N'))"
function Set-Case([hashtable]$Tasks) {
    $script:case = Join-Path $root ([Guid]::NewGuid().ToString('N'))
    $script:Data = Join-Path $case 'data'
    $script:Media = Join-Path $case 'media'
    $script:DenpaDir = Join-Path $case 'home'
    $script:ServerLog = Join-Path $DenpaDir 'denpa.log'
    New-Item -ItemType Directory -Force -Path "$Media\recorded", "$Media\library", $DenpaDir | Out-Null
    $script:tasks = $Tasks
    $script:registered = @()
    $script:grants = @()
    $script:owned = @()
}
$credential = New-Object Management.Automation.PSCredential ('PC\alice', (ConvertTo-SecureString 'secret' -AsPlainText -Force))

foreach ($name in 'SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') {
    if (-not (Test-SystemName $name)) { throw "Test-SystemName: $name is SYSTEM" }
}
if (Test-SystemName 'PC\alice') { throw 'Test-SystemName: PC\alice is not SYSTEM' }
Write-Host 'PASS: SYSTEM names'

# 初めて入れて、ユーザーを決めなかった (SYSTEM): SYSTEM で載せ、置き場は SYSTEM と管理者だけ
Set-Case @{}
Register-Server 'v1.0.0' 'token'
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'SYSTEM') { throw "fresh: wrong registration: $($registered | Out-String)" }
if (($owned -join ',') -ne "$System,$Administrators") { throw "fresh: wrong data ACL: $owned" }
if ($grants.Count -ne 0) { throw 'fresh: should not grant anyone' }
# install.ps1 は Windows の区切り (\) で書く。Linux の .NET はそれを名前の一部として「data\denpa.cmd」を作り、
# PowerShell のパスは \ を / に読み替えるので、.NET で確かめる
if (-not [IO.File]::Exists("$Data\denpa.cmd")) { throw 'fresh: denpa.cmd not written' }
Write-Host 'PASS: fresh install without a user runs as SYSTEM'

# 上げ直し、人がタスク スケジューラで alice に変えていた: 載せ直さず (SYSTEM に戻さない)、alice に権限を足し直す
Set-Case @{ denpa = 'PC\alice' }
Register-Server 'v1.0.1' 'token'
if ($registered.Count -ne 0) { throw "update: task re-registered: $($registered | Out-String)" }
if ($tasks['denpa'] -ne 'PC\alice') { throw "update: task user changed to $($tasks['denpa'])" }
if (($owned -join ',') -ne "$System,$Administrators,S-1-5-21-1-1001") { throw "update: wrong data ACL: $owned" }
$granted = ($grants | ForEach-Object { "$(($_[0] -split '[\\/]')[-1])=$($_[1])" }) -join ','
if ($granted -ne 'recorded=*S-1-5-21-1-1001:(OI)(CI)M,library=*S-1-5-21-1-1001:(OI)(CI)M,denpa.log=*S-1-5-21-1-1001:M') { throw "update: wrong grants: $granted" }
Write-Host 'PASS: update keeps the task user and grants it again'

# -User: そのユーザーとパスワードで載せる
Set-Case @{ denpa = 'SYSTEM' }
Register-Server 'v1.0.1' 'token' -Credential $credential
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'PC\alice' -or $registered[0][2] -ne 'secret') { throw "-User: wrong registration: $($registered | Out-String)" }
if (($owned -join ',') -ne "$System,$Administrators,S-1-5-21-1-1001") { throw "-User: wrong data ACL: $owned" }
if ($grants.Count -ne 3) { throw "-User: wrong grants: $($grants | Out-String)" }
Write-Host 'PASS: -User registers the task with that user'

# -User SYSTEM: alice から SYSTEM に戻し、alice の権限は書き足さない
Set-Case @{ denpa = 'PC\alice' }
Register-Server 'v1.0.1' 'token' -AsSystem
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'SYSTEM') { throw "-User SYSTEM: wrong registration: $($registered | Out-String)" }
if (($owned -join ',') -ne "$System,$Administrators") { throw "-User SYSTEM: wrong data ACL: $owned" }
if ($grants.Count -ne 0) { throw '-User SYSTEM: should not grant anyone' }
Write-Host 'PASS: -User SYSTEM goes back to SYSTEM'

# エージェントのタスク: 人が変えた実行ユーザーなら載せ直さない。SYSTEM なら載せ直す
Set-Case @{ 'denpa-agent' = 'PC\bob' }
Register-Loop 'denpa-agent' 'C:\denpa-agent.cmd' 'agent' 4
if ($registered.Count -ne 0) { throw 'agent: task re-registered' }
Set-Case @{ 'denpa-agent' = 'NT AUTHORITY\SYSTEM' }
Register-Loop 'denpa-agent' 'C:\denpa-agent.cmd' 'agent' 4
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'SYSTEM') { throw "agent: wrong registration: $($registered | Out-String)" }
Write-Host 'PASS: agent task keeps its user'

# 実行ユーザーを決める (Select-ServerUser)。流した人・入力を受け付ける窓か・入れたパスワードは偽物で決める
$OldPrefix = Join-Path $root 'old'
function Get-LogonUser { return $script:logonUser }
function Test-Interactive { return $script:interactive }
function Read-TaskPassword([string]$Prompt) {
    $script:asked += , $Prompt
    if (-not $script:typed) { return New-Object Security.SecureString }
    return ConvertTo-SecureString $script:typed -AsPlainText -Force
}
function Say([string]$Message) { $script:said += , $Message }
function Set-Who([string]$LogonUser, [bool]$Interactive, [string]$Typed) {
    $script:logonUser = $LogonUser
    $script:interactive = $Interactive
    $script:typed = $Typed
    $script:asked = @()
    $script:said = @()
}

# 初めて入れる: 流した人で、入れたパスワードとともに載せ、その人に置き場の権限を足す
Set-Case @{}
Set-Who 'PC\alice' $true 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 1 -or -not $runAs.Credential -or $runAs.Credential.UserName -ne 'PC\alice') { throw "default: wrong choice: $($runAs | Out-String)" }
Register-Server 'v1.0.0' 'token' -Credential $runAs.Credential -AsSystem:([bool]$runAs.AsSystem)
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'PC\alice' -or $registered[0][2] -ne 'secret') { throw "default: wrong registration: $($registered | Out-String)" }
if (($owned -join ',') -ne "$System,$Administrators,S-1-5-21-1-1001") { throw "default: wrong data ACL: $owned" }
Write-Host 'PASS: fresh install runs as the user who ran it'

# 初めて入れる、Enter だけ: SYSTEM で載せ、あとで -User で替えられることを出す
Set-Case @{}
Set-Who 'PC\alice' $true ''
$runAs = Select-ServerUser ''
if (-not $runAs.AsSystem -or $runAs.Credential) { throw "empty password: wrong choice: $($runAs | Out-String)" }
if (-not ($said | Where-Object { $_ -like '*-User PC\alice *' })) { throw "empty password: no hint: $said" }
Register-Server 'v1.0.0' 'token' -AsSystem
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'SYSTEM') { throw "empty password: wrong registration: $($registered | Out-String)" }
Write-Host 'PASS: an empty password falls back to SYSTEM'

# 初めて入れる、入力を受け付けない窓: 聞かずに SYSTEM。あとで -User で替えられることを出す
Set-Case @{}
Set-Who 'PC\alice' $false 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 0) { throw 'non-interactive: asked for a password' }
if (-not $runAs.AsSystem) { throw "non-interactive: wrong choice: $($runAs | Out-String)" }
if (-not ($said | Where-Object { $_ -like '*-User PC\alice *' })) { throw "non-interactive: no hint: $said" }
Write-Host 'PASS: a non-interactive run installs as SYSTEM without asking'

# 流した人が見つからない (SID が引けない) か SYSTEM なら、聞かずに SYSTEM
Set-Case @{}
Set-Who 'PC\carol' $true 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 0 -or -not $runAs.AsSystem) { throw "unknown user: wrong choice: $($runAs | Out-String)" }
Set-Who 'NT AUTHORITY\SYSTEM' $true 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 0 -or -not $runAs.AsSystem) { throw "run as SYSTEM: wrong choice: $($runAs | Out-String)" }
Write-Host 'PASS: an unknown or SYSTEM user installs as SYSTEM'

# 上げ直し、SYSTEM で入れていた: 聞かずに SYSTEM のまま
Set-Case @{ denpa = 'NT AUTHORITY\SYSTEM' }
Set-Who 'PC\alice' $true 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 0 -or $runAs.Credential -or $runAs.AsSystem) { throw "update SYSTEM: wrong choice: $($runAs | Out-String)" }
Register-Server 'v1.0.1' 'token'
if ($registered.Count -ne 1 -or $registered[0][1] -ne 'SYSTEM') { throw "update SYSTEM: wrong registration: $($registered | Out-String)" }
if ($grants.Count -ne 0) { throw 'update SYSTEM: should not grant anyone' }
Write-Host 'PASS: update keeps SYSTEM without asking'

# 上げ直し、ユーザーで入れていた: 聞かずにそのまま (載せ直さない)
Set-Case @{ denpa = 'PC\bob' }
Set-Who 'PC\alice' $true 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 0 -or $runAs.Credential -or $runAs.AsSystem) { throw "update user: wrong choice: $($runAs | Out-String)" }
Register-Server 'v1.0.1' 'token'
if ($registered.Count -ne 0 -or $tasks['denpa'] -ne 'PC\bob') { throw "update user: task changed: $($registered | Out-String)" }
Write-Host 'PASS: update keeps the user without asking'

# 前のバージョン (wslc) の本体のタスクがあっても、初めてと同じに聞く
Set-Case @{ denpa = 'PC\alice' }
New-Item -ItemType Directory -Force -Path $OldPrefix | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $OldPrefix 'denpa-start.ps1') | Out-Null
Set-Who 'PC\alice' $true 'secret'
$runAs = Select-ServerUser ''
if ($asked.Count -ne 1 -or $runAs.Credential.UserName -ne 'PC\alice') { throw "from wslc: wrong choice: $($runAs | Out-String)" }
Remove-Item -Recurse -Force -LiteralPath $OldPrefix
Write-Host 'PASS: moving from wslc asks like a fresh install'

# -User: 上げ直しでもそのユーザーのパスワードを聞く。-User SYSTEM は聞かない。入力を受け付けない窓では止める
Set-Case @{ denpa = 'NT AUTHORITY\SYSTEM' }
Set-Who 'PC\alice' $true 'secret'
$runAs = Select-ServerUser 'PC\bob'
if ($asked.Count -ne 1 -or $runAs.Credential.UserName -ne 'PC\bob') { throw "-User: wrong choice: $($runAs | Out-String)" }
$runAs = Select-ServerUser 'SYSTEM'
if ($asked.Count -ne 1 -or -not $runAs.AsSystem) { throw "-User SYSTEM: wrong choice: $($runAs | Out-String)" }
Set-Who 'PC\alice' $true ''
$failed = $false
try { Select-ServerUser 'PC\bob' | Out-Null } catch { $failed = $true }
if (-not $failed) { throw '-User: an empty password should stop' }
Set-Who 'PC\alice' $false 'secret'
$failed = $false
try { Select-ServerUser 'PC\bob' | Out-Null } catch { $failed = $true }
if (-not $failed -or $asked.Count -ne 0) { throw '-User: a non-interactive run should stop without asking' }
Write-Host 'PASS: -User asks for that user, and stops without a password'

Remove-Item -Recurse -Force -LiteralPath $root
