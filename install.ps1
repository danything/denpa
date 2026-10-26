# ---------------------------------------------------------------------------
# denpa を Windows (x64) に立てる。**PowerShell の1行で、ブラウザが開くところまで。**
#
#   irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -Uninstall
#       引数を渡すときはこの書き方。-NoOpen (ブラウザを開かない) / -Uninstall (止めて外す。~/denpa・録画・DB は残す) /
#       -AgentOnly (エージェントだけ。denpa 本体は別の Linux で動かす)
#
# **エージェントは Windows の上でそのまま動かし** (タスク スケジューラでログオン時に起こす)、**denpa 本体は
# WSL のコンテナ (wslc) で動かす。** Docker Desktop は要らない (WSL に入っているので `wsl --update` だけで使える)。
# コンテナには USB を渡せないので、チューナーとカードに触るエージェントはコンテナに入れられない。
# **Windows で使えるチューナーは px4-userland の機材 (PX-Q3U4 など) と siano-userland の機材 (PX-S1UD など) と Sony CECH-ZD1 J**
# (DVB は無い)。ドライバを WinUSB にするのは人の手で (Zadig。docs/install-windows.md)。
#
# **WSL は勝手に入れない。** wslc が無いときはエージェントだけ入れて、入れ方を言って終わる。
# もう一度流せば上げ直し。イメージは**エージェントと同じリリースのバージョン**に揃える。
#
# 置き場:
#   ~/denpa (DENPA_HOME)                  denpa.env (コンテナの環境変数。無いときだけ雛形を作り、あれば触らない)・
#                                         config/・denpa-agent.log
#   %LOCALAPPDATA%\denpa-agent\           エージェント・px4-userland (px4d.exe・px4ctl.exe・切り出したファームウェア)・
#                                         siano-userland・起こす .cmd と denpa-start.ps1
#   C:\denpa-run                          px4d のソケットの置き場 (本人だけが書ける。px4d がそう決めている)
#   ~/Videos/denpa/{recorded,library}     元のTS (エージェントとコンテナの両方が見る) と出来上がった録画
#   wslc のボリューム denpa-data          DB (Windows のフォルダ越しだと SQLite のロックが当てにならない)
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、DENPA_HOME、
# DENPA_AGENT_ZIP (手元でビルドしたエージェントの zip を絶対パスで。CI と開発用)
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
# IT930x のファームウェアは PLEX 公式ドライバから切り出す。3つのハッシュは agent/Dockerfile・install.sh と同じ
$PlexDriverSha256 = 'bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200'
$Pxw3u4SysSha256 = '8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722'
$It930xFirmwareSha256 = '5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484'
# 配布 zip から取り出すもの。**使うのは px4d.exe と px4ctl.exe だけ** (受信機もカードも px4d の制御ソケットで直に話す)。
# px4-ts.exe と WinSCard.dll (B25 のアプリの横に置く代わりの DLL) は置かない。残りはライセンスの文書
$Px4Keep = @('px4d.exe', 'px4ctl.exe', 'LICENSE', 'DEPENDENCY-NOTICE.txt', 'THIRD_PARTY_NOTICES.md', 'libusb/*', 'toolchain/*')

$Repo = 'danything/denpa'
$Url = 'http://localhost:3000'
$DenpaDir = if ($env:DENPA_HOME) { $env:DENPA_HOME } else { Join-Path $env:USERPROFILE 'denpa' }
$Prefix = Join-Path $env:LOCALAPPDATA 'denpa-agent'
# px4d のソケットの置き場。**ユーザーのフォルダの下にしない** — ソケットのパスは UTF-8 で 108 バイトまでで、
# 日本語のユーザー名だとすぐ溢れる。非 ASCII のパスだと px4d の ready の行も途切れる (px4-userland #52)
$Px4Runtime = 'C:\denpa-run'
$Media = Join-Path $env:USERPROFILE 'Videos\denpa'
$Log = Join-Path $DenpaDir 'denpa-agent.log'
$TaskName = 'denpa-agent'
$DenpaTask = 'denpa'
$Container = 'denpa'
$Volume = 'denpa-data'
$Port = 25252
$WslHelp = 'WSL を新しくしてください (PowerShell で wsl --update。WSL が無ければ管理者の PowerShell で wsl --install --no-distribution)。そのあと、もう一度流してください'

