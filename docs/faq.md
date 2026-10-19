# よくある質問

立てるときと使い始めに、よく聞かれることです。詳しいことはそれぞれのリンク先にあります。

## 立てる

### どのチューナーが使えますか

PT2・PT3・PX-BCUD (Linux DVB)、PX-Q3U4・PX-W3U4・PX-MLT 系など (px4-userland)、PX-S1UD です。
挿してあれば自動で見つけ、地上波か衛星かも見分けます。
一覧は [tuners.md](tuners.md#要るもの)。

### Mac や Windows でも動きますか

Apple Silicon の Mac と x64 の Windows で動きます。エージェントはその OS の上で直接、denpa 本体はコンテナで動きます。
使えるチューナーは px4-userland と siano-userland の機材です (DVB は Linux だけ)。
[install-mac.md](install-mac.md)・[install-windows.md](install-windows.md)。

### arm64 でも動きますか

Linux の arm64 で動きます。イメージは amd64 と arm64 を同じタグにまとめてあり、自分のアーキテクチャのものが降ってきます。
arm64 には Intel の QSV が無く、VA-API のドライバも入れていないので、ソフトウェアでエンコードします。
[install.md](install.md#用意するもの)・[encode.md](encode.md#gpu-でエンコードする-intel-qsv--va-api)。

### GPU が無くても使えますか

使えます。GPU が無ければソフトウェアでエンコードします。
AV1 は時間がかかるので、設定の「録画」で H.264 も選べます。観るときにその場で変換する本数は、GPU が無ければ 2 本までです (同じ「録画」の「同時に変換する本数」で変えられます)。
[encode.md](encode.md)。

### Mirakurun や EPGStation から乗り換えられますか

Mirakurun や EPGStation の役目は denpa が受け持ちます。EPGStation v2 からは、ルール・手動予約・録画を移せます。
[switch.md](switch.md)・[migrate.md](migrate.md)。

## チューナーとカード

### カードリーダーが NG のままです

まず設定の「受信」の「チューナー」にある「カードリーダー」の表を見ます。`/denpa/card` でも同じことが分かります。
リーダーが1つも無ければ `/dev/bus/usb` がコンテナに見えていません。「別のプロセスがリーダーを使っています」と出たら、ホストの pcscd を止めます。
[tuners.md](tuners.md#直らないとき)。

### NG のまま録った録画はどうなりますか

録画は止めず、スクランブルされたまま録ります。エンコードの前に、エージェントがもう一度復号を試します。
[tuners.md](tuners.md#b-casカードとデスクランブル)。

## 観る

### テレビで観たい

Android TV と Fire TV は、専用のアプリ [denpa-tv](https://github.com/danything/denpa-tv) で観られます。
テレビに出る QR をスマホで読めば繋がります。
[library.md](library.md#テレビのアプリ)。

### 家の外から観たい

ブラウザは OIDC でログインして入ります。テレビのアプリは QR でペアリングして入ります。
`TRUSTED_NETWORKS=0.0.0.0/0` はインターネットに向けて開くのと同じなので、家の外に出すなら OIDC にします。
アカウントは同じ世帯の人にだけ作り、世帯の外の人には観せません。
[auth.md](auth.md)・[使ってよい範囲](../README.md#使ってよい範囲)。

### VLC で観たい・録画をダウンロードしたい

外部のプレイヤーには対応しません。録画をファイルとして持ち出す機能もありません。
端末に保存して、denpa の中で観ることはできます。
[library.md](library.md#観るのはブラウザで)・[watch.md](watch.md#端末に保存して観る-オフライン)。

### 録画はどこに置かれますか

Linux ではコンテナの `/media` の下 (Compose ではボリューム) で、元のTSは `raw`、エンコードしたものは `encoded` に分けて置きます。
Mac は `~/Movies/denpa/library`、Windows は `~/Videos/denpa/library` に出来上がった録画が並びます。
別のディスクに分けるときは `RAW_DIR`・`ENCODED_DIR` を変えます。
[config.md](config.md)・[library.md](library.md)。

### コピー禁止の番組は録れますか

録りません。市販のレコーダーに揃えています。ライブではふだんどおり観られます。
[data.md](data.md#コピー禁止の番組は録らない)。

## 困ったとき

### 2.0 に上げたら、チューナーの画面やログアウトが見つかりません

設定の中に移りました。チューナーは設定の「受信」、ログアウトは設定の「その他」です。
[v2.md](v2.md)。

### うまくいかないとき

まず設定の「受信」 (チューナー・チャンネル) を見ます。エージェントとカードリーダーの状態、スキャンの結果、番組表の集まり具合が出ます。
イメージにはシェルが無いので、中を見るときはシェルのあるコンテナを横に付けます。
[install.md](install.md#うまくいかないとき)。

### 画面が 403 で開きません

OIDC も `TRUSTED_NETWORKS` も無いと、全部断ります。OIDC が無いときは、`TRUSTED_NETWORKS` に当たらない接続元も断ります。
家の中のネットワークを `TRUSTED_NETWORKS` に書くか、OIDC を設定します。
前段 (リバースプロキシ) の後ろなら、`TRUSTED_PROXIES` も要ります。
[install.md](install.md#誰を通すか)・[auth.md](auth.md#ログイン方法が無ければ全部断る)。

動いた/動かなかったを [Issue](https://github.com/danything/denpa/issues) で教えてもらえると助かります。
