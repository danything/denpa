# ---------------------------------------------------------------------------
# denpa を Windows (x64) に立てる。**管理者の PowerShell の 1 行で、ブラウザが開くところまで。**
#
#   irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -Uninstall
#       引数を渡すときはこの書き方。-NoOpen (ブラウザを開かない) / -Uninstall (止めて外す。DB・設定・録画は残す) /
#       -AgentOnly (エージェントだけ。denpa 本体は別の機械で動かす)
#
# **denpa 本体もエージェントも Windows の上でそのまま動かす** (コンテナは使わない)。本体は配布物の bun と ffmpeg で、
# エージェントは .NET の実行ファイル。どちらもタスク スケジューラの「起動したら起こす」タスクに **SYSTEM で**載せるので、
# 誰もログインしていなくても録画でき、外から観られる。そのために管理者で流す。
# **Windows で使えるチューナーは px4-userland の機材 (PX-Q3U4 など) と siano-userland の機材 (PX-S1UD など) と Sony CECH-ZD1 J と PIXELA PIX-DT295 (試験的)**
# (DVB は無い)。ドライバを WinUSB にするのは人の手で (Zadig。docs/install-windows.md)。
#
# もう一度流せば上げ直し。本体は**エージェントと同じリリースのバージョン**に揃える。
# 前のバージョン (本体を wslc のコンテナで動かしていた) からは、DB を写して移る (Move-FromWslc)。
#
# 置き場:
#   %ProgramFiles%\denpa\                 エージェント (bin\)・px4-userland・siano-userland・本体 (server\。bun・アプリ・ffmpeg・字・デコーダ)・
#                                         起こす denpa.cmd と denpa-agent.cmd (管理者しか書けない。SYSTEM で動かすものを、ほかの人に書き換えさせない)
#   %ProgramData%\denpa\                  DB (denpa.db) とその隣のもの (局ロゴ・鍵)・denpa.env (本体の環境変数。無いときだけ雛形を作る)。
#                                         SYSTEM と管理者だけが読み書きできる
#   ~/denpa (DENPA_HOME)                  エージェントの config/ (tls\pair-token は denpa とエージェントが組むときの合言葉。無いときだけ作る)・
#                                         ログ (denpa.log・denpa-agent.log)
#   C:\denpa-run                          px4d のソケットの置き場 (持ち主は SYSTEM、書けるのは SYSTEM・Administrators だけ。px4d がそう決めている)
#   ~/Videos/denpa/{recorded,library}     元の TS と出来上がった録画
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、DENPA_HOME、
# DENPA_AGENT_ZIP・DENPA_SERVER_ZIP (手元でビルドしたエージェント・本体の zip を絶対パスで。CI と開発用)
#
# Windows に最初から入っている PowerShell 5.1 で動くように書く (pwsh でも動く)。
# `irm | iex` は呼んだ人のセッションでそのまま走るので、exit は使わない (窓ごと閉じる)。
# ---------------------------------------------------------------------------
param([switch]$NoOpen, [switch]$Uninstall, [switch]$AgentOnly)

# siano-userland のバージョン。**agent/Dockerfile・install.sh と揃える** (Renovate が一緒に上げる)。
# 中身は配布元の SHA256SUMS で確かめるので、バージョンを上げてもここのハッシュは要らない
# renovate: datasource=github-releases depName=Khronos31/siano-userland extractVersion=^v(?<version>.*)$
$SianoUserlandVersion = '0.1.10'
$IsdbtRioSha256 = '054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818'
# px4-userland のバージョンも同じ。**0.2.1 より下げない** (Windows 対応は 0.2.0 から、--runtime-dir を明示したときの
# 起動の不具合が直ったのが 0.2.1)
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
$Px4UserlandVersion = '0.2.1'
# IT930x のファームウェアはエージェントに同梱している (agent/Denpa.Agent/Px4Firmware.cs)。ここでは置かない
# 配布 zip から取り出すもの。**使うのは px4d.exe と px4ctl.exe だけ** (受信機もカードも px4d の制御ソケットで直に話す)。
# px4-ts.exe と WinSCard.dll (B25 のアプリの横に置く代わりの DLL) は置かない。残りはライセンスの文書
$Px4Keep = @('px4d.exe', 'px4ctl.exe', 'LICENSE', 'DEPENDENCY-NOTICE.txt', 'THIRD_PARTY_NOTICES.md', 'libusb/*', 'toolchain/*')