function Say([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# 取ってくる。PowerShell 5.1 の Invoke-WebRequest は遅い (進み具合の表示) ので、Windows 10 から入っている curl.exe で
function Get-Url([string]$From, [string]$To) {
    & curl.exe -fsSL --retry 3 -o $To $From
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードできません: $From" }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected.ToUpperInvariant()) {
        throw "$Path のハッシュが合いません (ダウンロード中に壊れた可能性があります。もう一度流してください)"
    }
}

# 入れるバージョン。API を使わず、latest の転送先からタグを読む (install.sh と同じ)
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
# 起こした conhost・.cmd・エージェント・siano-ts・px4d を、コマンドラインに置き場が入っているもので見つけて落とす
# (タスクを止めても、.cmd の下で起きたものまでは止まらない)。**px4d は先に落とさない** — エージェントが
# 終われば px4d は標準入力が閉じたのを見て、後片付け (LNB を 0V に戻す・ソケットを消す) をして自分で終わる。
# 10 秒待っても残っていれば落とす
function Stop-Agent {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return }
    if (Test-Recording) {
        Say '録画中です。終わるまでここで待ちます (Windows では録画の途中で止めると、その録画は切れます)'
        while (Test-Recording) { Start-Sleep -Seconds 10 }
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) {
        $left = @(Get-CimInstance Win32_Process | Where-Object {
                $_.Name -in 'conhost.exe', 'cmd.exe', 'denpa-agent.exe', 'siano-ts.exe', 'px4d.exe', 'px4ctl.exe' -and $_.CommandLine -and
                $_.CommandLine.IndexOf("$Prefix\", [StringComparison]::OrdinalIgnoreCase) -ge 0
            })
        if ($left.Count -eq 0) { return }
        $left | Where-Object { $i -ge 10 -or $_.Name -ne 'px4d.exe' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    throw "エージェントが止まりません ($Prefix の下のプロセスをタスク マネージャーで止めてから、もう一度流してください)"
}

# **stderr を捨てる外のコマンドの前に。** PowerShell 5.1 は、止める設定 (Stop) のまま 2>$null すると
# stderr の1行目で止まる。呼んだ関数の中だけ Continue にする (Set-Variable -Scope 1)
function Use-Continue { Set-Variable -Scope 1 -Name ErrorActionPreference -Value Continue }

# wslc (WSL のコンテナ) が使えるか。駄目なら理由と入れ方を言って $false (-Quiet なら黙って)
function Test-Wslc([switch]$Quiet) {
    Use-Continue
    $why = $null
    if (-not (Get-Command wslc -ErrorAction SilentlyContinue)) {
        $why = "wslc が見当たりません。$WslHelp"
    } else {
        & wslc info *> $null
        if ($LASTEXITCODE -ne 0) { $why = "wslc が動きません (wslc info)。$WslHelp" }
    }
    if ($why -and -not $Quiet) { Say $why }
    return -not $why
}

function Test-Health {
    & curl.exe -fs -o NUL "$Url/api/health"
    return $LASTEXITCODE -eq 0
}

# **前のバージョンは Docker Desktop の compose で動いていた。** DB (Docker のボリューム) を wslc のボリュームへ移して、
# compose.yml を退ける。1度だけ (退けたあとはここに来ない)。録画中なら compose down が終わるまで待つ
function Move-FromDocker {
    Use-Continue
    $compose = Join-Path $DenpaDir 'compose.yml'
    if (-not (Test-Path -LiteralPath $compose)) { return }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "前のバージョンは Docker Desktop で動いていました。DB を移すので、一度 Docker Desktop を起こしてから流し直してください (移したあとは Docker Desktop は要りません)"
    }
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw '前のバージョンの DB を移すので、Docker Desktop を起こしてから流し直してください' }
    Say 'Docker Desktop の denpa を止めて、DB を wslc へ移します (録画中なら終わるまで待ちます)'
    Push-Location $DenpaDir
    try {
        & docker compose down
        if ($LASTEXITCODE -ne 0) { throw 'docker compose down に失敗しました' }
    } finally {
        Pop-Location
    }
    $work = Join-Path ([IO.Path]::GetTempPath()) "denpa-move-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
        & docker run --rm -v denpa_denpa-data:/d -v "${work}:/o" alpine tar -C /d -cf /o/data.tar .
        if ($LASTEXITCODE -ne 0) { throw 'Docker のボリューム denpa_denpa-data を読めません' }
        & wslc volume create $Volume *> $null
        & wslc run --rm -v "${Volume}:/d" -v "${work}:/o" alpine tar -C /d -xf /o/data.tar
        if ($LASTEXITCODE -ne 0) { throw "wslc のボリューム $Volume に書けません" }
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }
    foreach ($name in 'compose.yml', 'compose.override.yml', '.compose.yml.orig') {
        $path = Join-Path $DenpaDir $name
        if (Test-Path -LiteralPath $path) { Move-Item -Force -LiteralPath $path -Destination "$path.docker" }
    }
    Say "移しました。Docker のボリューム denpa_denpa-data と compose.yml.docker は残してあります (要らなければ消してください)"
    if (Test-Path -LiteralPath (Join-Path $DenpaDir 'compose.override.yml.docker')) {
        Say "compose.override.yml は compose.override.yml.docker に退けました。足していた環境変数 (TRUSTED_NETWORKS など) は $DenpaDir\denpa.env に書き移してから、もう一度流してください"
    }
}

