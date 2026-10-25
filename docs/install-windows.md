# Windows に入れる

**x64 の Windows なら、PowerShell の1行で denpa ごと立ち上がってブラウザが開きます**
(`install.ps1`)。Windows 用は 1.23.1 からで、
それより前のバージョンは入れられません (install.ps1 がそう言って止まる)。

```powershell
irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex
```

引数を渡すときは `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -Uninstall`
のようにします (`-NoOpen` ブラウザを開かない / `-Uninstall` 止めて外す / `-AgentOnly` エージェントだけ)。

**エージェントは Windows の上でそのまま、denpa 本体は WSL のコンテナ (`wslc`) で動かします。** Docker Desktop は
要りません (wslc は WSL に入っていて、`wsl --update` で使えるようになる)。コンテナには USB を渡せないので、
チューナーとカードに触るエージェントはコンテナに入れられません。

1. **エージェント** — 最新のリリースから取り、タスク スケジューラに「ログオンしたら起こす」
   タスク (`denpa-agent`) を載せます。自分のアカウントのタスクなので管理者は要りません。窓は出さず
   (`conhost --headless`)、落ちたら 5 秒置いて起こし直します (起こすのは `denpa-agent.cmd` の輪。
   タスク スケジューラの「失敗したら再起動」は終了コードでは効かないため)
2. **denpa 本体** — エージェントと同じバージョンのイメージを `wslc pull` し、ログオン時に起こすタスク (`denpa`) を
   載せて、いま1度流します。起こすのは `denpa-start.ps1` (install.ps1 が書く)

`denpa-start.ps1` は**起こすたびに、コンテナを作り直すか決めます。** 実機 (wslc 3.0.1) で確かめた wslc の癖に合わせています。

- **コンテナから Windows のエージェントへは、Hyper-V の Default Switch の IP で届きます。**
  `host.docker.internal` のような名前はありません。その IP は Windows を起こし直すと変わりうるので、
  起こすたびに調べ、`TUNER_AGENT_URL` かバージョンか `denpa.env` (ハッシュをコンテナのラベルに持つ) が変わっていれば
  作り直します (環境変数は作るときに埋め込まれる。DB はボリューム、録画は Windows のフォルダなので消えない)。
  変わっていなければ `wslc start` だけ。`denpa.env` を直したら、install.ps1 を流し直すかログオンし直せば効く
- **自動で起こし直す指定 (`--restart`) がありません。** ログオン時のタスクが代わりに起こします
- **ポートは既定で 127.0.0.1 にしか出ません。** `-p 0.0.0.0:3000:3000` で出して、LAN のほかの機器からも開けるようにします
- **この PC のブラウザから入ると、送信元は `169.254.x.x` に見えます** (wslc がポートを中継するため)。
  LAN のほかの機器は本当の IP のまま届きます。なので `TRUSTED_NETWORKS` の既定に `169.254.0.0/16` を足してあります
- **DB は wslc のボリューム (`denpa-data`) に置きます。** Windows のフォルダ越し (virtiofs) だと SQLite のロックが当てにならないため
- **compose はまだありません** (Microsoft は次の優先課題と言っている)。Windows で動かすコンテナは本体の1つだけなので、`wslc run` で足ります
- 録画中に上げ直すと、`wslc stop` が録画の終わりを待ってから入れ替えます (`--stop-timeout 21900`)

**前のバージョン (Docker Desktop の compose) から上げるとき**は、install.ps1 が `docker compose down` で止め
(録画中なら待つ)、DB を Docker のボリューム `denpa_denpa-data` から wslc のボリュームへ移し、
`compose.yml` を `compose.yml.docker` に退けます。`compose.override.yml` に足していた環境変数は引き継がないので、
`denpa.env` に書き移します (退けたときにそう言う)。このときだけ Docker Desktop を起こしておく必要があります
(移したあとは要りません。Docker のボリュームは消さずに残す)。

