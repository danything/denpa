# ---------------------------------------------------------------------------
# libwdi の wdi-simple.exe を、決めたタグのソースから x64 でビルドする (Windows のランナーで。pwsh)。
#
#   pwsh scripts/build-wdi-simple.ps1 -Out out\libwdi
#
# wdi-simple は Zadig と同じ libwdi のコマンドライン版で、install.ps1 -WinUsb がチューナーのドライバを WinUSB に
# 替えるのに使う (docs/install-windows.md)。**libwdi のリリースには Zadig しか無い**ので、ここでビルドして
# エージェントの zip に入れる (.github/workflows/release.yml・test.yml)。上流の CI (.github/workflows/vs2022.yml) と
# 同じ手順で、違うのは次の 2 つ。
#   - x64 の Release だけをビルドする
#   - 埋め込むドライバを WinUSB だけにする (libusb-win32 と libusbK のファイルは取ってこない。msvc/config.h の 3 行を書き換える)
#
# 埋め込む WinUSB のファイル (winusbcoinstaller2.dll・WdfCoInstaller01011.dll) は Microsoft の WDK 8.0 の再配布物で、
# 上流の CI・Zadig と同じ MSI から取り出す。取ってくるものはコミットと sha256 で確かめる。
# $Out に置くもの: wdi-simple.exe・COPYING (GPL-3.0)・COPYING-LGPL (LGPL-3.0)・README.txt (出どころ)・
# WDK-License.rtf と WDK-redist.txt (WDK の再配布物の許諾。MSI に入っているもの)
# ---------------------------------------------------------------------------
param([Parameter(Mandatory)][string]$Out)

