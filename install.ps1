# ---------------------------------------------------------------------------
# denpa を Windows (x64) に立てる。**管理者の PowerShell の 1 行で、ブラウザが開くところまで。**
#
#   irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -Uninstall
#       引数を渡すときはこの書き方。-NoOpen (ブラウザを開かない) / -Uninstall (止めて外す。DB・設定・録画は残す) /
#       -AgentOnly (エージェントだけ。denpa 本体は別の機械で動かす)
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -WinUsb
#       入れたあとで。挿さっているチューナーのドライバを WinUSB に替える (機材ごとに聞いてから。-Yes を足すと聞かずに替える。Invoke-WinUsb)
#
# **denpa 本体もエージェントも Windows の上でそのまま動かす** (コンテナは使わない)。本体は配布物の bun と ffmpeg で、
# エージェントは .NET の実行ファイル。どちらもタスク スケジューラの「起動したら起こす」タスクに **SYSTEM で**載せるので、
# 誰もログインしていなくても録画でき、外から観られる。そのために管理者で流す。
# **Windows で使えるチューナーは IT930x の機材 (PX-MLT5・PX-Q3・PX-W3 系など) と Siano の機材 (PX-S1UD など) と Sony CECH-ZD1 J と PIXELA PIX-DT295 (試験的)**
# (DVB は無い)。**入れるときにはドライバを替えない。** WinUSB にするのは、人が -WinUsb を付けて流したときだけ
# (エージェントの zip に入っている libwdi の wdi-simple.exe で。Zadig でもよい。docs/install-windows.md)。
#
# もう一度流せば上げ直し。本体は**エージェントと同じリリースのバージョン**に揃える。
# 前のバージョン (本体を wslc のコンテナで動かしていた) からは、DB を写して移る (Move-FromWslc)。
#
# 置き場:
#   %ProgramFiles%\denpa\                 エージェントと通知領域のアイコン (bin\)・本体 (server\。bun・アプリ・ffmpeg・字・デコーダ)・
#                                         エージェントを起こす denpa-agent.cmd (管理者しか書けない。SYSTEM で動かすものを、ほかの人に書き換えさせない)
#   %ProgramData%\denpa\                  DB (denpa.db) とその隣のもの (局ロゴ・鍵)・denpa.env (本体の環境変数。無いときだけ雛形を作る)・本体を起こす denpa.cmd。
#                                         SYSTEM と管理者だけが読み書きできる
#   ~/denpa (DENPA_HOME)                  エージェントの config/ (tls\pair-token は denpa とエージェントが組むときの合言葉。無いときだけ作る)・
#                                         ログ (denpa.log・denpa-agent.log)
#   ~/Videos/denpa/{recorded,library}     元の TS と出来上がった録画
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、DENPA_HOME、
# DENPA_AGENT_ZIP・DENPA_SERVER_ZIP (手元でビルドしたエージェント・本体の zip を絶対パスで。CI と開発用)
#
# Windows に最初から入っている PowerShell 5.1 で動くように書く (pwsh でも動く)。
# `irm | iex` は呼んだ人のセッションでそのまま走るので、exit は使わない (窓ごと閉じる)。
# ---------------------------------------------------------------------------
param([switch]$NoOpen, [switch]$Uninstall, [switch]$AgentOnly, [switch]$WinUsb, [switch]$Yes)

# 入れ方の 1 行 (案内に出す)
$Installer = 'https://raw.githubusercontent.com/danything/denpa/main/install.ps1'
$WinUsbCommand = "& ([scriptblock]::Create((irm $Installer))) -WinUsb"

$Repo = 'danything/denpa'
$WebPort = 3000
$Url = "http://localhost:$WebPort"
$DenpaDir = if ($env:DENPA_HOME) { $env:DENPA_HOME } else { Join-Path $env:USERPROFILE 'denpa' }
$Prefix = Join-Path $env:ProgramFiles 'denpa'
$Data = Join-Path $env:ProgramData 'denpa'
# 前のバージョンの置き場 (ユーザーのフォルダの下。エージェントと wslc の本体を起こす denpa-start.ps1)。見つけたら移して消す
$OldPrefix = Join-Path $env:LOCALAPPDATA 'denpa-agent'
# 前のバージョンが px4d のソケットを置いていた場所 (Remove-Px4Runtime)
$Px4Runtime = 'C:\denpa-run'
$Media = Join-Path $env:USERPROFILE 'Videos\denpa'
$Log = Join-Path $DenpaDir 'denpa-agent.log'
$ServerLog = Join-Path $DenpaDir 'denpa.log'
$TaskName = 'denpa-agent'
$DenpaTask = 'denpa'
# 本体が次の録画の前にスリープから起こすタスク (本体が書き直す。src/lib/server/power.ts)
$WakeTask = 'denpa-wake'
$FirewallRule = 'denpa'
# 通知領域のアイコン (tray/Denpa.Tray)。エージェントと同じ zip に入っていて、サインインしたら HKLM の Run から起きる
$TrayExe = Join-Path $Prefix 'bin\denpa-tray.exe'
# libwdi の wdi-simple.exe (Zadig のコマンドライン版)。エージェントと同じ zip に入っていて、-WinUsb が使う
$WdiSimple = Join-Path $Prefix 'bin\libwdi\wdi-simple.exe'
$RunKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'denpa'
$Port = 25252
# 前のバージョンの wslc のコンテナとボリューム
$Container = 'denpa'
$Volume = 'denpa-data'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$System = 'S-1-5-18'
$Administrators = 'S-1-5-32-544'
# 動く Windows の下限のビルド (Windows 10 1809 / Windows Server 2019。Invoke-Main)
$MinBuild = 17763