- **WSL は勝手に入れません。** wslc が無いときは、エージェントだけ入れて `wsl --update` (WSL が無ければ
  管理者で `wsl --install --no-distribution`) を流すよう言って終わります
- ドライバは入れません (下)。刺さっているチューナーが WinUSB でなければ、そう言います
  (px4-userland の機材は `px4d --list-json` に聞くので、機種の表は持ちません)
- genkan (`http://denpa.localhost`) には繋ぎません (genkan は Docker のネットワークにいて、wslc のコンテナからは入れない)
- エージェントの zip は、出所の証明でも確かめられます ([配布物を確かめる](install.md#配布物を確かめる))

| 置き場                         | 中身                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/denpa/` (`DENPA_HOME`)      | `denpa.env` (コンテナの環境変数。手で足すならここ。無いときだけ雛形を作る)・`config/`・エージェントのログ `denpa-agent.log`                                      |
| `%LOCALAPPDATA%\denpa-agent\`  | エージェント・px4-userland (`px4d.exe`・`px4ctl.exe`・切り出したファームウェア・ライセンスの文書)・siano-userland・起こす `denpa-agent.cmd` と `denpa-start.ps1` |
| `C:\denpa-run`                 | px4d のソケットの置き場 (下)                                                                                                                                     |
| `~/Videos/denpa/recorded`      | 元のTS。エージェントとコンテナ (`/media/raw`) の両方に見せる                                                                                                     |
| `~/Videos/denpa/library`       | 出来上がった録画 (コンテナの `/media/encoded`。エクスプローラーから見える)                                                                                       |
| wslc のボリューム `denpa-data` | DB                                                                                                                                                               |

**使えるもの。**

- **px4-userland の機材** (PX-Q3U4 / PX-M1UR / PX-S1UR など)。px4-userland の Windows 用 (0.2.0 から。
  入れるのは 0.2.1) は、ドライバを WinUSB にすれば動きます。Linux・Mac と同じく px4d の制御ソケットで
  受信機を使い、内蔵カードリーダーも読みます (IPC は Windows でも AF_UNIX)。配布 zip のうち使うのは
  `px4d.exe` と `px4ctl.exe` だけで、`px4-ts.exe` と `WinSCard.dll` (B25 のアプリの横に置く代わりの DLL) は
  置きません — エージェントは USB のリーダーを OS の winscard.dll で読むので、横に置くとそちらを引いてしまう。
  ファームウェアは Mac と同じく PLEX 公式ドライバから切り出します ([tuner-px4.md](tuner-px4.md#ファームウェア))
- **siano-userland の機材** (PX-S1UD など。地上波)。siano-userland の Windows 用 (`siano-ts.exe` と libusb) も、
  ドライバを WinUSB にすれば動きます
- WinUSB には [Zadig](https://zadig.akeo.ie) でします (Options → List All Devices → チューナーを選んで WinUSB → Replace Driver)。
  **PX-Q3U4 / PX-W3U4 は USB の機材が2つ並ぶので、両方とも。** PLEX のドライバで TVTest などから使っていた
  機材は、WinUSB にするとそちらからは見えなくなります (戻すときはデバイス マネージャーでドライバを戻す)。
  installer はドライバを入れ替えません (ほかのソフトで使っていた機材を黙って奪わない)。
  WinUSB でないまま、またはほかのソフトが使っているまま選局すると、開けずに落ち、そう添えて返します
  (Windows の libusb は WinUSB の機材しか開けず、開けるのも1つのプロセスだけ)
- px4 と Siano の機材は同時に挿して使えます (別の USB の機材を別のプロセスが開く)
- **カードリーダー**: USB のリーダーを Windows の PC/SC (winscard.dll) 越しに扱います (`Pcsc.cs`。
  Mac と同じ作りで、違うのはハンドルの幅と関数の名前だけ)。ドライバは Windows 標準で足ります。
  `denpa-agent --card` がリーダーを並べ、動いている間はリーダーを独り占めします。px4-userland の内蔵リーダーも
  並びます (USB のリーダーが先)

**px4-userland の機材で Windows だけ違うところ。**

- **px4d は標準入力で止めます** (`--exit-on-stdin-eof`)。Windows には SIGTERM が無いので、エージェントは px4d の
  標準入力を開けたまま持ち、止めるときに閉じます。px4d は後片付け (LNB を 0V に戻す・ソケットを消す) をしてから
  終わります。エージェントが落ちても書く側が閉じるので、**px4d が USB を持ったまま残りません**
- **ソケットの置き場は `C:\denpa-run`** (`PX4_RUNTIME_DIR`)。px4d は、本人・SYSTEM・Administrators のほかに
  書ける人がいないフォルダしか使わないので、install.ps1 がその ACL で作ります。ユーザーのフォルダの下にしないのは、
  ソケットのパスが UTF-8 で 108 バイトまでで日本語のユーザー名だとすぐ溢れ、非 ASCII のパスだと px4d の ready の行が
  途切れるため ([px4-userland #52](https://github.com/Khronos31/px4-userland/issues/52))。エージェントは px4d を起こす前に
  持ち主・ACL・長さを確かめ、合わなければ理由を言います。**1台の PC でエージェントを動かせるのは1人のユーザーだけ**です
- **px4d が使っている筐体は、一覧で開けない機材 (`open_failed`) に見えます。** エージェントは起こしたときの筐体を
  覚えていて、動いている間は顔ぶれに残します。同じ番号の筐体を `--usb-path` で分けて起こすのは、
  px4-userland も Windows では確かめていません
- USB を抜くと px4d は終わり、次の選局で起こし直します (DISCONNECTED / USB_IO を返したまま動いていたら、エージェントが止める)

機種では絞らず、px4-userland が ready と言った筐体は使います。px4-userland 側で Windows の実機で確かめてあるのは
PX-Q3U4・PX-M1UR・PX-S1UR です ([対応表](https://github.com/Khronos31/px4-userland#対応機種動作環境))。

**使えないもの。**

- **PT2/PT3 などの DVB の機材** — Windows に DVB はありません
- **PX-W3U3 (asicen-userland)** — Windows 用がありません
- **止めるときに録画を待てません。** Windows には「止まれ」を伝える手 (SIGTERM) が無く、
  止めればその場で落ちます。上げ直し・外すときは install.ps1 が録画の終わりを待ってから止めますが、
  ログオフ・再起動・シャットダウンでは待たずに切れます (録画中に Windows を落とさないこと)。
  siano-ts も同じく、止めるときに `quit` を読めなければ Kill になります (USB は OS が閉じる)

**Linux・Mac と違うところ。**

- 子の標準出力は poll できないので、裏のスレッドが読みます (`DeviceStream`)。pipe は 4KB ほどで広げられず、
  読む側が少し止まったぶんは siano-ts の中の溜め (16KB × 256) が吸います。px4d から受ける TS は pipe を使わないので 8MB の溜め
- タスクの優先度は普通にしてあります (既定の「低い」だと、エンコードで CPU が埋まる間 siano-ts や px4d が後回しになる)
- ログは cmd がファイルへ足すだけで、回しません (Mac と同じ)
- LAN のほかの機械からエージェントに繋ぐとき (`-AgentOnly`) は、Windows ファイアウォールでポート 25252 を許します
- **Windows の実機でチューナーとカードを繋いで確かめたことはまだありません。** CI (`agent-windows`・`agent-windows-install`) で
  ビルドして起こし、偽の px4d を相手に IPC と TS の受け渡しを流し、入れ方 (`-AgentOnly`) を最後まで流すところまでです。
  denpa 本体を wslc で起こすところは手元の Windows 11 (wslc 3.0.1) で確かめました (Docker Desktop からの移行は未確認)。
  実機で当てるのは `denpa-agent --tune px4:<筐体の番号>:2 T27` と `denpa-agent --card`