$Repo = 'danything/denpa'
$WebPort = 3000
$Url = "http://localhost:$WebPort"
$DenpaDir = if ($env:DENPA_HOME) { $env:DENPA_HOME } else { Join-Path $env:USERPROFILE 'denpa' }
$Prefix = Join-Path $env:ProgramFiles 'denpa'
$Data = Join-Path $env:ProgramData 'denpa'
# 前のバージョンの置き場 (ユーザーのフォルダの下。エージェントと wslc の本体を起こす denpa-start.ps1)。見つけたら移して消す
$OldPrefix = Join-Path $env:LOCALAPPDATA 'denpa-agent'
# px4d のソケットの置き場。**ユーザーのフォルダの下にしない。** ソケットのパスは UTF-8 で 108 バイトまでで、
# 日本語のユーザー名だとすぐ溢れる。非 ASCII のパスだと px4d の ready の行も途切れる (px4-userland #52)
$Px4Runtime = 'C:\denpa-run'
$Media = Join-Path $env:USERPROFILE 'Videos\denpa'
$Log = Join-Path $DenpaDir 'denpa-agent.log'
$ServerLog = Join-Path $DenpaDir 'denpa.log'
$TaskName = 'denpa-agent'
$DenpaTask = 'denpa'
# 本体が次の録画の前にスリープから起こすタスク (本体が書き直す。src/lib/server/power.ts)
$WakeTask = 'denpa-wake'
$FirewallRule = 'denpa'
$Port = 25252
# 前のバージョンの wslc のコンテナとボリューム
$Container = 'denpa'
$Volume = 'denpa-data'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$System = 'S-1-5-18'
$Administrators = 'S-1-5-32-544'

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
# タスクを止めても、.cmd の下で起きたもの (bun・ffmpeg・エージェント・siano-ts・px4d) までは止まらないので、
# コマンドラインに置き場が入っているもので見つけて落とす (前のバージョンの置き場のものも)。
# **px4d は先に落とさない。** エージェントが終われば px4d は標準入力が閉じたのを見て、後片付け
# (LNB を 0V に戻す・ソケットを消す) をして自分で終わる。10 秒待っても残っていれば落とす。
# 録画中かを聞く denpa-agent は $Exe (上げ直すときは取ってきた新しいほう。古いものは --status を知らない)。
# -Server を付けなければエージェントだけ (-AgentOnly のとき)。エンコードの途中なら、次に起きたときにやり直す
function Stop-Denpa([string]$Exe, [switch]$Server) {
    $tasks = @($TaskName)
    $names = @('conhost.exe', 'cmd.exe', 'denpa-agent.exe', 'siano-ts.exe', 'px4d.exe', 'px4ctl.exe')
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
        $left | Where-Object { $i -ge 10 -or $_.Name -ne 'px4d.exe' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
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

# Siano のチューナーが挿さっていれば、ドライバが WinUSB かを見る (入れ替えは人の手で。Zadig)
function Show-Tuner {
    try {
        $sticks = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
                Where-Object { $_.InstanceId -match '^USB\\VID_(3275&PID_0080|187F&PID_0600|187F&PID_0302)\\' })
    } catch {
        return
    }
    if ($sticks.Count -eq 0) {
        Say 'Siano のチューナー (PX-S1UD など) は見当たりません。挿したら、Zadig でドライバを WinUSB にしてください (docs/install-windows.md)'
    }
    foreach ($stick in $sticks) {
        if ($stick.Service -eq 'WinUSB') {
            Say "$($stick.FriendlyName): WinUSB で使えます"
        } else {
            Say "$($stick.FriendlyName): ドライバが $(if ($stick.Service) { $stick.Service } else { '入っていません' }) です。Zadig (https://zadig.akeo.ie) で WinUSB にしてください (docs/install-windows.md)"
        }
    }
}

# zip を開く (PowerShell 5.1 でも。中身を 1 つずつ取り出すのに使う)
function Open-Zip([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    return [IO.Compression.ZipFile]::OpenRead($Path)
}

# zip をまるごと $To (まだ無いフォルダ) に開く。Expand-Archive は 5.1 だとファイルの多い zip (本体は数千) で何分も掛かる
function Expand-Zip([string]$Path, [string]$To) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Path, $To)
}