function Say([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# 取ってくる。PowerShell 5.1 の Invoke-WebRequest は遅い (進み具合の表示) ので、Windows 10 から入っている curl.exe で
# **時間の上限を付ける。** 繋がったまま止まる相手 (落ちかけのサイト) だと、付けなければいつまでも待つ。
# 時間切れも --retry が試し直す
function Get-Url([string]$From, [string]$To) {
    & curl.exe -fsSL --retry 3 --connect-timeout 20 --max-time 600 -o $To $From
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードできません: $From" }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected.ToUpperInvariant()) {
        throw "$Path のハッシュが合いません (ダウンロード中に壊れた可能性があります。もう一度流してください)"
    }
}

# リリースのファイルと、同じリリースの .sha256 を取ってきて照らす
function Get-ReleaseFile([string]$Ref, [string]$Name, [string]$To) {
    Get-Url "https://github.com/$Repo/releases/download/$Ref/$Name" $To
    Get-Url "https://github.com/$Repo/releases/download/$Ref/$Name.sha256" "$To.sha256"
    Assert-Hash $To ((Get-Content -LiteralPath "$To.sha256" -Raw) -split '\s+')[0]
}

# 入れるバージョン。API を使わず、latest の転送先からタグを読む (install.sh と同じ)
function Get-Version {
    if ($env:DENPA_VERSION) { return $env:DENPA_VERSION }
    $tag = & curl.exe -fsLI --connect-timeout 20 --max-time 60 -o NUL -w '%{url_effective}' "https://github.com/$Repo/releases/latest"
    if ($LASTEXITCODE -ne 0) { throw '最新のリリースが分かりません' }
    return ($tag -split '/')[-1]
}

# ファイルは BOM 無しの UTF-8 で書く (PowerShell 5.1 の Set-Content は BOM を付ける)
function Write-Text([string]$Path, [string]$Text, [Text.Encoding]$Encoding = (New-Object Text.UTF8Encoding $false)) {
    [IO.File]::WriteAllText($Path, $Text, $Encoding)
}

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# denpa とエージェントが組むときの合言葉 (32 バイトの乱数を base64url で。docs/agent.md)。
# **エージェント自身の置き場** (tuners.json の隣の tls\pair-token) に**一度だけ**作り、上げ直しても変えない。
# エージェントには環境変数で渡さず、そこから読ませる (手で denpa-agent --pair を流しても同じ URL が出るように)。
# denpa には TUNER_AGENT_URL の #pair= で同じものを渡す。エージェントが先に作っていればそれを使う
function Get-PairToken {
    $path = "$DenpaDir\config\tls\pair-token"
    if (Test-Path -LiteralPath $path) {
        $text = Get-Content -LiteralPath $path -Raw
        if ($text -and $text.Trim()) { return $text.Trim() }
    }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    Write-Text $path $token
    return $token
}

# エージェントのいまの様子 (/denpa/tuners の JSON)。API は組んだ denpa (クライアント証明書) にしか答えないので、
# denpa-agent --status に聞かせる (エージェント自身の証明書で呼ぶ)。置き場とポートは .cmd と同じものを渡す。
# 答えなければ $null
function Get-AgentStatus([string]$Exe) {
    Use-Continue
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    $saved = @($env:AGENT_PORT, $env:TUNERS_FILE)
    $env:AGENT_PORT = [string]$Port
    $env:TUNERS_FILE = "$DenpaDir\config\tuners.json"
    try {
        $out = & $Exe --status 2>$null | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $out.Trim()) { return $null }
        return $out.Trim()
    } finally {
        $env:AGENT_PORT = $saved[0]
        $env:TUNERS_FILE = $saved[1]
    }
}

# 録画中か ($Exe の --status で聞く。答えなければ録画していないことにする)
function Test-Recording([string]$Exe) {
    $out = Get-AgentStatus $Exe
    if (-not $out) { return $false }
    try {
        $status = ConvertFrom-Json $out
        return [bool]($status.tuners | ForEach-Object { $_.users } | Where-Object { $_.use -match '^rec( |$)' })
    } catch {
        return $false
    }
}