# 起こすスクリプト。**起こすたびに作り直すかを決める**: コンテナから Windows のエージェントへは
# Hyper-V の Default Switch の IP で届くが (host.docker.internal は無い)、その IP は再起動で変わりうる。
# 宛先かバージョンか denpa.env が変わっていればコンテナを作り直す (環境変数は作るときに埋め込まれる。
# DB はボリューム、録画は Windows のフォルダなので消えない)。
# wslc には restart の指定が無いので、ログオン時のタスクがこれを流す。
# **ポートは 0.0.0.0 に出す** (既定は 127.0.0.1 だけで、LAN のほかの機器から開けない)
function Write-StartScript([string]$Image) {
    $start = Join-Path $Prefix 'denpa-start.ps1'
    $body = @'
# Written by install.ps1 (denpa). Re-run the installer instead of editing this file.
$ErrorActionPreference = 'Continue'
$image = '__IMAGE__'
$envFile = '__ENVFILE__'
$raw = '__RAW__'
$encoded = '__ENCODED__'
$ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'vEthernet (Default Switch)' -ErrorAction SilentlyContinue).IPAddress | Select-Object -First 1
if (-not $ip) { $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -like 'vEthernet*' | Select-Object -First 1).IPAddress }
$agent = "http://${ip}:__PORT__"
# Env vars are baked in at creation, so a changed denpa.env also means recreating
$envHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $envFile).Hash
$info = & wslc inspect __NAME__ 2>$null | Out-String
if ($LASTEXITCODE -eq 0 -and $info.Trim()) {
    $c = @(ConvertFrom-Json $info)[0]
    if ($c.Config.Image -eq $image -and $c.Config.Env -contains "TUNER_AGENT_URL=$agent" -and $c.Config.Labels.'denpa.env' -eq $envHash) {
        & wslc start __NAME__ | Out-Null
        exit 0
    }
    # Waits for recordings (stop-timeout) before replacing the container
    & wslc stop __NAME__ | Out-Null
    & wslc rm __NAME__ | Out-Null
}
& wslc run -d --name __NAME__ --stop-timeout 21900 -p 0.0.0.0:3000:3000 --env-file $envFile -l "denpa.env=$envHash" `
    -e "TUNER_AGENT_URL=$agent" -v '__VOLUME__:/data' -v "${raw}:/media/raw" -v "${encoded}:/media/encoded" $image | Out-Null
exit $LASTEXITCODE
'@
    $body = $body.Replace('__IMAGE__', $Image).Replace('__ENVFILE__', (Join-Path $DenpaDir 'denpa.env')).
        Replace('__RAW__', "$Media\recorded").Replace('__ENCODED__', "$Media\library").
        Replace('__PORT__', [string]$Port).Replace('__NAME__', $Container).Replace('__VOLUME__', $Volume)
    # 5.1 は BOM の無い .ps1 を ANSI で読む。パスに日本語が入りうるので BOM を付ける
    Write-Text $start $body (New-Object Text.UTF8Encoding $true)
    return $start
}

# denpa 本体を wslc で起こす。エージェントと同じバージョンのイメージ (x.y.z のときだけ。コミットなら latest)
function Start-Denpa([string]$Ref, [switch]$NoOpen) {
    $version = $Ref -replace '^v', ''
    $tag = if ($version -match '^\d+\.\d+\.\d+$') { $version } else { 'latest' }
    $image = "ghcr.io/$Repo`:$tag"
    Move-FromDocker

    # コンテナの環境変数。**手で書き足すのはここ** (上げ直しても触らない)
    $envFile = Join-Path $DenpaDir 'denpa.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        # 最後も改行で終える (行を書き足したときに、前の行にくっつかないように)
        Write-Text $envFile ((@(
                '# denpa (wslc のコンテナ) の環境変数。install.ps1 は無いときだけ作り、あとは触らない',
                'TZ=Asia/Tokyo',
                'ENCODE_CONCURRENCY=2',
                '# 誰を通すか (docs/auth.md)。169.254.0.0/16 はこの PC のブラウザ (wslc はポートを中継するので、',
                '# localhost から入るとこう見える)。LAN のほかの機器は本当の IP のまま届く',
                'TRUSTED_NETWORKS=169.254.0.0/16,192.168.0.0/16,10.0.0.0/8'
            ) -join "`n") + "`n")
    }

    Say "denpa $Ref を wslc で起こします ($image)"
    Use-Continue
    & wslc pull $image
    if ($LASTEXITCODE -ne 0) { throw "イメージを取れません: $image" }
    & wslc volume create $Volume *> $null
    $start = Write-StartScript $image

    # ログオンしたら起こす (エージェントと同じく、自分のアカウントのタスク。窓は出さない)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $DenpaTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'denpa 本体 (wslc のコンテナ。install.ps1 が入れた)' -Force | Out-Null

    # いま起こす (録画中に上げ直すと、録画が終わるまで待ってから入れ替わる)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $start
    if ($LASTEXITCODE -ne 0) { throw "denpa を起こせません。wslc logs $Container を見てください" }

    Say 'denpa の応答を待ちます'
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Health) {
            Say "起動しました: $Url (LAN のほかの機器からは http://$($env:COMPUTERNAME):3000)"
            if (-not $NoOpen) { Start-Process $Url }
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "denpa が応答しません。wslc logs $Container を見てください"
}

