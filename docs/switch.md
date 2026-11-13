# ほかの録画ソフトから乗り換える

Mirakurun・EPGStation・KonomiTV・EDCB を使っている人向けに、それぞれの役目が denpa のどこに当たるかと、
移せるもの・移せないものをまとめます。EPGStation・EDCB からの引き継ぎの手順は [migrate.md](migrate.md)。

## 役目の対応

denpa の部品は、チューナーを扱う**チューナーエージェント**と、それ以外を受け持つ **denpa 本体**の 2 つです
([architecture.md](architecture.md))。

| いま使っているもの | 受け持っている役目                                     | denpa では                                                               |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Mirakurun          | チューナーを持ち、選局して TS を配る                   | チューナーエージェント ([agent.md](agent.md))                            |
| EPGStation         | 番組表・ルール・予約・録画・エンコード・ブラウザで観る | denpa 本体                                                               |
| KonomiTV           | ブラウザでライブと録画を観る                           | denpa 本体 (ライブと観る画面。[watch.md](watch.md))                      |
| EDCB               | チューナー・番組表・予約・録画                         | チューナーはエージェント、ほかは denpa 本体                              |
| テレビで観るアプリ | テレビでライブと録画を観る                             | [denpa-tv](https://github.com/danything/denpa-tv) (Android TV / Fire TV) |

スクランブルの復号 (B25) もエージェントがします ([tuners.md](tuners.md#b-casカードとデスクランブル))。

## 要らなくなるもの

denpa だけで録って観るなら、次のものは要りません。

- **Mirakurun などのチューナーサーバ**。エージェントが選局して TS を配ります
- **選局のコマンド** (recpt1・recisdb など)。選局はエージェントがします。DVB のチューナーはデバイスを直接操作します
- **B25 のデコーダ**。復号はエージェントがします。Linux では pcscd も要りません (USB のカードリーダーを直接扱う。[tuners.md](tuners.md#カードリーダー))
- **チャンネルの設定ファイル**。設定の「受信」の「チャンネル」でスキャンします。衛星は最初から局が入っています
- **データベースのサーバ** (MariaDB など)。denpa は SQLite を自分で持ちます ([config.md](config.md))
- **PX-MLT5 系・PX-Q3U4・PX-S1UD などのホストのドライバ**。IT930x の機材 (PX-MLT5 系・PX-Q3U4 など) と PX-S1UD は、エージェントが USB を直に持ちます
  (PX-S1UD の実装は実機で確かめていません。Linux ではカーネルのドライバでも使えます)
  ([tuner-it930x.md](tuner-it930x.md)・[tuner-px-s1ud.md](tuner-px-s1ud.md))。PT3 などの DVB のドライバは要ります ([tuner-pt3.md](tuner-pt3.md))

## 移せるもの・移せないもの

**EPGStation (v2・v3) からは、録画・ルール・手動予約と、ルールで録った録画の履歴を移せます** ([migrate.md](migrate.md))。
設定画面に EPGStation の URL を入れて実行し、何度走らせても二重にはなりません。API で取ってくるだけなので、元は残ります。
時刻指定や正規表現のルール・エンコードの設定・重複を避ける期間・消した録画の履歴は移りません
([何が入って、何が入らないか](migrate.md#何が入って何が入らないか))。

**EDCB (EpgTimer) からは、ルール・手動予約・録画の履歴を移せます** (EpgTimerSrv に TCP で繋いで読む。録画のファイルと、録画済みの一覧から消した回は移りません。[migrate.md](migrate.md#edcb-からの引き継ぎ))。

Mirakurun・KonomiTV から取り込む仕組みはありません。チャンネルはスキャンし直し、ルールと予約は denpa で作り直します。

## 観かたで変わること

- **観るのはブラウザと denpa-tv です。** VLC などの外部のプレイヤーには対応せず、録画をファイルとして持ち出す機能もありません。
  端末に保存して denpa の中で観ることはできます ([library.md](library.md#観るのはブラウザで))
- **コピー禁止の番組は録りません** ([data.md](data.md#コピー禁止の番組は録らない))
- 使ってよい範囲は「自分の B-CAS カードで、自分の世帯の中で、私的に」です ([README](../README.md#使ってよい範囲))

## 並べて動かすとき

ほかのソフトと同じ機械で動かすときに、コードで確かめてある振る舞いです。

- **チューナーの設定を保存するまでは、見つけたチューナーを全部使います。** エージェントは `/dev/dvb` のアダプタと、
  asicen-userland の機材と、USB を直に持つ機材 (IT930x の機材・PX-S1UD など) を自分で探します
- **一度選局したチューナーは、エージェントを止めるか、チューナーの設定を変えるまで開いたままです。**
  同じチューナーをほかのソフトと分け合う仕組みはありません
- **ほかのソフトに残すチューナーは、設定の「受信」の「チューナー」で「使う」のスイッチを外します。** 外したチューナーは選局に使いません
- **asicen-userland の機材 (PX-W3U3 など) は、筐体の受信機を全部外すと asicend を止めて USB を手放します** ([agent.md](agent.md#asicen-userland-の作り))。
  1 つでも「使う」に戻すと、また起こします
- **IT930x の機材 (PX-Q3U4 など) は、受信機を全部外すと、30 秒待ってから電源を切って USB を手放します** ([tuner-it930x.md](tuner-it930x.md#設定))。
  内蔵カードリーダーで復号しているときは手放さないので、同じ画面のカードリーダーの表で、そのリーダーの「使う」も外します
- **Linux では、ホストや別のコンテナで pcscd が動いていると USB のカードリーダーを使えません**
  (「カードリーダーはほかのソフトが使っています」と出ます。[tuners.md](tuners.md#直らないとき))
- **PX-S1UD は、カーネルのドライバが使っているものにはエージェントから触りません** ([tuner-px-s1ud.md](tuner-px-s1ud.md))
- **Linux に px4_drv (PX-Q3U4・PX-W3U4・PX-MLT5PE などのカーネルドライバ) が入っていると、その機材はエージェントから開けません。**
  px4_drv が機材を使っている間は、エージェントは USB を開けず「ほかのソフトが使っています」と返します。denpa で使うなら、ホストで px4_drv を
  blacklist して再起動します。Mirakurun など px4_drv の機材を使っていたソフトは、その機材を使えなくなります

  ```sh
  printf 'blacklist px4_drv\n' | sudo tee /etc/modprobe.d/denpa-px4.conf
  sudo reboot
  ```

## いまの環境を残して denpa を足す

**px4_drv と Mirakurun を外さずに denpa を使うなら、エージェントの代わりに Mirakurun へ中継するブリッジを置きます。**
チューナーは Mirakurun が持ったままで、denpa は Mirakurun を通して選局します。EPGStation などほかのソフトと同じチューナーを共有できます。

- [denpa-mirakurun-bridge](https://github.com/multiverse2011/denpa-mirakurun-bridge) (multiverse2011 さん作、Apache-2.0)。
  denpa のチューナーエージェントの API を Mirakurun に中継します。denpa v2.28.0 以降が要ります。
  denpa の `compose.override.yml` で `tuner-agent` をこのブリッジのイメージに差し替えます。
  Mirakurun の `channels.yml` の書き方に条件があります。手順と条件はブリッジの README にあります

このブリッジは denpa とは別の人が作っています。Doa では動作を確かめていません。内蔵カードリーダー・信号レベル・ケーブルの受信のように
エージェントが受け持つ機能がどこまで使えるかも確かめていません。不具合や質問はブリッジのリポジトリへ送ってください。

同じ役目のものは、2026 年 11 月の時点でほかに見つかっていません。別の人が作っているものには、Home Assistant に denpa を入れるアドオン
([Khronos31/hassio-addons](https://github.com/Khronos31/hassio-addons)) もあります。こちらはチューナーをほかの録画ソフトと共有しません。
同梱する denpa のバージョンは、アドオンの側で決まります。