# 止める。**録画中なら終わるまで待つ** (Windows にはプロセスに「止まれ」を伝える手が無く、止めればその場で落ちる。
# Linux・Mac のように録画を待ってから畳むことができないので、ここで待つ)。
# タスクを止めても、.cmd の下で起きたもの (bun・ffmpeg・エージェント) までは止まらないので、
# コマンドラインに置き場が入っているもので見つけて落とす (前のバージョンの置き場のものも)。
# 録画中かを聞く denpa-agent は $Exe (上げ直すときは取ってきた新しいほう。古いものは --status を知らない)。
# -Server を付けなければエージェントだけ (-AgentOnly のとき)。エンコードの途中なら、次に起きたときにやり直す
function Stop-Denpa([string]$Exe, [switch]$Server) {
    $tasks = @($TaskName)
    # 通知領域のアイコン (denpa-tray.exe) もエージェントと同じ bin\ にあるので、入れ替える前に落とす。
    # siano-ts.exe と px4d.exe は前のバージョンのエージェントが起動していたもの (いまは置かない)
    $names = @('conhost.exe', 'cmd.exe', 'denpa-agent.exe', 'denpa-tray.exe', 'siano-ts.exe', 'px4d.exe', 'px4ctl.exe')
    if ($Server) {
        $tasks += $DenpaTask
        $names += 'bun.exe', 'ffmpeg.exe', 'ffprobe.exe'
    }
    $tasks = @($tasks | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue })
    if ($tasks.Count -eq 0) { return }
    if (Test-Recording $Exe) {
        Say '録画中です。終わるまでここで待ちます (Windows では録画の途中で止めると、その録画は切れます)'
        while (Test-Recording $Exe) { Start-Sleep -Seconds 10 }
    }
    foreach ($task in $tasks) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue }
    $shells = 'cmd.exe', 'conhost.exe'
    for ($i = 0; $i -lt 30; $i++) {
        $left = @(Get-CimInstance Win32_Process | Where-Object {
                $_.Name -in $names -and $_.CommandLine -and
                ($_.CommandLine.IndexOf("$Prefix\", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $_.CommandLine.IndexOf("$OldPrefix\", [StringComparison]::OrdinalIgnoreCase) -ge 0) -and
                # エージェントだけ止めるときは、本体の .cmd (denpa.cmd) を残す
                ($Server -or $_.Name -notin $shells -or $_.CommandLine.IndexOf('denpa-agent.cmd', [StringComparison]::OrdinalIgnoreCase) -ge 0)
            })
        if ($left.Count -eq 0) { return }
        $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    throw "denpa が止まりません ($Prefix の下のプロセスをタスク マネージャーで止めてから、もう一度流してください)"
}

# **stderr を捨てる外のコマンドの前に。** PowerShell 5.1 は、止める設定 (Stop) のまま 2>$null すると
# stderr の 1 行目で止まる。呼んだ関数の中だけ Continue にする (Set-Variable -Scope 1)
function Use-Continue { Set-Variable -Scope 1 -Name ErrorActionPreference -Value Continue }

function Test-Health {
    & curl.exe -fs --max-time 5 -o NUL "http://127.0.0.1:$WebPort/api/health"
    return $LASTEXITCODE -eq 0
}

# フォルダの持ち主と DACL を書く。Set-Acl は SACL まで書きにいって、2 回目から SeSecurityPrivilege が要ると断られるので、
# 持ち主と DACL だけを書く (PowerShell 5.1 は DirectoryInfo のメソッド、7 は拡張メソッド)。
# **フォルダがリンク (junction など) なら止める。** リンク先の持ち主と権限を書き換えてしまう。
# 許すのは $Sids (FullControl、下のフォルダとファイルにも継がせる) だけで、親からは継がない。
# 持ち主を SYSTEM にするのは .NET からはできない (SeRestorePrivilege が要る) ので、icacls に任せる
function Set-Owned([string]$Path, [string[]]$Sids, [string]$Owner) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path | Out-Null }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Path がリンクになっています。中身を確かめて消してから、もう一度流してください"
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $Sids) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule (New-Object Security.Principal.SecurityIdentifier $sid),
                'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    $info = Get-Item -LiteralPath $Path
    try {
        if ($info.PSObject.Methods['SetAccessControl']) { $info.SetAccessControl($acl) }
        else { [IO.FileSystemAclExtensions]::SetAccessControl($info, $acl) }
    } catch {
        throw "$Path の権限を整えられません ($($_.Exception.Message))"
    }
    & icacls.exe $Path /setowner "*$Owner" /q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$Path の持ち主を変えられません (icacls /setowner)" }
}

# 本体の置き場 (%ProgramData%\denpa)。DB・鍵・denpa.env があるので、SYSTEM と管理者だけにする
# (既定の ProgramData は Users も読める)
function Set-DataDir { Set-Owned $Data @($System, $Administrators) $Administrators }

