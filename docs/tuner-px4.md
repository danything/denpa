# PX-Q3U4・PX-W3U4 など (px4-userland)

PLEX の PX-Q3U4・PX-W3U4 などの USB / PCIe チューナーです。**同時に取れるチャンネルは受信機の数だけ**です。
**内蔵のカードリーダーがある機種は、それも使えます。**

**px4-userland が扱う機種は、いまはどれも px4-userland を使いません。** エージェントが USB を直に持ち、px4d はその機種を挙げず、起動もしません。
PX-MLT5 系は [tuners.md](tuners.md#px-mlt5-系)、PX-Q3・PX-W3 系・PX-MLT8PE・DTV02A-4TS-P・受信機が 1 つの機種 (DTV02-1T1S-U・DTV02A-1T1S-U・PX-M1UR・PX-S1UR・DTV03A-1TU) は
[tuners.md](tuners.md#px-q3px-w3-系とit930x-のほかの機種) にあります。PX-MLT5PE のほかは、エージェントが直に持つ形では実機で確かめていません。
設定に `px4:` で書いてあるチューナーは選局できないので、`device` を `it930x:<USB のポート>:<受信機>` に書き換えます (チューナーの行に、書き換える先が出ます)。

**この文書の「設定」「衛星の LNB 給電」「確かめたこと」は、px4d が筐体を持っていたときの説明です。** px4-userland はまだ同梱していますが、挙げる筐体がありません。
px4-userland の同梱とこの説明は、次の変更で消す予定です。ファームウェアの節は、エージェントが直に持つ形でも同じです。

チューナーの一覧は [tuners.md](tuners.md)、Windows で使うときは [install-windows.md](install-windows.md)。エージェントの中でどう扱っているかは [agent.md](agent.md#it930x-の機材を直に持つ作り)。

「Amazon で見る」は広告のリンクです ([tuners.md](tuners.md))。

[px4-userland](https://github.com/Khronos31/px4-userland) を**エージェントのイメージに同梱**しています
(`agent/Dockerfile`)。libusb だけで USB を扱うユーザー空間のドライバで、`/dev/bus/usb` が見えれば動き、
ホストに `px4_drv` (DKMS) もカーネルモジュールも要りません (`px4_drv` の `/dev/px4video*` には対応していません)。
ファームウェアはエージェントに同梱しています ([ファームウェア](#ファームウェア))。

## 対応機種

PX-Q3U4 / PX-W3U4、e-Better / Digibest 系など (USB・PCIe)。px4-userland の対応機種 ([一覧](https://github.com/Khronos31/px4-userland#対応機種動作環境)) は、どれもエージェントが直に持ちます。
機種ごとの USB の ID・受信機の数・種別は [tuners.md](tuners.md#px-q3px-w3-系とit930x-のほかの機種) の表にあります。

Amazon で見る (広告): [PX-W3U4](https://www.amazon.co.jp/dp/B01MR4SLB6?tag=doa08-22)、[DTV02A-1T1S-U](https://www.amazon.co.jp/dp/B08MTGFV39?tag=doa08-22)

## 設定

- **設定の `device` は `px4:<筐体の番号>:<受信機>`。** 挿さっていれば
  一覧から組み立てるので (`Px4Userland.Detect`)、普通は書きません。
  `status=ready` 以外の筐体と、まとめられなかった USB デバイス (`--list-json` の
  `ungrouped_usb_devices`) は、理由と USB の場所を記録して使いません
  (`open_failed` なら、Linux は `/dev/bus/usb` を開く権限、Windows はドライバが WinUSB かを疑う)。番号の桁数や受信機の上限は
  見ず、合わなければ `px4d` が理由を付けて断ります
- **番号が重なる筐体 (`serial_unique=false`) は、USB ポートで見分けます。** PX-M1UR と PX-S1UR は
  どれも USB の serial が `000000000000001` で、同時に挿すと別々の ready な
  筐体として並びます。番号のままだと同じ
  `px4:000000000000001:0` が 2 つでき、`px4d --device` も番号だけでは 1 台に決められず断ります。
  そこで名前を番号と USB ポートにし (`px4:000000000000001_1-2.3:0`)、`px4d` を
  `--device <番号> --usb-path <USBポート> --instance <名前>` で起動し、`px4ctl` やソケットも
  その名前で呼びます (SPEC 4.1)。**挿すポートを変えると別のチューナーになります**
  (px4-userland の docs にも「抜き差し後の物理個体は保証しない」とあります)

## 衛星の LNB 給電

- **15V は 2 段階で許可します。** `px4d` には `--allow-lnb-power` を渡し、実際に要求するのは
  設定に `lnb: 15v` と書いたチューナーだけ (TUNE の `lnb_voltage` = 15)。`11v` は
  px4-userland に無い (0V か 15V) ので要求しません
- **15V を出せない受信機では 0V で選局します** (`Px4Tuner.Lnb`)。
  1 受信機の機種 (PX-M1UR / DTV02-1T1S-U / DTV02A-1T1S-U) は 15V の要求を
  `--allow-lnb-power` があっても UNSUPPORTED で断ります (給電の経路が無い)。そのまま要求すると
  衛星の選局が全部落ちるので、`lnb: 15v` と書いてあっても 0V で合わせ、記録に 1 度と、
  設定の「受信」の「チューナー」のそのチューナーの欄 (空いているときの `error`) に理由を出します。0V での衛星受信は
  これらの機種の対応範囲で、アンテナがほかの機器から給電されていれば受かります
  (給電が無ければ「同期しませんでした」)。出せるかどうかは一覧の受信機の
  `lnb_15v_supported` で、`px4ctl list` には載らないので、px4d を起動する前に一覧で問い合わせて
  写します。一覧を取得できなかったときは設定どおりに要求します

## ファームウェア

**ファームウェアはエージェントの実行ファイルに埋め込んであります。** IT930x は挿すたびにホストから RAM へ
ファームウェアを流し込み、px4-userland は受理するバージョンを SHA-256 で 1 つに固定して
います。同梱しているのは ITE Tech. の IT930x の Linux ドライバに入っているデータをそのまま書き出したもの
(`agent/Denpa.Agent/firmware/it930x-firmware.bin`、2,169 バイト) で、ITE Tech. から無改変での再配布の許諾を得ています
([licenses.md](licenses.md#チューナーエージェントに同梱するファームウェア))。インターネットに繋がっていなくても使えます。

- エージェントは px4d を起動するときに、同梱のものを `tuners.json` の隣 (コンテナなら `/config/it930x-firmware.bin`) に
  書き出し、そのパスを px4d の `--firmware` に渡します (`Px4Firmware.cs`)。同じものが置いてあれば書き直しません
- 環境変数 `PX4_FIRMWARE` にパスを指定すると、同梱のものの代わりにそれを使います。どちらも SHA-256 を確かめ、
  違えば px4d を起動せず、理由を記録とチューナー画面 (そのチューナーの `error`) に出します。そのあいだも他のチューナーは使えます

## 確かめたこと

**実機では確かめていません。** 確かめたのは、機材に触らない部分
(`px4d --list-json` / `px4ctl list` の読み方・device 文字列・TUNE の中身・受信機と内蔵カードの IPC)
と、配布物の CLI が期待どおりの引数を受けることです。テストは `Px4*Tests.cs` で (受信機とカードは偽の px4d のソケットを相手にする)、出力の形式は px4-userland の SPEC 4.6 と自身のテストの期待値に
合わせてあります。実機で当てるのは
`denpa-agent --tune px4:<筐体の番号>:2 T27` (`Probe.cs`)。
