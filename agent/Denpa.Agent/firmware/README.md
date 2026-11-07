# IT930x のファームウェア

`it930x-firmware.bin` は、px4-userland の機材 (PX-Q3U4 / PX-W3U4 / PX-MLT 系など) の USB ブリッジ IT930x に、
挿すたびに流し込むファームウェアです。エージェントの実行ファイルに埋め込んで配ります (`../Px4Firmware.cs`)。

- 大きさ: 2,169 バイト
- SHA-256: `5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484`
- 出どころ: ITE Tech. の IT930x の Linux ドライバの `api/brfirmware.h` にある `brFirmware_codes[]`
  (`ENDEAVOUR_FW_RELEASE_VERSION` は `V1_3_0_0`) を、そのままバイト列に書き出したもの。手を加えていません
- 許諾: ITE Tech. の Mike Huang 氏 (Marketing & Sales BU) から、2026-11-04 14:16 (日本時間) のメール
  (Message-ID `<d1d67cb55ae74a32a6a232a172ccf622@ite.com.tw>`) で、ITE の IT930x の Linux ドライバに入っている
  ファームウェアのデータ (`brfirmware.h`・`firmware.h`) を、無改変のままチューナーエージェントに同梱して再配布してよいと
  確認を得ています

このファイルは変えないでください。px4-userland は受理するファームウェアを SHA-256 で 1 つに固定していて、
違うものを渡すと起動しません。エージェントも使う前に SHA-256 を確かめます。
エージェントの MPL-2.0 ([../../LICENSE](../../LICENSE)) はこのファイルには及びません。一覧は [docs/licenses.md](../../../docs/licenses.md) にあります。

# mAgicVISION のファームウェア

`magicvision-firmware.bin` は、PIX-DT295 を常駐方式で動かすときに機材へ入れるファームウェアです (SBC2 形式。DT295 の分は
boot0 の body・hook と、256 KiB の常駐イメージ)。エージェントの実行ファイルに埋め込んで配ります (`../Dt295ResidentImage.cs`)。

- 大きさ: 289,424 バイト
- SHA-256: `828b7847d49b2ae6d5847088318876178aadb3dfd0ac23eaccf855776fb5d50b`
- 出どころ: mAgicVISION (<https://github.com/makeding/mAgicVISION>、作者 huggy) のリリース v2 の
  `magicvision-firmware_0.1.1_all.deb` にある `usr/lib/firmware/magicvision/firmware.bin`。手を加えていません
- 許諾: 上流の README の「`firmware.bin` などのファームウェア成果物は再配布できます」

このファイルも手で変えないでください。エージェントは使う前に SHA-256 を確かめ、違えば使いません。
本家の更新は `.github/workflows/magicvision.yml` が毎日見ています。最新のリリースの `firmware.bin` が変わったとき、または移植した MIT のコードが変わったときに、
差し替えた PR を作ります (固定している値は `magicvision.json`)。その PR は自分ではマージしないので、実機で確かめてからマージします。