# libwdi のバージョン (タグ)。**上げたら $LibwdiCommit も、そのタグのコミットに書き換える** (食い違えばここで止まる)
# renovate: datasource=github-releases depName=pbatard/libwdi extractVersion=^v(?<version>.*)$
$LibwdiVersion = '1.5.1'
$LibwdiCommit = '9b23b82a2dd1cbffc16d46c212f92c6bf8c0c602'
# WDK 8.0 の再配布物 (https://go.microsoft.com/fwlink/p/?LinkID=253170 の転送先。libwdi の msvc/config.h が案内しているもの)
$WdkUrl = 'https://download.microsoft.com/download/0/5/F/05FD6919-6250-425B-86ED-9B095E54065A/wdfcoinstaller.msi'
$WdkSha256 = '29314207814ce9d5d73695f7e9239539cf37c79e750b9d5ea5a5ef5487a583d6'

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Invoke-Native([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) "wdi-simple-$([Guid]::NewGuid().ToString('N'))"
$src = Join-Path $work 'libwdi'
New-Item -ItemType Directory -Force -Path $src | Out-Null
try {
    # --- ソース。タグを取ってきて、コミットが決めたものかを確かめる ---
    Invoke-Native 'git init' { git -C $src init -q }
    Invoke-Native 'git fetch' { git -C $src fetch -q --depth 1 https://github.com/pbatard/libwdi.git "refs/tags/v$LibwdiVersion" }
    $commit = (git -C $src rev-parse 'FETCH_HEAD^{commit}').Trim()
    if ($commit -ne $LibwdiCommit) { throw "libwdi v$LibwdiVersion is $commit, expected $LibwdiCommit" }
    Invoke-Native 'git checkout' { git -C $src checkout -q $commit }

    # --- WDK 8.0 の再配布物。MSI は入れずに中身だけを取り出す (msiexec /a) ---
    $msi = Join-Path $work 'wdfcoinstaller.msi'
    Invoke-Native 'download' { curl.exe -fsSL --retry 3 --connect-timeout 20 --max-time 600 -o $msi $WdkUrl }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash.ToLowerInvariant()
    if ($hash -ne $WdkSha256) { throw "wdfcoinstaller.msi is $hash, expected $WdkSha256" }
    $extracted = Join-Path $work 'wdk'
    $msiexec = Start-Process msiexec.exe -ArgumentList '/a', "`"$msi`"", '/qn', "TARGETDIR=`"$extracted`"" -Wait -PassThru
    if ($msiexec.ExitCode -ne 0) { throw "msiexec /a failed (exit $($msiexec.ExitCode))" }
    $wdk = Join-Path $extracted 'Windows Kits\8.0'
    foreach ($file in 'redist\wdf\x64\WdfCoInstaller01011.dll', 'redist\wdf\x64\winusbcoinstaller2.dll') {
        if (-not (Test-Path -LiteralPath (Join-Path $wdk $file))) { throw "$file is not in wdfcoinstaller.msi" }
    }
    foreach ($file in 'redist\wdf\License.rtf', 'redist\wdf\x64\redist.txt') {
        if (-not (Test-Path -LiteralPath (Join-Path $wdk $file))) { throw "$file is not in wdfcoinstaller.msi" }
    }

    # --- msvc/config.h。WDK の場所を書き、libusb-win32 と libusbK の埋め込みを外す。3 行とも当たらなければ止める ---
    $configPath = Join-Path $src 'msvc\config.h'
    $config = [IO.File]::ReadAllText($configPath)
    $edits = @(
        @('#define WDK_DIR "C:/Program Files (x86)/Windows Kits/8.0"', "#define WDK_DIR `"$($wdk.Replace('\', '/'))`""),
        @('#define LIBUSB0_DIR "D:/libusb-win32"', '/* libusb-win32 is not embedded */'),
        @('#define LIBUSBK_DIR "D:/libusbK/bin"', '/* libusbK is not embedded */')
    )
    foreach ($edit in $edits) {
        if (-not $config.Contains($edit[0])) { throw "msvc/config.h has no line: $($edit[0])" }
        $config = $config.Replace($edit[0], $edit[1])
    }
    [IO.File]::WriteAllText($configPath, $config)

    # --- ビルド (Visual Studio の MSBuild。ランナーに入っている) ---
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    if (-not $msbuild) { throw 'MSBuild not found' }
    Invoke-Native 'msbuild' { & $msbuild (Join-Path $src 'libwdi.sln') /m /nologo /v:minimal '/p:Configuration=Release,Platform=x64' }
    $exe = Join-Path $src 'x64\Release\examples\wdi-simple.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw 'wdi-simple.exe was not built' }

    New-Item -ItemType Directory -Force -Path $Out | Out-Null
    Copy-Item -LiteralPath $exe, (Join-Path $src 'COPYING'), (Join-Path $src 'COPYING-LGPL') -Destination $Out
    # 埋め込んだ WDK の再配布物の許諾 (MSI に入っているもの)
    Copy-Item -LiteralPath (Join-Path $wdk 'redist\wdf\License.rtf') -Destination (Join-Path $Out 'WDK-License.rtf')
    Copy-Item -LiteralPath (Join-Path $wdk 'redist\wdf\x64\redist.txt') -Destination (Join-Path $Out 'WDK-redist.txt')
    $readme = @(
        "wdi-simple.exe (libwdi $LibwdiVersion)",
        '',
        'The command line driver installer from libwdi, the library behind Zadig.',
        'denpa uses it to replace the driver of a tuner with WinUSB (install.ps1 -WinUsb).',
        '',
        "Source:  https://github.com/pbatard/libwdi/tree/v$LibwdiVersion (commit $LibwdiCommit)",
        'License: LGPL-3.0-or-later (COPYING-LGPL, COPYING)',
        'Built by https://github.com/danything/denpa/blob/main/scripts/build-wdi-simple.ps1 with Visual Studio (x64, Release).',
        'Changes to the source: msvc/config.h only (the WDK location; libusb-win32 and libusbK are not embedded).',
        '',
        'The executable embeds the WinUSB co-installers (winusbcoinstaller2.dll, WdfCoInstaller01011.dll)',
        'from the Microsoft Windows Driver Kit 8.0 redistributable components (WDK-License.rtf, WDK-redist.txt):',
        "  $WdkUrl",
        "  sha256 $WdkSha256",
        ''
    )
    [IO.File]::WriteAllText((Join-Path $Out 'README.txt'), ($readme -join "`r`n"))

    # --- 起動できることを確かめる。実行ファイルは管理者の権限を求める (マニフェスト) ので、管理者で流す (ランナーは管理者) ---
    $built = Join-Path $Out 'wdi-simple.exe'
    $help = & $built --help | Out-String
    if ($LASTEXITCODE -ne 0 -or $help -notmatch '--vid') { throw "wdi-simple --help failed (exit $LASTEXITCODE): $help" }
    "wdi-simple.exe sha256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $built).Hash.ToLowerInvariant())"
} finally {
    Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}
