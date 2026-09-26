# ---------------------------------------------------------------------------
# denpa を Windows (x64) に立てる。**PowerShell の1行で、ブラウザが開くところまで。**
#
#   irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -Uninstall
#       引数を渡すときはこの形。-NoOpen (ブラウザを開かない) / -Uninstall (止めて外す。~/denpa・録画・DB は残す) /
#       -NoDocker (エージェントだけ。denpa 本体は別の Linux で動かす)
#
# **Mac (install.sh) と同じ作り。** エージェントは Windows の上でそのまま動かし (タスク スケジューラで
# ログオン時に起こす)、denpa 本体だけ Docker Desktop で (compose.mac.yml)。Docker Desktop は
# コンテナに USB を渡せないので、チューナーとカードに触るエージェントはコンテナに入れられない。
# **Windows で使えるチューナーは siano-userland の機材 (PX-S1UD など) だけ** (px4-userland は
# Windows を出しておらず、DVB も無い)。ドライバを WinUSB にするのは人の手で (Zadig。docs/agent.md)。
#
# **Docker は勝手に入れない。** 無い・起きていないときはエージェントだけ入れて、入れ方を言って終わる。
# **genkan も入れない** (動いていれば使い、http://denpa.localhost で開けるようにする)。
# もう一度流せば上げ直し。compose ファイルもイメージも**エージェントと同じリリースの版**に揃える。
#
# 置き場:
#   ~/denpa (DENPA_HOME)                  compose.yml (上げ直すたびに上書き)・compose.override.yml (手を入れるならここ。
#                                         無いときだけ雛形を作り、あれば触らない)・config/・denpa-agent.log
#   %LOCALAPPDATA%\denpa-agent\           エージェント・siano-userland・起こす .cmd
#   ~/Videos/denpa/{recorded,library}     生TS (エージェントとコンテナの両方が見る) と出来上がった録画
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、DENPA_HOME、
# DENPA_AGENT_ZIP (手元で焼いたエージェントの zip を絶対パスで。CI と開発用)
#
# Windows に最初から入っている PowerShell 5.1 で動くように書く (pwsh でも動く)。
# `irm | iex` は呼んだ人のセッションでそのまま走るので、exit は使わない (窓ごと閉じる)。
# ---------------------------------------------------------------------------
param([switch]$NoOpen, [switch]$Uninstall, [switch]$NoDocker)

# siano-userland の版。**agent/Dockerfile・install.sh と揃える** (Renovate が一緒に上げる)。
# 中身は配布元の SHA256SUMS で確かめるので、版を上げてもここのハッシュは要らない
# renovate: datasource=github-releases depName=Khronos31/siano-userland extractVersion=^v(?<version>.*)$
$SianoUserlandVersion = '0.1.8'
$IsdbtRioSha256 = '054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818'

$Repo = 'danything/denpa'
$Url = 'http://localhost:3000'
$GenkanUrl = 'http://denpa.localhost'
$DenpaDir = if ($env:DENPA_HOME) { $env:DENPA_HOME } else { Join-Path $env:USERPROFILE 'denpa' }
$Prefix = Join-Path $env:LOCALAPPDATA 'denpa-agent'
$Media = Join-Path $env:USERPROFILE 'Videos\denpa'
$Log = Join-Path $DenpaDir 'denpa-agent.log'
$TaskName = 'denpa-agent'
# compose.mac.yml の TUNER_AGENT_URL と揃える
$Port = 25252
# install.ps1 が書いた compose.yml の1行目
$Mark = '# install.ps1 が置いた (版'
$DockerHelp = 'Docker Desktop (https://www.docker.com/products/docker-desktop/) を入れて起こしてから、もう一度流してください'

# genkan に denpa を登録する断片 (install.sh と同じ。理由もそちらに)
$GenkanOverride = @'
services:
  denpa:
    labels:
      caddy: http://denpa.localhost
      caddy.@outside: not remote_ip private_ranges
      caddy.respond: "@outside 403"
      caddy.reverse_proxy: "{{upstreams 3000}}"
    networks: [default, genkan]

networks:
  genkan:
    external: true
'@

