# PX-Q3U4・PX-W3U4・PX-MLT (px4-userland)

PLEX の PX-Q3U4・PX-W3U4・PX-MLT 系などの USB / PCIe チューナーです。**同時に取れるチャンネルは受信機の数だけ**で、
数と種別 (地上波・衛星・両方) は筐体ごとに px4-userland に聞いて決めます (Q3U4 は受信機ごとに地上波か衛星か決まっていて、MLT5 系はどれも両方)。
**内蔵のカードリーダーがある機種は、それも使えます。** Linux・Mac (Apple Silicon)・Windows (x64) で使えます。

チューナーの一覧は [tuners.md](tuners.md)、Windows で使うときは [install-windows.md](install-windows.md)。エージェントの中でどう扱っているかは [agent.md](agent.md#px4-userland-の作り)。

[px4-userland](https://github.com/Khronos31/px4-userland) を**エージェントのイメージに同梱**しています
(`agent/Dockerfile`)。libusb だけで USB を扱うユーザー空間のドライバで、`/dev/bus/usb` が見えれば動き、
ホストに `px4_drv` (DKMS) もカーネルモジュールも要りません (`px4_drv` の `/dev/px4video*` には対応していません)。
ファームウェアはイメージに入れず、初めて使うときにエージェントが取ってきます ([ファームウェア](#ファームウェア))。

## 対応機種

PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系など (USB・PCIe)。px4-userland の対応機種ならそのまま使います ([一覧](https://github.com/Khronos31/px4-userland#対応機種動作環境))。

## 設定

- **設定の `device` は `px4:<筐体の番号>:<受信機>`。** 挿さっていれば
  一覧から組み立てるので (`Px4Userland.Detect`)、普通は書きません。
  `status=ready` 以外の筐体と、まとめられなかった USB デバイス (`--list-json` の
  `ungrouped_usb_devices`) は、理由と USB の場所を記録して使いません
  (`open_failed` なら `/dev/bus/usb` を開く権限を疑う)。番号の桁数や受信機の上限は
  見ず、合わなければ `px4d` が理由を付けて断ります。
  古い `q3u4:<14桁>:<受信機>` は「知らないデバイス」として断るので、書いてあれば
  `px4:` に書き直してください (番号と受信機はそのまま)
- **番号が重なる筐体 (`serial_unique=false`) は、USB ポートで見分けます。** PX-M1UR と PX-S1UR は
  どれも USB の serial が `000000000000001` で、0.1.9 からは同時に挿すと別々の ready な
  筐体として並びます (0.1.8 までは1つの `duplicate`)。番号のままだと同じ
  `px4:000000000000001:0` が2つでき、`px4d --device` も番号だけでは1台に決められず断ります。
  そこで名前を番号と USB ポートにし (`px4:000000000000001_1-2.3:0`)、`px4d` を
  `--device <番号> --usb-path <USBポート> --instance <名前>` で起こし、`px4ctl` やソケットも
  その名前で呼びます (SPEC 4.1)。**挿すポートを変えると別のチューナーになります**
  (px4-userland も「抜き差し後の物理個体は保証しない」と言っています)

## 衛星の LNB 給電

- **15V は2段階で許可します。** `px4d` には `--allow-lnb-power` を渡し、実際に要求するのは
  設定に `lnb: 15v` と書いたチューナーだけ (TUNE の `lnb_voltage` = 15)。`11v` は
  px4-userland に無い (0V か 15V) ので要求しません
- **15V を出せない受信機では 0V で選局します** (`Px4Tuner.Lnb`)。px4-userland 0.1.8 から、
  1受信機の機種 (PX-M1UR / DTV02-1T1S-U / DTV02A-1T1S-U) は 15V の要求を
  `--allow-lnb-power` があっても UNSUPPORTED で断ります (給電の経路が無い)。そのまま要求すると
  衛星の選局が全部落ちるので、`lnb: 15v` と書いてあっても 0V で合わせ、記録に1度と、
  設定の「受信」の「チューナー」のそのチューナーの欄 (空いているときの `error`) に理由を出します。0V での衛星受信は
  これらの機種の対応範囲で、アンテナがほかの機器から給電されていれば受かります
  (給電が無ければ「同期しませんでした」)。出せるかどうかは一覧の受信機の
  `lnb_15v_supported` で、`px4ctl list` には載らないので、px4d を起こす前に一覧で聞いて
  写します。一覧を聞けなかったときは言われたとおりに要求します

## ファームウェア

**ファームウェアはイメージに入れず、使う人の機械で取ってきます。** IT930x は挿すたびにホストから RAM へ
ファームウェアを流し込み、px4-userland は受理するバージョンを SHA-256 で1つに固定して
います。PLEX 公式の Windows ドライバ
(`pxw3u4_BDA_ver1x64.zip` の `PXW3U4.sys`、著作権表示は Digital Warrior Corp.) から
切り出します (0x287d0 から 2,169 バイト)。配布 zip・`.sys`・切り出したものの3つを
ハッシュで確かめます。PLEX のサイトから取れなければ Internet Archive の写し (同じハッシュ) から取ります。

- **コンテナ** (`denpa-agent` / `denpa-aio`) は、エージェントが初めて px4d を起こすときに取ってきて
  `/config/it930x-firmware.bin` (`tuners.json` の隣) に置き、次からはそれを使います (`Px4Firmware.cs`)。
  **初めて使うときはインターネットに繋がっている必要があります。** 取れなければ理由を記録とチューナー画面
  (そのチューナーの `error`) に出し、10 分おきに試し直します。そのあいだも他のチューナーは使えます
- **Mac と Windows** は install.sh / install.ps1 が入れるときに切り出して px4-userland の横に置き、
  `PX4_FIRMWARE` で指します。置いてあればエージェントは取りに行きません

**再配布の許諾は誰も持っていません。** なので配布するもの (イメージ・リリースの添付) には入れず、
使う人の機械で PLEX の配布物から切り出します。px4-userland 本体も方針として同梱しません (SPEC 4.5)。

## 確かめたこと

**実機には当てていません** (手元の機材は PT3)。確かめたのは、機材に触らない部分
(`px4d --list-json` / `px4ctl list` の読み方・device 文字列・TUNE の中身・受信機と内蔵カードの IPC)
と、配布物の CLI が期待どおりの引数を受けることです。テストは `Px4Tests.cs` /
`Px4TunerTests.cs` / `Px4CardTests.cs` で (受信機とカードは px4d のふりをしたソケット相手)、出力の形式は px4-userland の SPEC 4.6 と自身のテストの期待値に
合わせてあります。実機で当てるのは
`denpa-agent --tune px4:<筐体の番号>:2 T27` (`Probe.cs`)。