# 起こす .cmd を書く。**落ちたら 5 秒置いて起こし直す** (タスク スケジューラの「失敗したら再起動」は、終了コードでは効かない)。
# $Vars は .cmd が決める環境変数。$EnvFile があれば、**起こすたびに読み直し**、そのあとで $Vars を書く
# (ファイルに置き場や ffmpeg を書いても、こちらが勝つ。setlocal で毎回まっさらにするので、消した行も残らない)。
# ログはここで足していく。**パスに日本語が入りうる**ので、1 行目で cmd の文字コードを UTF-8 にしてから読ませる
# (そのままだとコンソールの文字コードで読み、それはユーザーの設定次第で決め打てない)
function Write-Loop([string]$Path, [Collections.Specialized.OrderedDictionary]$Vars, [string]$EnvFile, [string]$Dir, [string]$Command, [string]$LogFile) {
    $esc = { param([string]$Text) $Text.Replace('%', '%%') }
    $lines = @('@chcp 65001 >nul', '@echo off', 'rem Written by install.ps1 (denpa). Re-run the installer instead of editing this file.')
    if ($Dir) { $lines += "cd /d `"$(& $esc $Dir)`"" }
    $lines += ':loop', 'setlocal'
    if ($EnvFile) {
        $lines += "if exist `"$(& $esc $EnvFile)`" for /f `"usebackq eol=# tokens=1,* delims==`" %%a in (`"$(& $esc $EnvFile)`") do set `"%%a=%%b`""
    }
    foreach ($key in $Vars.Keys) { $lines += "set `"$key=$(& $esc ([string]$Vars[$key]))`"" }
    $lines += "$Command >> `"$(& $esc $LogFile)`" 2>&1", 'endlocal', 'ping -n 6 127.0.0.1 >nul', 'goto loop'
    Write-Text $Path (($lines -join "`r`n") + "`r`n")
}

# 起動したら起こすタスク (SYSTEM。誰もログインしていなくても動く)。時間の上限は外す (既定は 3 日で止められる)。
# 優先度は普通にする (既定の 7 は「低い」で、CPU も I/O も後回しにされる)。
# **WinUSB の機材と PC/SC (カードリーダー) を SYSTEM から使えるかは、Windows の実機ではまだ確かめていない**
# (CI のランナーには機材が無い。docs/install-windows.md)
function Register-Loop([string]$Name, [string]$Cmd, [string]$Description, [int]$Priority) {
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument "/d /c `"$Cmd`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $settings.Priority = $Priority
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description $Description -Force | Out-Null
}

# **前のバージョンは denpa 本体を wslc (WSL のコンテナ) で動かしていた。** コンテナを止め (録画中なら stop-timeout で
# 終わるまで待つ)、DB の入ったボリュームの中身を $Data へ写し、コンテナとログオン時のタスクと denpa-start.ps1 を外す。
# ボリュームは消さずに残す。denpa.env はこの PC のブラウザの送信元 (wslc が中継して 169.254.x.x に見えていた) を
# ループバックに書き換えて写す。移したあとはここに来ない (denpa-start.ps1 を消すので)。
# 途中で止まっても、流し直せば続きから (写した DB があれば写し直さない)
function Move-FromWslc {
    Use-Continue
    $start = Join-Path $OldPrefix 'denpa-start.ps1'
    if (-not (Test-Path -LiteralPath $start)) { return }
    $db = Join-Path $Data 'denpa.db'
    $ready = Get-Command wslc -ErrorAction SilentlyContinue
    if ($ready) {
        & wslc info *> $null
        $ready = $LASTEXITCODE -eq 0
    }
    if (-not $ready) {
        throw ("前のバージョンの DB が wslc のボリューム $Volume にあります。写すので、wslc を使えるようにしてから流し直してください " +
            '(PowerShell で wsl --update。写したあとは WSL は要りません)')
    }
    # ログオンしたときに、止めたコンテナをまた起こさないように
    Unregister-ScheduledTask -TaskName $DenpaTask -Confirm:$false -ErrorAction SilentlyContinue
    & wslc inspect $Container *> $null
    $exists = $LASTEXITCODE -eq 0
    if ($exists) {
        Say 'wslc の denpa を止めます (録画中なら終わるまで待ちます)'
        & wslc stop $Container
        if ($LASTEXITCODE -ne 0) { throw "wslc の denpa を止められません (wslc stop $Container)" }
    }
    if (-not (Test-Path -LiteralPath $db)) {
        Say "DB を wslc のボリューム $Volume から $Data へ写します"
        $work = Join-Path ([IO.Path]::GetTempPath()) "denpa-move-$([Guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force -Path $work | Out-Null
        try {
            & wslc run --rm -v "${Volume}:/d" -v "${work}:/o" alpine tar -C /d -cf /o/data.tar .
            if ($LASTEXITCODE -ne 0) { throw "wslc のボリューム $Volume を読めません" }
            Set-DataDir
            & $Tar -xf (Join-Path $work 'data.tar') -C $Data
            if ($LASTEXITCODE -ne 0) { throw "$Data に書けません" }
        } finally {
            Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
        }
        if (-not (Test-Path -LiteralPath $db)) { throw "wslc のボリューム $Volume に denpa.db がありません" }
    }
    if ($exists) {
        & wslc rm $Container *> $null
        if ($LASTEXITCODE -ne 0) { throw "wslc の denpa を外せません (wslc rm $Container)" }
    }
    $oldEnv = Join-Path $DenpaDir 'denpa.env'
    $newEnv = Join-Path $Data 'denpa.env'
    if ((Test-Path -LiteralPath $oldEnv) -and -not (Test-Path -LiteralPath $newEnv)) {
        $text = [IO.File]::ReadAllText($oldEnv).Replace('169.254.0.0/16', '127.0.0.0/8,::1/128')
        Write-Text $newEnv $text
        Move-Item -Force -LiteralPath $oldEnv -Destination "$oldEnv.wslc"
        Say "denpa.env は $newEnv へ写しました (前のものは $oldEnv.wslc に退けてあります)"
    }
    Remove-Item -Force -LiteralPath $start
    Say "移しました。wslc のボリューム $Volume は残してあります (要らなければ wslc volume rm $Volume)"
}

# 挿さっている USB の機材を USB ID (vid:pid) で探す。複合デバイスの子 (MI_xx) は入らない
function Get-UsbPnp([string]$Usb) {
    $id = $Usb -split ':'
    try {
        return @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
                Where-Object { $_.InstanceId -match "^USB\\VID_$($id[0])&PID_$($id[1])\\" })
    } catch {
        return @()
    }
}

# エージェントが USB を直に持つ機材の USB ID と名前 (denpa-agent --usb-ids。機種の表はエージェントが持つ)。
# **wdi-simple.exe と同じバージョンのエージェントにだけ聞く。** それより前のエージェントは --usb-ids を読まずに
# サーバを起動して、終わらない
function Get-AgentUsbId {
    Use-Continue
    $exe = "$Prefix\bin\denpa-agent.exe"
    if (-not (Test-Path -LiteralPath $WdiSimple) -or -not (Test-Path -LiteralPath $exe)) { return @() }
    $json = & $exe --usb-ids 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $json.Trim()) { return @() }
    $list = ConvertFrom-Json $json
    return @($list | ForEach-Object { $_ })
}

# Windows でドライバが WinUSB でないと使えない機材の USB ID と名前。エージェントが USB を直に持つ機材 (Get-AgentUsbId。
# IT930x の機材と、PX-S1UD などの Siano の機材もここに入る)
function Get-WinUsbTarget {
    $targets = @()
    foreach ($entry in @(Get-AgentUsbId)) { $targets += [pscustomobject]@{ Usb = [string]$entry.usb; Name = [string]$entry.name } }
    return $targets
}

# $Targets のうち挿さっている機材と、いまのドライバ (Driver。入っていなければ空)
function Get-WinUsbDevice([object[]]$Targets) {
    foreach ($target in $Targets) {
        foreach ($pnp in @(Get-UsbPnp $target.Usb)) {
            [pscustomobject]@{ Usb = $target.Usb; Name = $target.Name; Driver = [string]$pnp.Service }
        }
    }
}

# エージェントが USB を直に持つ機材が挿さっていれば、ドライバが WinUSB かを見る。
# **ここでは替えない** (ほかのソフトで使っていた機材を、聞かずに使えなくしない)。替える 1 行を案内する (Invoke-WinUsb)
function Show-Tuner {
    $devices = @(Get-WinUsbDevice (Get-WinUsbTarget))
    foreach ($device in $devices) {
        if ($device.Driver -eq 'WinUSB') {
            Say "$($device.Name): WinUSB で使えます"
        } else {
            Say "$($device.Name): $(if ($device.Driver) { "ドライバが $($device.Driver) です" } else { 'ドライバが入っていません' })。WinUSB に替えると使えます"
        }
    }
    if (-not (Test-Path -LiteralPath $WdiSimple)) {
        Say 'チューナーのドライバは Zadig (https://zadig.akeo.ie) で WinUSB に替えます (docs/install-windows.md)'
        return
    }
    if ($devices.Count -eq 0) {
        Say 'IT930x の機材・Siano・CECH-ZD1 J・PIX-DT295 のチューナーは見当たりません'
    }
    Say 'チューナーを挿したあと、次の 1 行でドライバを WinUSB に替えられます (機材ごとに聞いてから替えます。docs/install-windows.md)'
    Say "  $WinUsbCommand"
}

# wdi-simple.exe で $Usb の機材のドライバを WinUSB に替え、終了コードを返す (0 が成功。ほかは libwdi のエラーの番号)。
# wdi-simple は INF と署名を $Work に作ってから入れる。INF に書く機材の名前は ASCII にする
function Invoke-WdiSimple([string]$Usb, [string]$Name, [string]$Work) {
    Use-Continue
    $id = $Usb -split ':'
    $label = if ($Name -match '^[\x20-\x7E]+$') { $Name } else { 'USB tuner' }
    & $WdiSimple --vid "0x$($id[0])" --pid "0x$($id[1])" --type 0 --name $label --dest $Work | ForEach-Object { Write-Host "    $_" }
    return $LASTEXITCODE
}

function Read-Answer([string]$Prompt) { return Read-Host $Prompt }

# ドライバを替えた機材をエージェントに見つけ直させる。録画中なら終わるまで待つ (Stop-Denpa)
function Restart-Agent {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return }
    Say 'エージェントを起動し直します'
    Stop-Denpa "$Prefix\bin\denpa-agent.exe"
    Start-ScheduledTask -TaskName $TaskName
}

# **挿さっているチューナーのドライバを WinUSB に替える** (-WinUsb)。対象は Get-WinUsbTarget の機材のうち、挿さっていて
# WinUSB になっていないものだけ。**機材ごとに、いまのドライバを見せて聞いてから替える** (TVTest などが使っているドライバを
# 置き換えるため)。-Yes を付けたときだけ聞かずに替える。同じ USB ID の機材が 2 台以上あれば、wdi-simple がまとめて替える。
# 替えるのは libwdi の wdi-simple.exe で、していることは Zadig と同じ (docs/install-windows.md)
function Invoke-WinUsb([switch]$Yes) {
    if (-not (Test-Path -LiteralPath "$Prefix\bin\denpa-agent.exe")) {
        throw "denpa が入っていません。入れてから、もう一度流してください (irm $Installer | iex)"
    }
    if (-not (Test-Path -LiteralPath $WdiSimple)) {
        throw ("入っている denpa に wdi-simple.exe がありません。新しいバージョンに上げてから (irm $Installer | iex)、もう一度流してください。" +
            '上げずに替えるときは Zadig (https://zadig.akeo.ie) を使います (docs/install-windows.md)')
    }
    $devices = @(Get-WinUsbDevice (Get-WinUsbTarget))
    if ($devices.Count -eq 0) {
        throw '対応しているチューナーが挿さっていません。挿してから、もう一度流してください (対応している機材は docs/install-windows.md)'
    }
    foreach ($device in $devices | Where-Object { $_.Driver -eq 'WinUSB' }) {
        Say "$($device.Name) ($($device.Usb)): WinUSB になっています"
    }
    $groups = @($devices | Where-Object { $_.Driver -ne 'WinUSB' } | Group-Object Usb)
    if ($groups.Count -eq 0) {
        Say 'ドライバを替える機材はありません'
        return
    }
    Say 'チューナーのドライバを WinUSB に替えます (libwdi の wdi-simple.exe。Zadig と同じ方法です)'
    Say '  - 替えた機材は、いまのドライバを使うソフト (TVTest など) からは使えなくなります'
    Say '  - libwdi がこの PC で自己署名の証明書を作り、Windows の証明書ストア (信頼されたルート証明機関と信頼された発行元) に入れます。秘密鍵は署名したあとで消します'
    Say '  - 元に戻すときは、デバイス マネージャーでその機材の「デバイスのアンインストール」を選び、ドライバーを削除するチェックボックスをオンにして外してから、機材を挿し直します'
    $work = Join-Path ([IO.Path]::GetTempPath()) "denpa-winusb-$([Guid]::NewGuid().ToString('N'))"
    $failed = @()
    $replaced = 0
    try {
        foreach ($group in $groups) {
            $device = $group.Group[0]
            $title = "$($device.Name) ($($device.Usb))"
            foreach ($one in $group.Group) {
                Say "${title}: $(if ($one.Driver) { "いまのドライバは $($one.Driver) です" } else { 'いまはドライバが入っていません' })"
            }
            if ($group.Count -gt 1) { Say "  同じ USB ID の機材が $($group.Count) 台挿さっています。まとめて替えます" }
            if (-not $Yes) {
                $answer = Read-Answer '    WinUSB に替えますか? [y/N]'
                if ($answer -notmatch '^\s*(y|yes)\s*$') {
                    Say "${title}: 替えませんでした"
                    continue
                }
            }
            $code = [int](Invoke-WdiSimple $device.Usb $device.Name (Join-Path $work $device.Usb.Replace(':', '-')))
            if ($code -eq 0) {
                $replaced++
                Say "${title}: WinUSB に替えました"
            } else {
                $failed += "$title (wdi-simple.exe の終了コード $code)"
                Say "${title}: 替えられませんでした (wdi-simple.exe の終了コード $code)"
            }
        }
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }
    if ($replaced -gt 0) { Restart-Agent }
    if ($failed.Count -gt 0) {
        throw ("ドライバを替えられなかった機材があります: $($failed -join '、')。機材を挿し直してから、もう一度流してください。" +
            'それでも替えられないときは Zadig (https://zadig.akeo.ie) で替えます (docs/install-windows.md)')
    }
}

# zip をまるごと $To (まだ無いフォルダ) に開く。Expand-Archive は 5.1 だとファイルの多い zip (本体は数千) で何分も掛かる
function Expand-Zip([string]$Path, [string]$To) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Path, $To)
}

# 置くものを $Work\new に揃える。エージェント (bin) と、-AgentOnly でなければ本体 (server)。
# $Ref が空なら手元の zip (DENPA_AGENT_ZIP・DENPA_SERVER_ZIP)
function Get-Payload([string]$Ref, [string]$Work, [switch]$Server) {
    # --- エージェント本体 (GitHub のリリース。$Ref が空なら手元の zip) ---
    $agent = $env:DENPA_AGENT_ZIP
    if ($Ref) {
        $name = "denpa-agent-$($Ref -replace '^v', '')-windows-x64.zip"
        $agent = Join-Path $Work $name
        Say "denpa-agent $Ref"
        try {
            Get-ReleaseFile $Ref $name $agent
        } catch {
            throw "$Ref には Windows 用のエージェントがありません。Windows 用は v1.23.1 からなので、それより前のバージョンは Windows に入れられません"
        }
    }
    Expand-Zip $agent "$Work\new\bin"

    # --- denpa 本体 (bun・アプリ・ffmpeg・字・デコーダ)。エージェントと同じバージョン ---
    if ($Server) {
        $zip = $env:DENPA_SERVER_ZIP
        if (-not $zip) {
            $version = if ($Ref) { $Ref } else { Get-Version }
            $name = "denpa-$($version -replace '^v', '')-windows-x64.zip"
            $zip = Join-Path $Work $name
            Say "denpa $version"
            try {
                Get-ReleaseFile $version $name $zip
            } catch {
                throw "$version には Windows でそのまま動かす denpa 本体がありません。新しいバージョンを入れてください"
            }
        }
        Expand-Zip $zip "$Work\new\server"
        foreach ($file in 'bun.exe', 'app\server.js', 'ffmpeg\ffmpeg.exe') {
            if (-not (Test-Path -LiteralPath "$Work\new\server\$file")) { throw "denpa 本体の zip に $file が入っていません" }
        }
    }
    # ブラウザで落とした zip を手で渡されたときの「インターネットから来た」印を外す (SmartScreen に止められないように)
    Get-ChildItem -Recurse -File "$Work\new" | Unblock-File
}

# エージェントを起こす .cmd とタスク。環境変数はコンテナで既定にしている置き場を Windows の置き場に向け直すものだけ
# (Mac の plist と同じ。合言葉は環境変数で渡さず、エージェントが tls\pair-token から読む。Get-PairToken)。
# **優先度は普通 (4) に。** 既定の 7 だと、本体のエンコードが CPU を使っている間にエージェントが USB を読みに行けず
# TS を落としうる (Mac の ProcessType Interactive と同じ理由)
function Register-Agent {
    $cmd = "$Prefix\denpa-agent.cmd"
    $vars = [ordered]@{
        AGENT_PORT = $Port; TUNERS_FILE = "$DenpaDir\config\tuners.json"; CHANNELS_FILE = "$DenpaDir\config\channels.json"
        RAW_DIR = "$Media\recorded"
    }
    Write-Loop $cmd $vars '' '' "`"$Prefix\bin\denpa-agent.exe`"" $Log
    Register-Loop $TaskName $cmd 'denpa のチューナーエージェント (install.ps1 が入れた)' 4
    Start-ScheduledTask -TaskName $TaskName

    Say 'エージェントを起動しました。応答を待ちます'
    for ($i = 0; $i -lt 15; $i++) {
        $tuners = Get-AgentStatus "$Prefix\bin\denpa-agent.exe"
        if ($tuners) {
            Write-Host $tuners
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "エージェントが応答しません。ログを見てください: $Log"
}

# denpa 本体を起こす .cmd とタスク。**置き場・ffmpeg・エージェントの宛先はここで決め、denpa.env より勝たせる**
# (denpa.env は手で直すところで、そこに書いても SYSTEM で動かすものは変えられない)。
# エージェントは同じ PC なので 127.0.0.1 で繋ぐ (denpa は組んだときの証明書そのもので確かめるので、名前は見ない)。
# ログはエージェントの隣 (~/denpa/denpa.log)。ポートは LAN のプライベートとドメインのネットワークにだけ開ける
function Register-Server([string]$Ref, [string]$Token) {
    Set-DataDir
    # 本体の環境変数。**手で書き足すのはここ** (上げ直しても触らない。最後も改行で終える)
    $envFile = Join-Path $Data 'denpa.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        Write-Text $envFile ((@(
                '# denpa 本体の環境変数 (docs/config.md)。install.ps1 は無いときだけ作り、あとは触らない。',
                '# 直したら、install.ps1 を流し直すか Windows を再起動する。置き場・ffmpeg・エージェントの宛先は install.ps1 が決めるので、書いても効かない',
                'TZ=Asia/Tokyo',
                'ENCODE_CONCURRENCY=2',
                '# 誰を通すか (docs/auth.md)。127.0.0.0/8 と ::1 はこの PC のブラウザ',
                'TRUSTED_NETWORKS=127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8'
            ) -join "`n") + "`n")
    }
    $version = $Ref -replace '^v', ''
    $server = "$Prefix\server"
    $vars = [ordered]@{
        NODE_ENV = 'production'
        DENPA_VERSION = $(if ($version -match '^\d+\.\d+\.\d+$') { "v$version" } else { 'dev' })
        DENPA_DB = "$Data\denpa.db"
        RAW_DIR = "$Media\recorded"
        ENCODED_DIR = "$Media\library"
        FFMPEG = "$server\ffmpeg\ffmpeg.exe"
        FFPROBE = "$server\ffmpeg\ffprobe.exe"
        MPEG2_DIR = "$server\mpeg2"
        FONT_DIR = "$server\font"
        TUNER_AGENT_URL = "https://127.0.0.1:$Port#pair=$Token"
        PORT = $WebPort
        # bun が変換した .ts を SYSTEM のフォルダへ溜めない (本番のイメージと同じ)
        BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0'
    }
    # 合言葉 (TUNER_AGENT_URL の #pair=) が入るので、SYSTEM と管理者だけが読める $Data に置く (Program Files はだれでも読める)
    $cmd = "$Data\denpa.cmd"
    Write-Loop $cmd $vars $envFile "$server\app" "`"$server\bun.exe`" server.js" $ServerLog
    # 優先度は普通 (6)。エンコードの ffmpeg は denpa が自分でいちばん低くする (src/lib/server/stream.ts の lowerPriority)
    Register-Loop $DenpaTask $cmd 'denpa 本体 (install.ps1 が入れた)' 6

    Remove-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name $FirewallRule -DisplayName 'denpa' -Description 'denpa の画面 (install.ps1 が足した)' `
        -Direction Inbound -Protocol TCP -LocalPort $WebPort -Profile Domain, Private -Action Allow | Out-Null

    Start-ScheduledTask -TaskName $DenpaTask
    Say 'denpa の応答を待ちます'
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Health) {
            Say "起動しました: $Url (LAN のほかの機器からは http://$($env:COMPUTERNAME):$WebPort)"
            Say 'LAN のほかの機器から開けないときは、Windows の設定でこの PC のネットワークを「プライベート」にしてください'
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "denpa が応答しません。ログを見てください: $ServerLog"
}