# Siano のチューナーが刺さっていれば、ドライバが WinUSB かを見る (入れ替えは人の手で。Zadig)
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

# zip を開く (PowerShell 5.1 でも。中身を1つずつ取り出すのに使う)
function Open-Zip([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    return [IO.Compression.ZipFile]::OpenRead($Path)
}

# px4-userland (PX-Q3U4 など) を $To に置く。**要るものだけ取り出す** ($Px4Keep)。
# ファームウェアは Mac と同じく PLEX 公式ドライバから切り出す (再配布の許諾は誰も持っていない。docs/tuner-px4.md)
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

    Say 'IT930x のファームウェアを PLEX のドライバから切り出します'
    Get-Url 'https://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip' "$Work\plex.zip"
    Assert-Hash "$Work\plex.zip" $PlexDriverSha256
    $zip = Open-Zip "$Work\plex.zip"
    try {
        $entry = $zip.GetEntry('pxw3u4_BDA_ver1x64/PXW3U4.sys')
        if (-not $entry) { throw 'PLEX のドライバに PXW3U4.sys が見当たりません' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "$Work\PXW3U4.sys", $true)
    } finally {
        $zip.Dispose()
    }
    Assert-Hash "$Work\PXW3U4.sys" $Pxw3u4SysSha256
    $sys = [IO.File]::ReadAllBytes("$Work\PXW3U4.sys")
    $firmware = New-Object byte[] 2169
    [Array]::Copy($sys, 0x287d0, $firmware, 0, 2169)
    New-Item -ItemType Directory -Force -Path "$To\firmware" | Out-Null
    [IO.File]::WriteAllBytes("$To\firmware\it930x-firmware.bin", $firmware)
    Assert-Hash "$To\firmware\it930x-firmware.bin" $It930xFirmwareSha256
    Remove-Item -Force -LiteralPath "$Work\plex.zip", "$Work\PXW3U4.sys"
}