# px4-userland (PX-Q3U4 など) を $To に置く。**要るものだけ取り出す** ($Px4Keep)。
# IT930x のファームウェアはエージェントに同梱しているので、ここでは置かない (docs/tuner-px4.md)
function Get-Px4Userland([string]$Work, [string]$To) {
    Say "px4-userland $Px4UserlandVersion"
    $base = "https://github.com/Khronos31/px4-userland/releases/download/v$Px4UserlandVersion"
    $name = "px4-userland-$Px4UserlandVersion-windows-x86_64.zip"
    Get-Url "$base/$name" "$Work\$name"
    Get-Url "$base/SHA256SUMS" "$Work\px4.sums"
    $line = Get-Content -LiteralPath "$Work\px4.sums" | Where-Object { ($_ -split '\s+')[1] -in $name, "*$name" }
    if (-not $line) { throw "SHA256SUMS に $name が載っていません" }
    Assert-Hash "$Work\$name" (($line -split '\s+')[0])
    $zip = Open-Zip "$Work\$name"
    try {
        foreach ($entry in $zip.Entries) {
            $path = $entry.FullName.Replace('\', '/')
            # 置き場の外に出る名前 (..) は取り出さない
            if ($path.EndsWith('/') -or $path.Split('/') -contains '..' -or -not ($Px4Keep | Where-Object { $path -like $_ })) { continue }
            $target = Join-Path $To $path.Replace('/', '\')
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally {
        $zip.Dispose()
    }
    Remove-Item -Force -LiteralPath "$Work\$name"
    foreach ($exe in 'px4d.exe', 'px4ctl.exe') {
        if (-not (Test-Path -LiteralPath "$To\$exe")) { throw "$name に $exe が入っていません" }
    }
}

# px4-userland のチューナーが WinUSB で使えるかを、px4d に聞いて言う (機種の表は持たない)。
# **エージェントを止めている間に聞く。** px4d が使っている機材は開けず、一覧に出ない
function Show-Px4 {
    Use-Continue
    $px4d = "$Prefix\px4-userland\px4d.exe"
    $json = & $px4d --list-json 2>$null | Where-Object { $_ -like '{*' } | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $json) {
        Say 'px4-userland のチューナーを挙げられませんでした (px4d --list-json)'
        return
    }
    $list = ConvertFrom-Json $json
    $enclosures = @($list.enclosures)
    $devices = @($list.ungrouped_usb_devices)
    foreach ($enclosure in $enclosures) {
        if ($enclosure.status -eq 'ready') {
            Say "$($enclosure.model) ($($enclosure.serial)): WinUSB で使えます"
        } else {
            Say "$($enclosure.model) ($($enclosure.serial)): 使えません ($($enclosure.status))"
        }
    }
    foreach ($device in $devices) {
        if ($device.status -ne 'open_failed') {
            Say "$($device.model) ($($device.usb)): 使えません ($($device.status))"
            continue
        }
        $id = $device.usb -split ':'
        $pnp = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
                Where-Object { $_.InstanceId -match "^USB\\VID_$($id[0])&PID_$($id[1])\\" }) | Select-Object -First 1
        if ($pnp -and $pnp.Service -eq 'WinUSB') {
            Say "$($device.model) (USB $($device.port)): WinUSB ですが開けません。ほかのソフト (TVTest など) が使っていないか見てください"
            continue
        }
        $why = if ($pnp -and $pnp.Service) { "ドライバが $($pnp.Service) なので" } else { 'ドライバが入っていないので' }
        Say ("$($device.model) (USB $($device.port)): ${why}開けません。Zadig (https://zadig.akeo.ie) で WinUSB にしてください " +
            '(PX-Q3U4 / PX-W3U4 は USB の機材が 2 つ並ぶので両方。PLEX のドライバで TVTest などから使っていたなら、そちらからは見えなくなります。docs/install-windows.md)')
    }
    if ($enclosures.Count -eq 0 -and $devices.Count -eq 0) {
        Say 'px4-userland のチューナー (PX-Q3U4 など) は見当たりません。挿したら、Zadig でドライバを WinUSB にしてください (docs/install-windows.md)'
    }
}

# 置くものを $Work\new に揃える。エージェント (bin)・px4-userland・siano-userland と、-AgentOnly でなければ本体 (server)。
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

    # --- siano-userland (PX-S1UD など) ---
    Say "siano-userland $SianoUserlandVersion"
    $base = "https://github.com/Khronos31/siano-userland/releases/download/v$SianoUserlandVersion"
    $siano = "siano-ts-$SianoUserlandVersion-windows-x64.zip"
    Get-Url "$base/$siano" "$Work\$siano"
    Get-Url "$base/SHA256SUMS" "$Work\siano.sums"
    $line = Get-Content -LiteralPath "$Work\siano.sums" | Where-Object { ($_ -split '\s+')[1] -in $siano, "*$siano" }
    if (-not $line) { throw "SHA256SUMS に $siano が載っていません" }
    Assert-Hash "$Work\$siano" (($line -split '\s+')[0])
    Expand-Zip "$Work\$siano" "$Work\new\siano-userland"
    Assert-Hash "$Work\new\siano-userland\firmware\isdbt_rio.inp" $IsdbtRioSha256

    # --- px4-userland (PX-Q3U4 など) ---
    Get-Px4Userland $Work "$Work\new\px4-userland"

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
# **優先度は普通 (4) に。** 既定の 7 だと、本体のエンコードが CPU を食っている間に siano-ts が USB を読みに行けず
# TS を落としうる (Mac の ProcessType Interactive と同じ理由)
function Register-Agent {
    $cmd = "$Prefix\denpa-agent.cmd"
    $vars = [ordered]@{
        AGENT_PORT = $Port; TUNERS_FILE = "$DenpaDir\config\tuners.json"; CHANNELS_FILE = "$DenpaDir\config\channels.json"
        SIANO_USERLAND_DIR = "$Prefix\siano-userland"; SIANO_FIRMWARE = "$Prefix\siano-userland\firmware\isdbt_rio.inp"
        PX4_USERLAND_DIR = "$Prefix\px4-userland"
        PX4_RUNTIME_DIR = $Px4Runtime
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
    $cmd = "$Prefix\denpa.cmd"
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

function Install-Denpa([string]$Ref, [string]$Token, [switch]$AgentOnly) {
    $work = Join-Path ([IO.Path]::GetTempPath()) "denpa-install-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path "$work\new" | Out-Null
    $parts = @('bin', 'px4-userland', 'siano-userland')
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

    # px4d のソケットの置き場 (エージェントが止まっている間に。持ち主と権限を整える。
    # エージェントは SYSTEM で動くので、持ち主も SYSTEM にする)
    Set-Owned $Px4Runtime @($System, $Administrators) $System
    Show-Px4
    Register-Agent
    if (-not $AgentOnly) { Register-Server $(if ($Ref) { $Ref } elseif ($env:DENPA_SERVER_ZIP) { '' } else { Get-Version }) $Token }
}

function Invoke-Main([switch]$NoOpen, [switch]$Uninstall, [switch]$AgentOnly) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    if (-not (Test-Admin)) {
        throw '管理者の PowerShell で流してください (スタートボタンを右クリックして「ターミナル (管理者)」)。denpa とエージェントを、ログインしなくても動くタスク (SYSTEM) に載せるためです'
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
        foreach ($dir in $Prefix, $OldPrefix) {
            if (Test-Path -LiteralPath $dir) { Remove-Item -Recurse -Force -LiteralPath $dir }
        }
        if (Test-Path -LiteralPath $Px4Runtime) {
            $runtime = Get-Item -LiteralPath $Px4Runtime -Force
            # リンクならリンクだけを消す (中までたどって、リンク先を消さない)
            if ($runtime.Attributes -band [IO.FileAttributes]::ReparsePoint) { $runtime.Delete() }
            else { Remove-Item -Recurse -Force -LiteralPath $Px4Runtime }
        }
        Say '外しました。残してあるもの (要らなければ手で消してください):'
        Say "  DB と denpa.env $Data / エージェントの設定とログ $DenpaDir / 録画 $Media"
        return
    }

    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw '対応しているのは x64 の Windows だけです (px4-userland / siano-userland に ARM 用がありません)' }

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

Invoke-Main -NoOpen:$NoOpen -Uninstall:$Uninstall -AgentOnly:$AgentOnly