function Say([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# 取ってくる。PowerShell 5.1 の Invoke-WebRequest は遅い (進み具合の表示) ので、Windows 10 から入っている curl.exe で
function Get-Url([string]$From, [string]$To) {
    & curl.exe -fsSL --retry 3 -o $To $From
    if ($LASTEXITCODE -ne 0) { throw "取ってこられません: $From" }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected.ToUpperInvariant()) {
        throw "$Path の中身が合いません (取ってくる途中で壊れたかもしれません。もう一度流してください)"
    }
}

# 入れる版。API を使わず、latest の転送先からタグを読む (install.sh と同じ)
function Get-Version {
    if ($env:DENPA_VERSION) { return $env:DENPA_VERSION }
    $tag = & curl.exe -fsLI -o NUL -w '%{url_effective}' "https://github.com/$Repo/releases/latest"
    if ($LASTEXITCODE -ne 0) { throw '最新のリリースが分かりません' }
    return ($tag -split '/')[-1]
}

# ファイルは BOM 無しの UTF-8 で書く (PowerShell 5.1 の Set-Content は BOM を付ける)
function Write-Text([string]$Path, [string]$Text, [Text.Encoding]$Encoding = (New-Object Text.UTF8Encoding $false)) {
    [IO.File]::WriteAllText($Path, $Text, $Encoding)
}

# 録画中か (エージェントに聞く。答えなければ録画していないことにする)
function Test-Recording {
    try {
        $status = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$Port/denpa/tuners"
        return [bool]($status.tuners | ForEach-Object { $_.users } | Where-Object { $_.use -match '^rec( |$)' })
    } catch {
        return $false
    }
}

# エージェントを止める。**録画中なら終わるまで待つ** (Windows はエージェントに「止まれ」を伝える手が無く、
# 止めればその場で落ちる。Mac のように録画を待ってから畳むことができないので、ここで待つ)。
# 起こした .cmd・エージェント・siano-ts を、コマンドラインに置き場が入っているもので見つけて落とす
# (タスクを止めても、.cmd の下で起きたものまでは止まらない)
function Stop-Agent {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return }
    if (Test-Recording) {
        Say '録画中です。終わるまでここで待ちます (Windows では録画の途中で止めると、その録画は切れます)'
        while (Test-Recording) { Start-Sleep -Seconds 10 }
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) {
        $left = @(Get-CimInstance Win32_Process | Where-Object {
                $_.CommandLine -and $_.CommandLine.IndexOf($Prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
            })
        if ($left.Count -eq 0) { return }
        $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    throw "エージェントが止まりません ($Prefix の下のプロセスをタスク マネージャーで止めてから、もう一度流してください)"
}

# **stderr を捨てる外のコマンドの前に。** PowerShell 5.1 は、止める設定 (Stop) のまま 2>$null すると
# stderr の1行目で止まる。呼んだ関数の中だけ Continue にする (Set-Variable -Scope 1)
function Use-Continue { Set-Variable -Scope 1 -Name ErrorActionPreference -Value Continue }

# Docker (Linux のコンテナ) が使えるか。駄目なら理由と入れ方を言って $false (-Quiet なら黙って)
function Test-Docker([switch]$Quiet) {
    Use-Continue
    $why = $null
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        $why = "Docker が見当たりません。$DockerHelp"
    } else {
        $os = & docker info --format '{{.OSType}}' 2>$null
        if ($LASTEXITCODE -ne 0) {
            $why = "Docker が起きていません。$DockerHelp"
        } elseif ($os -ne 'linux') {
            $why = 'Docker Desktop が Windows コンテナのほうになっています。タスク トレイのメニューから Linux コンテナに切り替えてから、もう一度流してください'
        }
    }
    if ($why -and -not $Quiet) { Say $why }
    return -not $why
}

# genkan が入っているか (genkan ネットワークがあるか) と、動いているか (そこに Caddy が居るか)。install.sh と同じ見方
function Test-GenkanInstalled {
    Use-Continue
    & docker network inspect genkan *> $null
    return $LASTEXITCODE -eq 0
}
function Test-GenkanRunning {
    if (-not (Test-GenkanInstalled)) { return $false }
    return [bool](& docker ps --filter network=genkan --format '{{.Image}}' | Select-String -SimpleMatch caddy-docker-proxy)
}

function Invoke-Compose {
    Push-Location $DenpaDir
    try {
        & docker compose @args
        if ($LASTEXITCODE -ne 0) { throw "docker compose $args に失敗しました" }
    } finally {
        Pop-Location
    }
}

function Test-Health([string]$Target, [string[]]$Extra = @()) {
    & curl.exe -fs -o NUL @Extra "$Target/api/health"
    return $LASTEXITCODE -eq 0
}

# compose.mac.yml を ~/denpa/compose.yml に置いて起こす (install.sh の start_denpa と同じ手順)
function Start-Denpa([string]$Ref) {
    Say "denpa $Ref を $DenpaDir に置きます"
    $compose = Join-Path $DenpaDir 'compose.yml'
    $orig = Join-Path $DenpaDir '.compose.yml.orig'
    $override = Join-Path $DenpaDir 'compose.override.yml'
    $fetched = Join-Path $DenpaDir 'compose.yml.new'
    try {
        Get-Url "https://raw.githubusercontent.com/$Repo/$Ref/compose.mac.yml" $fetched
    } catch {
        throw "$Ref に compose.mac.yml がありません。Windows 用はこのあとのリリースから入るので、それより前の版では Windows に入れられません"
    }
    $text = [IO.File]::ReadAllText($fetched)
    Remove-Item -LiteralPath $fetched
    # **版は札で揃える** (x.y.z のときだけ。コミットやブランチなら latest のまま)。
    # **Windows には HOME が無い**ので、録画の置き場も書き換える (compose.mac.yml の2行)
    $version = $Ref -replace '^v', ''
    if ($version -match '^\d+\.\d+\.\d+$') {
        $text = $text -replace '(image: ghcr\.io/danything/[a-z-]+):latest', "`$1:$version"
    }
    if (-not $text.Contains('${HOME}/Movies/denpa/')) { throw "$Ref の compose.mac.yml に録画の置き場 (`${HOME}/Movies/denpa) が見当たりません" }
    $text = $text.Replace('${HOME}/Movies/denpa/', ($Media -replace '\\', '/') + '/')

    # 手で置いた・手を入れた compose.yml は黙って上書きせず、compose.yml.bak に退ける
    if (Test-Path -LiteralPath $compose) {
        $old = [IO.File]::ReadAllText($compose)
        $mine = $old.StartsWith($Mark) -and (Test-Path -LiteralPath $orig) -and
            $old.Substring($old.IndexOf("`n") + 1) -eq [IO.File]::ReadAllText($orig)
        if (-not $mine) {
            Move-Item -Force -LiteralPath $compose -Destination "$compose.bak"
            Say "手で置いた (手を入れた) $compose を compose.yml.bak に退けました。手直しは compose.override.yml に移してください"
        }
    }
    Write-Text $orig $text
    Write-Text $compose ("$Mark $($Ref)。手を入れず、足すものは compose.override.yml に)`n" + $text)

    $registered = (Test-Path -LiteralPath $override) -and (Select-String -LiteralPath $override -SimpleMatch 'denpa.localhost' -Quiet)
    if ($registered -and -not (Test-GenkanInstalled)) {
        throw "genkan が見当たりません。$override の genkan への登録 (labels・networks) を消すか、genkan を入れ直してから流し直してください"
    }
    $genkan = $registered -and (Test-GenkanRunning)
    if (-not (Test-Path -LiteralPath $override)) {
        $genkan = Test-GenkanRunning
        $head = "# 手元で足したい・変えたいものはここに書く。compose.yml は install.ps1 が上げ直すたびに`n" +
            "# 上書きするが、このファイルには触らない (Compose が compose.yml に重ねて読む)。`n" +
            "# たとえば denpa の environment に TRUSTED_NETWORKS: 192.168.1.0/24 を足すなど`n"
        $body = if ($genkan) { "#`n# genkan (http://denpa.localhost) への登録は install.ps1 が書いた`n$GenkanOverride" } else { "services: {}`n" }
        Write-Text $override ($head + $body)
    } elseif (-not $registered -and (Test-GenkanRunning)) {
        Say "compose.override.yml には触りません。genkan の http://denpa.localhost で開くなら、次を足して流し直してください:"
        Write-Host $GenkanOverride
    }

    Invoke-Compose pull
    # 録画中に上げ直すと、録画が終わるまで待ってから入れ替わる (stop_grace_period)
    Invoke-Compose up -d

    Say 'denpa の応答を待ちます'
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Health $Url) {
            $open = $Url
            if ($genkan) {
                # Caddy がラベルを読むまで少し掛かる
                for ($j = 0; $j -lt 15; $j++) {
                    if (Test-Health $GenkanUrl @('--resolve', 'denpa.localhost:80:127.0.0.1')) { $open = $GenkanUrl; break }
                    Start-Sleep -Seconds 2
                }
            }
            Say "立ちました: $open (このマシンからは $Url でも。LAN のほかの機械からは http://$($env:COMPUTERNAME):3000)"
            if (-not $NoOpen) { Start-Process $open }
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "denpa が答えません。cd $DenpaDir; docker compose logs を見てください"
}

# Siano のチューナーが刺さっていれば、ドライバが WinUSB かを見る (入れ替えは人の手で。Zadig)
function Show-Tuners {
    try {
        $sticks = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
                Where-Object { $_.InstanceId -match '^USB\\VID_(3275&PID_0080|187F&PID_0600|187F&PID_0302)\\' })
    } catch {
        return
    }
    if ($sticks.Count -eq 0) {
        Say 'Siano のチューナー (PX-S1UD など) は見当たりません。挿したら、Zadig でドライバを WinUSB にしてください (docs/agent.md)'
    }
    foreach ($stick in $sticks) {
        if ($stick.Service -eq 'WinUSB') {
            Say "$($stick.FriendlyName): WinUSB で使えます"
        } else {
            Say "$($stick.FriendlyName): ドライバが $(if ($stick.Service) { $stick.Service } else { '入っていません' }) です。Zadig (https://zadig.akeo.ie) で WinUSB にしてください (docs/agent.md)"
        }
    }
}