# px4d のソケットの置き場を作って整える。**持ち主は本人、書けるのは本人・SYSTEM・Administrators だけ**
# (保護された DACL。親の C:\ から引き継ぐと Authenticated Users も書けてしまい、px4d が使ってくれない)
function Set-Px4Runtime {
    if (-not (Test-Path -LiteralPath $Px4Runtime)) { New-Item -ItemType Directory -Path $Px4Runtime | Out-Null }
    # C:\ の直下はほかのユーザーも作れる。リンク (junction など) なら、リンク先の持ち主と権限を書き換えてしまうので止める
    if ((Get-Item -LiteralPath $Px4Runtime -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Px4Runtime がリンクになっています。中身を確かめて消してから、もう一度流してください"
    }
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($me)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $me, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    # Set-Acl は SACL まで書きにいって、2回目から SeSecurityPrivilege が要ると断られる。持ち主と DACL だけを書く
    # (PowerShell 5.1 は DirectoryInfo のメソッド、7 は拡張メソッド)
    $info = Get-Item -LiteralPath $Px4Runtime
    try {
        if ($info.PSObject.Methods['SetAccessControl']) { $info.SetAccessControl($acl) }
        else { [IO.FileSystemAclExtensions]::SetAccessControl($info, $acl) }
    } catch {
        throw "$Px4Runtime の持ち主と権限を整えられません。ほかのユーザーが作ったものなら、管理者で消してから流し直してください ($($_.Exception.Message))"
    }
}

# px4-userland のチューナーが WinUSB で使えるかを、px4d に聞いて言う (機種の表は持たない)。
# **エージェントを止めている間に** — px4d が使っている機材は開けず、一覧に出ない
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
            '(PX-Q3U4 / PX-W3U4 は USB の機材が2つ並ぶので両方。PLEX のドライバで TVTest などから使っていたなら、そちらからは見えなくなります。docs/install-windows.md)')
    }
    if ($enclosures.Count -eq 0 -and $devices.Count -eq 0) {
        Say 'px4-userland のチューナー (PX-Q3U4 など) は見当たりません。挿したら、Zadig でドライバを WinUSB にしてください (docs/install-windows.md)'
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
                throw "$Ref には Windows 用のエージェントがありません。Windows 用は v1.23.1 からなので、それより前のバージョンは Windows に入れられません"
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

        # --- px4-userland (PX-Q3U4 など) ---
        Get-Px4Userland $work "$work\new\px4-userland"
        # ブラウザで落とした zip を手で渡されたときの「インターネットから来た」印を外す (SmartScreen に止められないように)
        Get-ChildItem -Recurse -File "$work\new" | Unblock-File

        # --- 入れ替える。**揃ってから止める** (取ってこられなかったら、動いているものに触らない) ---
        Stop-Agent
        foreach ($dir in $Prefix, "$DenpaDir\config", "$Media\recorded", "$Media\library") {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        foreach ($part in 'bin', 'px4-userland', 'siano-userland') {
            if (Test-Path -LiteralPath "$Prefix\$part") { Remove-Item -Recurse -Force -LiteralPath "$Prefix\$part" }
            Move-Item -LiteralPath "$work\new\$part" -Destination "$Prefix\$part"
        }
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }

    # px4d のソケットの置き場 (エージェントが止まっている間に。持ち主と権限を整える)
    Set-Px4Runtime
    Show-Px4

    # 起こす .cmd。環境変数はコンテナで既定にしている置き場を Windows の置き場に向け直すものだけ (Mac の plist と同じ)。
    # **落ちたら5秒置いて起こし直す** (タスク スケジューラの「失敗したら再起動」は、終了コードでは効かない)。
    # ログはここで足していく。**パスに日本語が入りうる**ので、1行目で cmd の文字コードを UTF-8 にしてから読ませる
    # (そのままだとコンソールの文字コードで読み、それはユーザーの設定次第で決め打てない)
    $cmd = "$Prefix\denpa-agent.cmd"
    $vars = [ordered]@{
        AGENT_PORT = $Port; TUNERS_FILE = "$DenpaDir\config\tuners.json"; CHANNELS_FILE = "$DenpaDir\config\channels.json"
        SIANO_USERLAND_DIR = "$Prefix\siano-userland"; SIANO_FIRMWARE = "$Prefix\siano-userland\firmware\isdbt_rio.inp"
        PX4_USERLAND_DIR = "$Prefix\px4-userland"; PX4_FIRMWARE = "$Prefix\px4-userland\firmware\it930x-firmware.bin"
        PX4_RUNTIME_DIR = $Px4Runtime
        RAW_DIR = "$Media\recorded"
    }
    $lines = @('@chcp 65001 >nul', '@echo off', 'rem Written by install.ps1 (denpa). Re-run the installer instead of editing this file.')
    foreach ($key in $vars.Keys) { $lines += "set `"$key=$(([string]$vars[$key]).Replace('%', '%%'))`"" }
    $lines += ':loop', "`"$Prefix\bin\denpa-agent.exe`" >> `"$($Log.Replace('%', '%%'))`" 2>&1", 'ping -n 6 127.0.0.1 >nul', 'goto loop'
    Write-Text $cmd (($lines -join "`r`n") + "`r`n")

    # ログオンしたら起こす。**窓を出さない** (conhost --headless。コンソールのプログラムは、そのままだと窓が開く)。
    # 自分のアカウントのタスクなので管理者は要らない。時間の上限は外す (既定は 3 日で止められる)。
    # **優先度は普通 (4) に。** 既定の 7 だと CPU も I/O も後回しにされ、denpa のコンテナがエンコードで CPU を
    # 食っている間に siano-ts が USB を読みに行けず TS を落としうる (Mac の ProcessType Interactive と同じ理由)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
        -Argument "--headless `"$env:WINDIR\System32\cmd.exe`" /d /c `"$cmd`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $settings.Priority = 4
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'denpa のチューナーエージェント (install.ps1 が入れた)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    Say 'エージェントを起動しました。応答を待ちます'
    for ($i = 0; $i -lt 15; $i++) {
        $tuners = & curl.exe -fs "http://127.0.0.1:$Port/denpa/tuners"
        if ($LASTEXITCODE -eq 0) {
            Write-Host $tuners
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "エージェントが応答しません。ログを見てください: $Log"
}

function Invoke-Main([switch]$NoOpen, [switch]$Uninstall, [switch]$AgentOnly) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    if ($Uninstall) {
        # **録画中なら終わるまで待つ** (コンテナは stop-timeout、エージェントは Stop-Agent)
        Unregister-ScheduledTask -TaskName $DenpaTask -Confirm:$false -ErrorAction SilentlyContinue
        if (Test-Wslc -Quiet) {
            Use-Continue
            & wslc stop $Container *> $null
            & wslc rm $Container *> $null
            $ErrorActionPreference = 'Stop'
        }
        Stop-Agent
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $Prefix) { Remove-Item -Recurse -Force -LiteralPath $Prefix }
        if (Test-Path -LiteralPath $Px4Runtime) {
            $runtime = Get-Item -LiteralPath $Px4Runtime -Force
            # リンクならリンクだけを消す (中までたどって、リンク先を消さない)
            if ($runtime.Attributes -band [IO.FileAttributes]::ReparsePoint) { $runtime.Delete() }
            else { Remove-Item -Recurse -Force -LiteralPath $Px4Runtime }
        }
        Say '外しました。残してあるもの (要らなければ手で消してください):'
        Say "  設定とログ $DenpaDir / 録画 $Media / DB は wslc volume rm $Volume"
        return
    }

    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw '対応しているのは x64 の Windows だけです (px4-userland / siano-userland に ARM 用がありません)' }

    $ref = if ($env:DENPA_AGENT_ZIP) { '' } else { Get-Version }
    Install-Agent $ref
    Show-Tuner
    if ($AgentOnly) {
        Say "エージェントだけ入れました。denpa の TUNER_AGENT_URL に http://$($env:COMPUTERNAME):$Port を書いてください"
        Say "(LAN から繋ぐなら、Windows ファイアウォールでポート $Port への受信を許してください)"
        return
    }
    if (-not (Test-Wslc)) {
        Say "エージェントは入っています (http://127.0.0.1:$Port)"
        return
    }
    # --- denpa 本体 (wslc)。エージェントと同じバージョンに。手元の zip を入れたときは latest ---
    Start-Denpa $(if ($ref) { $ref } else { 'main' }) -NoOpen:$NoOpen
}

Invoke-Main -NoOpen:$NoOpen -Uninstall:$Uninstall -AgentOnly:$AgentOnly
