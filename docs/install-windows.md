# Windows に入れる

**x64 の Windows なら、管理者の PowerShell の 1 行で denpa ごと立ち上がってブラウザが開きます**
(`install.ps1`)。スタートボタンを右クリックして「ターミナル (管理者)」を開き、次を流します。
本体ごと入れられるのは v2.32.0 から (`-AgentOnly` なら v1.23.1 から) で、それより前のバージョンは install.ps1 がそう言って止まります。

```powershell
irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex
```

引数を渡すときは `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -Uninstall`
のようにします (`-NoOpen` ブラウザを開かない / `-Uninstall` 止めて外す / `-AgentOnly` エージェントだけ)。

**Windows 10 1809・Windows Server 2019 (ビルド 17763) 以降で動きます。** 本体の bun が 1809 より前の Windows を受けず、
install.ps1 が使う `curl.exe`・`tar.exe` も 1803 / Server 2019 より前の Windows には無いためです。Windows Server 2016 では install.ps1 が止まります。

**denpa 本体もエージェントも、Windows の上でそのまま動かします。** WSL・Docker Desktop・コンテナは使いません。
本体はリリースに添えた `denpa-<バージョン>-windows-x64.zip` (bun・アプリ・ffmpeg・字・ブラウザへ配るデコーダ) で、
エージェントは `denpa-agent-<バージョン>-windows-x64.zip` (.NET の実行ファイル。[通知領域のアイコン](#通知領域のアイコン)も入っている) です。どちらも同じバージョンを入れます。

1. **エージェント**: タスク スケジューラに「起動したら実行する」タスク (`denpa-agent`) を SYSTEM で載せます。
   タスクが実行するのは `denpa-agent.cmd` のループで、エージェントが落ちたら 5 秒置いて起動し直します
   (タスク スケジューラの「失敗したら再起動」は終了コードでは効かないため)
2. **denpa 本体**: 同じく「起動したら実行する」タスク (`denpa`) を SYSTEM で載せ、`denpa.cmd` のループで `bun server.js` を起動します。
   Windows ファイアウォールに、プライベートとドメインのネットワークからポート 3000 を受ける規則 (`denpa`) を足します

**タスクは SYSTEM で動くので、誰もログインしていなくても録画でき、外から観られます。** そのために管理者で流します
(管理者でなければ、install.ps1 がそう言って止まる)。

2 つが組むときの合言葉 ([agent.md](agent.md)) はエージェント自身の置き場 (`~/denpa/config/tls/pair-token`) に無いときだけ作り、エージェントはそこから読み
(手で `denpa-agent --pair` を流しても同じ URL が出る)、denpa には `TUNER_AGENT_URL` (`https://127.0.0.1:25252#pair=<合言葉>`) で渡します。
上げ直しても変えません。
`-AgentOnly` では、別の機械の denpa の `TUNER_AGENT_URL` に書く `https://<この PC の名前>:25252#pair=<合言葉>` を最後に出します。

- 録画中に上げ直す・外すと、install.ps1 が録画の終わりを待ってから止めます (録画中かは `denpa-agent --status` で確かめる。
  エージェントの API は組んだ denpa にしか応答しないので、エージェント自身の証明書で呼ぶもの)。エンコードの途中なら、次に起きたときにやり直します
- ドライバは入れません (下)。挿さっている px4-userland と siano-userland のチューナーが WinUSB でなければ、そう言います
  (px4-userland の機材は `px4d --list-json` で問い合わせるので、機種の表は持ちません)
- genkan (`http://denpa.localhost`) には繋ぎません。この PC からは <http://localhost:3000>、LAN のほかの機器からは `http://<この PC の名前か IP>:3000` で開きます。
  LAN のほかの機器から開けないときは、Windows の設定でこの PC のネットワークを「プライベート」にします (パブリックのネットワークには開けない)
- 本体とエージェントの zip は、出所の証明でも確かめられます ([配布物を確かめる](install.md#配布物を確かめる))

| 置き場                    | 中身                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%ProgramFiles%\denpa\`   | エージェントと通知領域のアイコン (`bin\`)・px4-userland (`px4d.exe`・`px4ctl.exe`・ライセンスの文書)・siano-userland・本体 (`server\`)・エージェントを起動する `denpa-agent.cmd`                            |
| `%ProgramData%\denpa\`    | DB (`denpa.db`) と、その隣の局ロゴ・鍵 ([config.md](config.md) の `DENPA_DB`)・本体の環境変数 `denpa.env`・本体を起動する `denpa.cmd` (エージェントと組む合言葉が入る)。SYSTEM と管理者だけが読み書きできる |
| `~/denpa/` (`DENPA_HOME`) | エージェントの `config/` (`tls/pair-token` は組むときの合言葉。無いときだけ作る)・ログ (`denpa.log` は本体、`denpa-agent.log` はエージェント)                                                               |
| `C:\denpa-run`            | px4d のソケットの置き場 (下)                                                                                                                                                                                |
| `~/Videos/denpa/recorded` | 元の TS (`RAW_DIR`。エージェントと本体の両方が使う)                                                                                                                                                         |
| `~/Videos/denpa/library`  | 出来上がった録画 (`ENCODED_DIR`。エクスプローラーから見える)                                                                                                                                                |

`%ProgramFiles%\denpa` と `%ProgramData%\denpa` を管理者だけのものにしてあるのは、SYSTEM で動くものと、その環境変数を
ほかの人やほかのプログラムに書き換えさせないためです。ログはふつうのユーザーでも読めるように `~/denpa` に置きます (回さずに足していく)。

## 通知領域のアイコン

**サインインすると、通知領域に denpa のアイコン (`denpa-tray.exe`) が出ます。** install.ps1 が HKLM の Run (`denpa`) に載せるので、
この PC の誰がサインインしても出ます。同じ PC の denpa の `/api/health` を 10 秒ごとに呼び、その答えを出すだけです。

- denpa が答えれば電波塔のアイコン、答えなければ注意のアイコンになります。マウスを重ねると、バージョンと録画・エンコードの本数が出ます
- 右クリックのメニューは「denpa を開く」(アイコンのダブルクリックでも開く)・新しいバージョンがあるときだけの「v2.31.0 に更新…」・「終了」です
- 新しいバージョン (denpa が GitHub の最新のリリースと見比べたもの) が出ると、起動してからそのバージョンにつき 1 回だけ通知を出します (サインインし直すと、また出す)。**更新は勝手には始めません**
- 「終了」で消したアイコンは、次のサインインでまた出ます。`-AgentOnly` では載せません (出すのは本体の様子なので)。外すと Run からも消します

**「v2.31.0 に更新…」を選ぶと、入れたときと同じ install.ps1 の 1 行を管理者の PowerShell で流します** (UAC で許可を求める。ブラウザは開かない)。

- 録画中・エンコード中なら、流す前に確かめます。録画中なら、install.ps1 が録画の終わりを待ってから入れ替えます。
  エンコード中なら中断し、更新のあとで最初からやり直します
- PowerShell の窓に進み具合が出ます。録画を待つ間も、その窓で待ちます。失敗したら、理由を出して Enter を押すまで閉じません
- 入れ替える前に通知領域のアイコンも止め、入れ終えたら起こし直します

## 環境変数を足す (`denpa.env`)

**本体の環境変数は `%ProgramData%\denpa\denpa.env` に `KEY=値` で書きます** (変数の一覧は [config.md](config.md))。
install.ps1 は無いときだけ雛形 (`TZ`・`ENCODE_CONCURRENCY`・`TRUSTED_NETWORKS`) を作り、あとは触りません。
管理者でないと書けないので、メモ帳を「管理者として実行」して開きます。`#` で始まる行は読みません。

- **直したら、install.ps1 を流し直すか、Windows を再起動します。** `denpa.cmd` が本体を起動するたびに読み直すので、
  タスク マネージャーで `bun.exe` を終了しても効きます (録画中は終了しないこと)
- 置き場 (`DENPA_DB`・`RAW_DIR`・`ENCODED_DIR`)・ffmpeg・字とデコーダの置き場・エージェントの宛先 (`TUNER_AGENT_URL`)・`DENPA_VERSION` は
  install.ps1 が `denpa.cmd` で決め、`denpa.env` に書いても効きません
- `TRUSTED_NETWORKS` の雛形は `127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8` です。`127.0.0.0/8` と `::1/128` はこの PC のブラウザです。
  この PC で cloudflared のような前段を動かすときは、前段越しの人もループバックから来たように見えるので、ループバックを外して OIDC を使います
  ([auth.md](auth.md#前段の後ろに置くとき-trusted_proxies))

## スリープ

**録画・ライブ視聴・エンコードの間は、本体が Windows をスリープさせません** (`SetThreadExecutionState`。src/lib/server/power.ts)。
画面は消えてかまいません。録画を始める 5 分前からもスリープさせません。

**次の録画の 3 分前に、スリープから起こします。** 本体がタスク スケジューラに「スリープを解除して実行」のタスク (`denpa-wake`) を
1 つ書き、次の録画が変わるたびに時刻を書き直します (録画が無ければ消す)。中身は何もしないコマンドで、スリープから復帰させるためだけにあります。

- 効くのは、電源オプションの「スリープ解除タイマーの許可」が「有効」のときだけです (コントロール パネルの「電源オプション」→
  「プラン設定の変更」→「詳細な電源設定の変更」→「スリープ」)。ノート PC はバッテリーのときに「無効」や「重要なスリープ解除タイマーのみ」に
  なっていることがあります
- 休止状態とシャットダウンからは起こせません。シャットダウンしたら録画は始まりません
- 録画した番組を観ている間 (ライブでない再生) は、スリープを止めません。電源オプションのスリープまでの時間で眠ることがあります

**外からいつも観るなら、この PC をスリープしない設定にします** (電源オプションの「コンピューターをスリープ状態にする」を「なし」)。
スリープしている PC は外からの要求を受けられないので、観ようとしても繋がりません (Wake-on-LAN で復帰させる仕組みはありません)。

## 前のバージョン (wslc) から上げる

**前のバージョンは denpa 本体を WSL のコンテナ (wslc) で動かしていました。** 上げると install.ps1 が次のことを 1 度だけします。

1. ログオンしたら wslc の本体を起こしていたタスク (`denpa`) を外し、`wslc stop denpa` で止める (録画中なら、コンテナの stop-timeout で終わるまで待つ)
2. wslc のボリューム `denpa-data` の中身 (DB・局ロゴ・鍵) を `%ProgramData%\denpa` に写す。`wslc run … alpine tar` で書き出し、Windows の `tar` で開く
3. コンテナを `wslc rm denpa` で外す。**ボリュームは消さずに残す** (確かめたら `wslc volume rm denpa-data` で消してよい)
4. `~/denpa/denpa.env` を `%ProgramData%\denpa\denpa.env` に写す。`TRUSTED_NETWORKS` の `169.254.0.0/16` (wslc が中継していたこの PC のブラウザ) は
   `127.0.0.0/8,::1/128` に書き換え、前のものは `denpa.env.wslc` に退ける
5. 前の置き場 `%LOCALAPPDATA%\denpa-agent` (エージェントと、wslc の本体を起こしていた `denpa-start.ps1`) を消す

**このときだけ wslc が動いている必要があります** (DB がボリュームの中にあるため)。動かなければ、install.ps1 は何も変えずに止まり、
`wsl --update` を流すよう言います。途中で止まっても、流し直せば続きから進みます (写した DB があれば写し直さない)。
写したあとは WSL は要りません。録画のフォルダ (`~/Videos/denpa`) は同じ場所のまま使います。

## 別の機械へ移す

**別の機械 (Linux の Docker Compose や Kubernetes) へ移すとき**は、設定の「連携」の「denpa を別の機械へ移す」で書き出します。
ブラウザのダウンロードとして落ちてきます。録画のフォルダ (`~/Videos/denpa/library`・`~/Videos/denpa/recorded`) は自分で写します
([migrate.md](migrate.md#別の機械へ移す))。

## 使えるもの

- **px4-userland の対応機種** (PX-Q3U4 / PX-M1UR / PX-S1UR など)。PX-MLT5 系と同じく、エージェントが WinUSB で USB を直に持ちます
  ([tuners.md](tuners.md#px-q3px-w3-系とit930x-のほかの機種))。ドライバを WinUSB にします。エージェントが直に持つ形は、Windows の実機では確かめていません。
  px4-userland の Windows 用 (入れるのは 0.2.1) はまだ置いていますが、px4d はこの機種を挙げず、起動もしません。配布 zip のうち置くのは
  `px4d.exe` と `px4ctl.exe` だけで、`px4-ts.exe` と `WinSCard.dll` (B25 のアプリの横に置く代わりの DLL) は
  置きません。エージェントは USB のリーダーを OS の winscard.dll で読むので、横に置くとそちらが読み込まれてしまいます。
  IT930x のファームウェアは Mac と同じくエージェントに同梱しています ([tuner-px4.md](tuner-px4.md#ファームウェア))
- **siano-userland の機材** (PX-S1UD など。地上波)。siano-userland の Windows 用 (`siano-ts.exe` と libusb) も、
  ドライバを WinUSB にすれば動きます
- **PX-MLT5U / PX-MLT5PE / DTV02A-5TS-P**。エージェントが WinUSB で USB を直に持ちます (px4d は使いません。内蔵カードリーダーも読みます)。
  Zadig で WinUSB を当てます。Windows の実機ではまだ確かめていません ([tuners.md](tuners.md#px-mlt5-系))
- **Sony CECH-ZD1 J** (PS3 の torne。地上波)。エージェントが WinUSB で USB を直に持ちます (外のプログラムは要りません。
  内蔵の差し込み口の B-CAS も読みます)。機材にドライバが無いので、Zadig で `054c:04b2` に WinUSB を当てます。
  当てていないか、ほかのソフトが使っていると「ほかのソフトが使っているか、WinUSB になっていません」と返します。
  device の名前 (`zd1j:2-3.2` など) は、挿したポートから Linux と同じ形に作ります (1 台だけなら挿し替えても付いていく。[tuners.md](tuners.md#sony-cech-zd1-j))。
  Windows の実機ではまだ確かめていません ([tuners.md](tuners.md#sony-cech-zd1-j))
- **PIXELA PIX-DT295** (試験的。地上波・BS・CS)。エージェントが WinUSB で USB を直に持ちます。Zadig で `06b8:103b` に WinUSB を当てます。
  機材のレジスタをエージェントが直に書く方式 (ファームウェアは入れません) は、Windows の実機では確かめていません。エージェントが途中で止まったあとなどは、機材を挿し直してください
  ([tuners.md](tuners.md#pixela-pix-dt295-試験的))
- WinUSB には [Zadig](https://zadig.akeo.ie) でします (Options → List All Devices → チューナーを選んで WinUSB → Replace Driver)。
  **PX-Q3U4 / PX-W3U4 は USB の機材が 2 つ並ぶので、両方とも。** PLEX のドライバで TVTest などから使っていた
  機材は、WinUSB にするとそちらからは見えなくなります (戻すときはデバイス マネージャーでドライバを戻す)。
  installer はドライバを入れ替えません (ほかのソフトで使っていた機材を、知らせずに使えなくしない)。
  WinUSB でないまま、またはほかのソフトが使っているまま選局すると、開けずに落ち、そう添えて返します
  (Windows の libusb は WinUSB の機材しか開けず、開けるのも 1 つのプロセスだけ)
- px4・Siano・PX-MLT5 系・CECH-ZD1 J・PIX-DT295 の機材は同時に挿して使えます (それぞれ別の USB の機材として開く)
- **カードリーダー**: USB のリーダーを Windows の PC/SC (winscard.dll) 越しに扱います (`Pcsc.cs`。
  Mac と同じ作りで、違うのはハンドルの幅と関数の名前だけ)。ドライバは Windows 標準で足ります。
  `denpa-agent --card` がリーダーを並べ、動いている間はリーダーを独り占めします。PX-MLT5 系・px4-userland の対応機種の内蔵リーダーと CECH-ZD1 J の差し込み口も
  並びます (USB のリーダーが先)
- **エンコードは GPU (NVIDIA の NVENC・Intel の QSV・AMD の AMF) があれば使い、無ければソフトウェアで** (SVT-AV1・x264)。起動時の試しのエンコードで決める ([encode.md](encode.md#windows-でエンコードする))
  (使える GPU は設定の「録画」の「エンコード」に出る)。GPU のエンコーダは Windows の実機では確かめていない

**px4-userland の機材で Windows だけ違うところ。** px4-userland が扱う機種はエージェントが直に持つようになったので、いまは px4d を起動しません。下は px4d が筐体を持っていたときの説明で、px4-userland の同梱と一緒に消す予定です。

- **px4d は標準入力で止めます** (`--exit-on-stdin-eof`)。Windows には SIGTERM が無いので、エージェントは px4d の
  標準入力を開けたまま持ち、止めるときに閉じます。px4d は後片付け (LNB を 0V に戻す・ソケットを消す) をしてから
  終わります。エージェントが落ちても書く側が閉じるので、**px4d が USB を持ったまま残りません**
- **ソケットの置き場は `C:\denpa-run`** (`PX4_RUNTIME_DIR`)。px4d は、持ち主が自分で、自分・SYSTEM・Administrators のほかに
  書ける人がいないフォルダしか使いません。エージェント (と、それが起動する px4d) は SYSTEM で動くので、install.ps1 が持ち主を SYSTEM にし、
  SYSTEM と Administrators だけが書ける ACL で作ります。ユーザーのフォルダの下にしないのは、
  ソケットのパスが UTF-8 で 108 バイトまでで日本語のユーザー名だとすぐ溢れ、非 ASCII のパスだと px4d の ready の行が
  途切れるため ([px4-userland #52](https://github.com/Khronos31/px4-userland/issues/52))。エージェントは px4d を起動する前に
  持ち主・ACL・長さを確かめ、合わなければ理由を記録に出します
- **px4d が使っている筐体は、一覧で開けない機材 (`open_failed`) に見えます。** エージェントは起動したときの筐体を
  控えていて、動いている間は顔ぶれに残します。同じ番号の筐体を `--usb-path` で分けて起動するのは、
  px4-userland も Windows では確かめていません
- USB を抜くと px4d は終わり、次の選局で起動し直します (DISCONNECTED / USB_IO を返したまま動いていたら、エージェントが止める)

機種では絞らず、px4-userland が ready を返した筐体は使います。px4-userland 側で Windows の実機で確かめてあるのは
PX-Q3U4・PX-M1UR・PX-S1UR です ([対応表](https://github.com/Khronos31/px4-userland#対応機種動作環境))。

## 使えないもの

- PT2/PT3 などの DVB の機材は使えません。Windows に DVB はありません
- PX-W3U3 (asicen-userland) は使えません。Windows 用がありません
- **止めるときに録画を待てません。** Windows にはプロセスに「止まれ」を伝える手 (SIGTERM) が無く、
  止めればその場で落ちます。上げ直し・外すときは install.ps1 が録画の終わりを待ってから止めますが、
  再起動・シャットダウンでは待たずに切れます (録画中に Windows を落とさないこと)。
  siano-ts も同じく、止めるときに `quit` を読めなければ Kill になります (USB は OS が閉じる)

## Linux・Mac と違うところ

- 子の標準出力は poll できないので、裏のスレッドが読みます (`DeviceStream`)。pipe は 4KB ほどで広げられず、
  読む側が少し止まったぶんは siano-ts の中のバッファ (16KB × 256) が吸収します。px4d から受ける TS は pipe を使わないので 8MB のバッファ
- エージェントのタスクの優先度は普通にしてあります (既定の「低い」だと、エンコードで CPU が埋まる間 siano-ts や px4d が後回しになる)。
  エンコードの ffmpeg は、本体が自分でいちばん低い優先度にします
- エージェントは全部のインターフェースで待ち受けます (`-AgentOnly` で別の機械の denpa から繋ぐため)。同じ PC の本体は 127.0.0.1 で繋ぎます。
  LAN から届かないようにするのは Windows ファイアウォールの役目です (25252 の受信を許さないままにする)。LAN のほかの機械からエージェントに繋ぐとき
  (`-AgentOnly`) は、ファイアウォールでポート 25252 を許します。エージェントが応答するのは合言葉で組んだ denpa だけです ([agent.md](agent.md))
- ffmpeg の 4 本目の出口 (録画のエンコードの進み具合・ライブの字幕) は、名前付きパイプ (`\\.\pipe\denpa-…`) で受けます。ffmpeg には `-y` を付けます (付けないと出口があるかを確かめる `access` が 1 本目の接続になり、本物の書き込みが開けません)。
  Linux・Mac は fd 3 (`pipe:3`) ですが、Windows の bun は 4 本目のパイプを開けても読めないためです (`stream.sideOutput`)
- エンコードの進み具合は、エンコードできたコマ数から出します。Linux のように ffmpeg の読み位置 (`/proc`) は読めないので、
  尺が測れなかった録画は割合が動きません (出来上がりは変わらない)

## 確かめたこと

- **CI** (test.yml の `server-windows`・`agent-windows`・`agent-windows-install`): 配布物の ffmpeg で denpa が使う経路を流し、
  進み具合を名前付きパイプ (`stream.sideOutput`) で受け、`SetThreadExecutionState` が `powercfg /requests` に出ることを見る。本体を `bun server.js` で起こして
  画面・字・デコーダが返ることを見る。install.ps1 で本体ごと入れて SYSTEM のタスクで動き、本体がエージェントと組むところまで。
  wslc からの移行は偽の wslc で流す (`tests/install-windows-migrate.ps1`)。通知領域のアイコンは、組んで起動して落ちないこと・二重に起動するとすぐ終わること・
  Run に載ること・上げ直すと動いているものを止めること・外すと消えることまで
- **Windows の実機で確かめたことのあるチューナーは、以前の方式 (ファームウェアを入れる方式) の PIX-DT295 だけで、いまの方式では確かめていません。** ほかのチューナーとカードは、CI で
  ビルドして起動し、偽の px4d を相手に IPC と TS の受け渡しを流すところまでです
- **まだ確かめていないこと**: SYSTEM で動くエージェントから WinUSB の機材とカードリーダー (PC/SC) を使えるか、スリープから復帰させるタスクで
  録画が始まるか、wslc の本体からの移行 (実機の wslc で)、通知領域のアイコンの見た目とメニュー・通知と、そこから UAC を通して更新する流れ。実機で当てるのは `denpa-agent --tune px4:<筐体の番号>:2 T27` と `denpa-agent --card`
  (管理者の PowerShell で、エージェントのタスクを止めてから)