function Install-Agent([string]$Ref) {
    $work = Join-Path ([IO.Path]::GetTempPath()) "denpa-install-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path "$work\new" | Out-Null
    try {
        # --- エージェント本体 (GitHub のリリース。$Ref が空なら手元の zip) ---
        $agent = $env:DENPA_AGENT_ZIP
        if ($Ref) {
            $name = "denpa-agent-$($Ref -replace '^v', '')-windows-x64.zip"
            $agent = Join-Path $work $name
            Say "denpa-agent $Ref"
            try {
                Get-Url "https://github.com/$Repo/releases/download/$Ref/$name" $agent
            } catch {
                throw "$Ref には Windows 用のエージェントがありません。Windows 用はこのあとのリリースから添えるので、それより前の版では Windows に入れられません"
            }
            Get-Url "https://github.com/$Repo/releases/download/$Ref/$name.sha256" "$agent.sha256"
            Assert-Hash $agent ((Get-Content -LiteralPath "$agent.sha256" -Raw) -split '\s+')[0]
        }
        Expand-Archive -Force -LiteralPath $agent -DestinationPath "$work\new\bin"

        # --- siano-userland (PX-S1UD など) ---
        Say "siano-userland $SianoUserlandVersion"
        $base = "https://github.com/Khronos31/siano-userland/releases/download/v$SianoUserlandVersion"
        $siano = "siano-ts-$SianoUserlandVersion-windows-x64.zip"
        Get-Url "$base/$siano" "$work\$siano"
        Get-Url "$base/SHA256SUMS" "$work\siano.sums"
        $line = Get-Content -LiteralPath "$work\siano.sums" | Where-Object { ($_ -split '\s+')[1] -in $siano, "*$siano" }
        if (-not $line) { throw "SHA256SUMS に $siano が載っていません" }
        Assert-Hash "$work\$siano" (($line -split '\s+')[0])
        Expand-Archive -Force -LiteralPath "$work\$siano" -DestinationPath "$work\new\siano-userland"
        Assert-Hash "$work\new\siano-userland\firmware\isdbt_rio.inp" $IsdbtRioSha256
        # ブラウザで落とした zip を手で渡されたときの「インターネットから来た」印を外す (SmartScreen に止められないように)
        Get-ChildItem -Recurse -File "$work\new" | Unblock-File

        # --- 入れ替える。**揃ってから止める** (取ってこられなかったら、動いているものに触らない) ---
        Stop-Agent
        foreach ($dir in $Prefix, "$DenpaDir\config", "$Media\recorded", "$Media\library") {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        foreach ($part in 'bin', 'siano-userland') {
            if (Test-Path -LiteralPath "$Prefix\$part") { Remove-Item -Recurse -Force -LiteralPath "$Prefix\$part" }
            Move-Item -LiteralPath "$work\new\$part" -Destination "$Prefix\$part"
        }
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }

    # 起こす .cmd。環境変数はコンテナで既定にしている置き場を Windows の置き場に向け直すものだけ (Mac の plist と同じ)。
    # **落ちたら5秒置いて起こし直す** (タスク スケジューラの「失敗したら再起動」は、終了コードでは効かない)。
    # ログはここで足していく。cmd はファイルを OEM の文字コードで読むので、その文字コードで書く (パスに日本語が入りうる)
    $cmd = "$Prefix\denpa-agent.cmd"
    $vars = [ordered]@{
        AGENT_PORT = $Port; TUNERS_FILE = "$DenpaDir\config\tuners.json"; CHANNELS_FILE = "$DenpaDir\config\channels.json"
        SIANO_USERLAND_DIR = "$Prefix\siano-userland"; SIANO_FIRMWARE = "$Prefix\siano-userland\firmware\isdbt_rio.inp"
        RECORDED_DIR = "$Media\recorded"
    }
    $lines = @('@echo off', 'rem Written by install.ps1 (denpa). Re-run the installer instead of editing this file.')
    foreach ($key in $vars.Keys) { $lines += "set `"$key=$(([string]$vars[$key]).Replace('%', '%%'))`"" }
    $lines += ':loop', "`"$Prefix\bin\denpa-agent.exe`" >> `"$($Log.Replace('%', '%%'))`" 2>&1", 'ping -n 6 127.0.0.1 >nul', 'goto loop'
    $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    Write-Text $cmd (($lines -join "`r`n") + "`r`n") $oem

    # ログオンしたら起こす。**窓を出さない** (conhost --headless。コンソールのプログラムは、そのままだと窓が開く)。
    # 自分のアカウントのタスクなので管理者は要らない。時間の上限は外す (既定は 3 日で止められる)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
        -Argument "--headless `"$env:WINDIR\System32\cmd.exe`" /d /c `"$cmd`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'denpa のチューナーエージェント (install.ps1 が入れた)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    Say 'エージェントを起こしました。応答を待ちます'
    for ($i = 0; $i -lt 15; $i++) {
        $tuners = & curl.exe -fs "http://127.0.0.1:$Port/denpa/tuners"
        if ($LASTEXITCODE -eq 0) {
            Write-Host $tuners
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "エージェントが答えません。ログを見てください: $Log"
}

function Invoke-Main {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    if ($Uninstall) {
        # **録画中なら終わるまで待つ** (コンテナは stop_grace_period、エージェントは Stop-Agent)
        if ((Test-Path -LiteralPath "$DenpaDir\compose.yml") -and (Test-Docker -Quiet)) { Invoke-Compose down }
        Stop-Agent
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $Prefix) { Remove-Item -Recurse -Force -LiteralPath $Prefix }
        Say '外しました。残してあるもの (要らなければ手で消してください):'
        Say "  compose と設定とログ $DenpaDir / 録画 $Media / DB は docker volume rm denpa_denpa-data"
        return
    }

    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'x64 の Windows だけです (siano-userland に ARM 用がありません)' }

    $ref = if ($env:DENPA_AGENT_ZIP) { '' } else { Get-Version }
    Install-Agent $ref
    Show-Tuners
    if ($NoDocker) {
        Say "エージェントだけ入れました。denpa の TUNER_AGENT_URL に http://$($env:COMPUTERNAME):$Port を書いてください"
        Say '(LAN から繋ぐなら、Windows ファイアウォールでポート 25252 への受信を許してください)'
        return
    }
    if (-not (Test-Docker)) {
        Say "エージェントは入っています (http://127.0.0.1:$Port)"
        return
    }
    # --- denpa 本体 (Docker)。エージェントと同じ版に。手元の zip を入れたときは main と latest ---
    Start-Denpa $(if ($ref) { $ref } else { 'main' })
}

Invoke-Main