# 通知領域のアイコン (denpa-tray.exe)。**サインインしたら起きる**ように HKLM の Run に載せる (誰がサインインしても出る)。
# 出すのは本体の様子と新しいバージョンで、更新はメニューから人が選んだときにこの install.ps1 を流す (docs/install-windows.md)。
# いまサインインしている人にはここで起こす。管理者の窓から起こすと管理者で動いてしまうので、エクスプローラーに起こさせる
# (ブラウザを開くのと同じ)。この窓のセッションにエクスプローラーがいなければ (CI など) 起こさず、次のサインインを待つ。
# zip に入っていなければ (手元で組んだ DENPA_AGENT_ZIP など) 載せない
function Register-Tray {
    if (-not (Test-Path -LiteralPath $TrayExe)) { return }
    New-ItemProperty -Path $RunKey -Name $RunName -Value "`"$TrayExe`"" -PropertyType String -Force | Out-Null
    $session = (Get-Process -Id $PID).SessionId
    if (Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }) {
        Start-Process "$env:WINDIR\explorer.exe" "`"$TrayExe`""
    }
}

# 前のバージョンが作った px4d のソケットの置き場を消す。リンクならリンクだけを消す (中までたどって、リンク先を消さない)
function Remove-Px4Runtime {
    if (-not (Test-Path -LiteralPath $Px4Runtime)) { return }
    $runtime = Get-Item -LiteralPath $Px4Runtime -Force
    if ($runtime.Attributes -band [IO.FileAttributes]::ReparsePoint) { $runtime.Delete() }
    else { Remove-Item -Recurse -Force -LiteralPath $Px4Runtime }
}

