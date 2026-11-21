# エージェントに同梱するファームウェア

どのファイルも、機材のメーカーが配っているバイト列のままで、手を加えていません。変えないでください。
エージェントの MPL-2.0 ([../../LICENSE](../../LICENSE)) はこれらのファイルには及びません。一覧は [docs/licenses.md](../../../docs/licenses.md) にあります。

## IT930x のファームウェア

`it930x-firmware.bin` は、USB ブリッジ IT930x を積んだ機材 (PX-MLT5・PX-Q3・PX-W3 系など) に、
機材を開くたびに流し込むファームウェアです。エージェントの実行ファイルに埋め込んで配り、SDK の区切りの表どおりに分けて送ります (`../It930xFirmware.cs`)。

- 大きさ: 2,169 バイト
- SHA-256: `5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484`
- 出どころ: ITE Tech. の IT930x の Linux ドライバの `api/brfirmware.h` にある `brFirmware_codes[]`
  (`ENDEAVOUR_FW_RELEASE_VERSION` は `V1_3_0_0`) を、そのままバイト列に書き出したもの。手を加えていません
- 許諾: ITE Tech. の Mike Huang 氏 (Marketing & Sales BU) から、2026-11-04 14:16 (日本時間) のメール
  (Message-ID `<d1d67cb55ae74a32a6a232a172ccf622@ite.com.tw>`) で、ITE の IT930x の Linux ドライバに入っている
  ファームウェアのデータ (`brfirmware.h`・`firmware.h`) を、無改変のままチューナーエージェントに同梱して再配布してよいと
  確認を得ています

区切りの表 (`brFirmware_segments[]`) はこのファイルの長さ (2,169 バイト) に合わせてあり、
エージェントは使う前に SHA-256 を確かめて、違うものは使いません。

## Siano の ISDB-T のファームウェア

`isdbt_rio.inp` は、Siano RIO 系の機材 (PLEX PX-S1UD など) に、ファームウェアが入っていないときに送るファームウェアです。
エージェントの実行ファイルに埋め込んで配り、エージェントが USB で直に送ります (`../SianoFirmware.cs`)。
中身は解析しません。読むのは先頭 12 バイトの 3 つの欄だけで、本体はこのバイト列のまま 240 バイトずつ送ります。

- 大きさ: 85,840 バイト
- SHA-256: `054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818` (単体テストが埋め込んだファイルと突き合わせる)
- 出どころ: [linux-firmware](https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git) の
  コミット `a2dcb924f0897368b0b4f305cbf9808cdda90ce0` (タグ `20261019`) にある `isdbt_rio.inp` をそのまま
- 許諾: 同じコミットの `LICENSES/LICENCE.siano` (Siano Mobile Silicon Ltd.)。無改変のバイナリの再配布と使用を認めていて、
  著作権表示と免責の文面を配布物に添えること、解析しないことを求めています。文面は [LICENCE.siano](LICENCE.siano) にそのまま置いてあり、
  エージェントのイメージ (`/usr/share/doc/denpa-agent/`) と、Mac・Windows の配布物 (実行ファイルの隣) と、Android の APK (`assets/licenses/`) に入れています

## DiB0700 のファームウェア

`dvb-usb-dib0700-1.20.fw` は、Microsoft Xbox One Digital TV Tuner の USB ブリッジ (DiBcom DiB0700) に、ファームウェアが入っていないときに送るファームウェアです。
エージェントの実行ファイルに埋め込んで配り、エージェントが USB で直に送ります (`../Dib0700.cs`)。
中身は解析しません。レコードの長さの欄で区切り、仕様書の手順でアドレスの 2 バイトを入れ替えて送ります。

- 大きさ: 33,768 バイト
- SHA-256: `74f5ffeb43767e1af6d379d6cc2e0efeaa54455d030bcd71d95f0f2a908c672a` (エージェントが使う前に確かめる)
- 出どころ: [linux-firmware](https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git) の
  コミット `a2dcb924f0897368b0b4f305cbf9808cdda90ce0` (タグ `20261019`) にある `dvb-usb-dib0700-1.20.fw` をそのまま
- 許諾: 同じコミットの `LICENSES/LICENSE.dib0700` (DiBcom。ISC)。`WHENCE` は「Redistributable」としています。著作権表示と許諾の文面を添えることを求めるので、
  文面を [LICENSE.dib0700](LICENSE.dib0700) にそのまま置き、`LICENCE.siano` と同じ場所 (イメージ・Mac と Windows の配布物・Android の APK) に入れています

同じ機材の復調のファームウェア (`dvb-demod-mn88472-02.fw`) は再配布の許諾が分からないので、ここには置きません (docs/tuner-xbox-one.md)。

リポジトリに置いているのは、IT930x のファームウェアと同じ扱いにして、実行ファイル 1 個で Linux・Mac・Windows のどれでも同じファームウェアを使うためです。
イメージを組むときと `install.sh`・`install.ps1` が、外から取ってくるものが 1 つ減ります。
