# IT930x のファームウェア

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

このファイルは変えないでください。区切りの表 (`brFirmware_segments[]`) はこのファイルの長さ (2,169 バイト) に合わせてあり、
エージェントは使う前に SHA-256 を確かめて、違うものは使いません。
エージェントの MPL-2.0 ([../../LICENSE](../../LICENSE)) はこのファイルには及びません。一覧は [docs/licenses.md](../../../docs/licenses.md) にあります。