function Install-Denpa([string]$Ref, [string]$Token, [switch]$AgentOnly) {
    $work = Join-Path ([IO.Path]::GetTempPath()) "denpa-install-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path "$work\new" | Out-Null
    $parts = @('bin')
    if (-not $AgentOnly) { $parts += 'server' }
    try {
        Get-Payload $Ref $work -Server:(-not $AgentOnly)
        # 前のバージョン (wslc) の本体を止めて DB を写す。古いエージェントが動いている間に (コンテナの録画を待つ)
        if (-not $AgentOnly) { Move-FromWslc }

        # --- 入れ替える。**揃ってから止める** (取ってこられなかったら、動いているものに触らない) ---
        Stop-Denpa "$work\new\bin\denpa-agent.exe" -Server:(-not $AgentOnly)
        foreach ($dir in $Prefix, "$DenpaDir\config", "$Media\recorded", "$Media\library") {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        foreach ($part in $parts) {
            if (Test-Path -LiteralPath "$Prefix\$part") { Remove-Item -Recurse -Force -LiteralPath "$Prefix\$part" }
            Move-Item -LiteralPath "$work\new\$part" -Destination "$Prefix\$part"
        }
        # 前のバージョンが置いていた siano-userland と px4-userland (いまは Siano と IT930x の機材をエージェントが USB で直に動かすので要らない)
        foreach ($part in 'siano-userland', 'px4-userland') {
            if (Test-Path -LiteralPath "$Prefix\$part") { Remove-Item -Recurse -Force -LiteralPath "$Prefix\$part" }
        }
        Remove-Px4Runtime
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }
    # 前のバージョンの置き場 (エージェントと denpa-start.ps1)。中身は止めて入れ替えたので消す。
    # -AgentOnly で wslc の本体がまだ残っているときは denpa-start.ps1 を残す (本体を入れるときに DB を写す目印。Move-FromWslc)
    if (Test-Path -LiteralPath $OldPrefix) {
        if ($AgentOnly -and (Test-Path -LiteralPath "$OldPrefix\denpa-start.ps1")) {
            foreach ($part in 'bin', 'px4-userland', 'siano-userland', 'denpa-agent.cmd') {
                if (Test-Path -LiteralPath "$OldPrefix\$part") { Remove-Item -Recurse -Force -LiteralPath "$OldPrefix\$part" }
            }
        } else {
            Remove-Item -Recurse -Force -LiteralPath $OldPrefix
        }
    }

    Register-Agent
    if (-not $AgentOnly) {
        Register-Server $(if ($Ref) { $Ref } elseif ($env:DENPA_SERVER_ZIP) { '' } else { Get-Version }) $Token
        Register-Tray
    }
}

function Invoke-Main([switch]$NoOpen, [switch]$Uninstall, [switch]$AgentOnly, [switch]$WinUsb, [switch]$Yes) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    # チューナーのドライバを WinUSB に替えるだけ (入れてあるものには触らない。Invoke-WinUsb)
    if ($WinUsb) {
        if (-not (Test-Admin)) {
            throw '管理者の PowerShell で流してください (スタートボタンを右クリックして「ターミナル (管理者)」)。ドライバを替えるには管理者の権限が必要です'
        }
        Invoke-WinUsb -Yes:$Yes
        return
    }

    if (-not (Test-Admin)) {
        throw '管理者の PowerShell で流してください (スタートボタンを右クリックして「ターミナル (管理者)」)。denpa とエージェントを、ログインしなくても動くタスク (SYSTEM) に載せるためです'
    }

    # **Windows 10 1809 / Windows Server 2019 (ビルド 17763) より前では動かない。** 本体の bun がそれより前の Windows を受けず、
    # ダウンロードと展開に使う curl.exe と tar.exe も 1803 / Server 2019 から。Server 2016 (14393) では curl.exe が無く、
    # 「最新のリリースが分かりません」で止まっていた。外すだけ (-Uninstall) なら使わないので止めない
    $build = [int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    if (-not $Uninstall -and $build -lt $MinBuild) {
        throw "この Windows (ビルド $build) では動きません。Windows 10 1809 / Windows Server 2019 (ビルド $MinBuild) 以降が必要です"
    }

    if ($Uninstall) {
        # **録画中なら終わるまで待つ** (Stop-Denpa。前のバージョンの wslc のコンテナは stop-timeout)
        if ((Test-Path -LiteralPath "$OldPrefix\denpa-start.ps1") -and (Get-Command wslc -ErrorAction SilentlyContinue)) {
            Use-Continue
            & wslc stop $Container *> $null
            & wslc rm $Container *> $null
            $ErrorActionPreference = 'Stop'
            Say "前のバージョンの DB は wslc のボリュームに残してあります (要らなければ wslc volume rm $Volume)"
        }
        $exe = "$Prefix\bin\denpa-agent.exe"
        if (-not (Test-Path -LiteralPath $exe)) { $exe = "$OldPrefix\bin\denpa-agent.exe" }
        Stop-Denpa $exe -Server
        foreach ($task in $DenpaTask, $TaskName, $WakeTask) {
            Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
        }
        Remove-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
        foreach ($dir in $Prefix, $OldPrefix) {
            if (Test-Path -LiteralPath $dir) { Remove-Item -Recurse -Force -LiteralPath $dir }
        }
        foreach ($file in 'denpa.cmd', 'wake-task.xml') {
            if (Test-Path -LiteralPath "$Data\$file") { Remove-Item -Force -LiteralPath "$Data\$file" }
        }
        Remove-Px4Runtime
        Say '外しました。残してあるもの (要らなければ手で消してください):'
        Say "  DB と denpa.env $Data / エージェントの設定とログ $DenpaDir / 録画 $Media"
        return
    }

    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw '対応しているのは x64 の Windows だけです (エージェントの配布物が x64 用だけです)' }

    $ref = if ($env:DENPA_AGENT_ZIP) { '' } else { Get-Version }
    # エージェントを起こす前に置いておく (無ければエージェントが自分で作り、そちらと食い違わないように)
    $token = Get-PairToken
    Install-Denpa $ref $token -AgentOnly:$AgentOnly
    Show-Tuner
    if ($AgentOnly) {
        Say 'エージェントだけ入れました。denpa の TUNER_AGENT_URL に次を書いてください (#pair= の後ろは合言葉。人に見せない):'
        Say "  https://$($env:COMPUTERNAME):$Port#pair=$token"
        Say "(LAN から繋ぐなら、Windows ファイアウォールでポート $Port への受信を許してください)"
        return
    }
    # 管理者の窓から開くとブラウザまで管理者で動くので、エクスプローラーに開かせる (ログインしている人のブラウザで開く)
    if (-not $NoOpen) { Start-Process "$env:WINDIR\explorer.exe" $Url }
}

Invoke-Main -NoOpen:$NoOpen -Uninstall:$Uninstall -AgentOnly:$AgentOnly -WinUsb:$WinUsb -Yes:$Yes
