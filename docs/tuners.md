# チューナー

使えるチューナーと、要るもの・B-CASカード・困ったときのことです。
入れ方は [install.md](install.md) (Mac は [install-mac.md](install-mac.md)、Windows は [install-windows.md](install-windows.md))、
エージェントの作りは [agent.md](agent.md)。

## 要るもの

- **チューナー** — 挿してあれば自動で見つけ、種別 (地上波 / 衛星) も見分けます

  | チューナー | 使う仕組み | ホストに入れるもの |
  | --- | --- | --- |
  | PT2 / PT3、PX-BCUD、PX-S1UD など ([tuner-pt3.md](tuner-pt3.md)) | Linux DVB | ドライバ |
  | PX-Q3U4 / PX-W3U4 / PX-MLT 系など (px4-userland の対応機種。Windows も。[tuner-px4.md](tuner-px4.md)) | px4-userland (同梱) | なし (Windows はドライバを WinUSB に) |
  | PX-S1UD (smsusb を blacklist したとき。Windows も。[tuner-px-s1ud.md](tuner-px-s1ud.md)) | siano-userland (同梱) | なし (Windows はドライバを WinUSB に) |
  | PX-W3U3 ([下記](#px-w3u3-は-asicen-userland-で-試験的上流のリリース待ち)) | asicen-userland (**試験的**。上流のリリース待ちで、まだ入らない) | なし |

- **B-CASカード** と PC/SC のカードリーダー (px4-userland の機材は内蔵リーダーでもよい。[下記](#カードリーダー))
- **OS** — Linux (amd64 / arm64)、Mac (Apple Silicon)、Windows (x64)
- **Docker** (Linux・Mac。Compose 込み) か、Windows は WSL (`wsl --update` で入る `wslc`。Docker Desktop は要らない)。
  Kubernetes なら Helm
- あれば Intel の GPU (`/dev/dri` を渡す。[install.md](install.md#用意するもの))。無ければソフトウェアでエンコードします

機材ごとの入れ方は表のリンク先に。

## PX-W3U3 は asicen-userland で (試験的。上流のリリース待ち)

[asicen-userland](https://github.com/Khronos31/asicen-userland) は、px4-userland と同じ作者による
ASICEN 系 (PLEX PX-W3U3) のユーザー空間ドライバです。**まだリリースが無い** (0.1.0 の予定) ので、
いまは受け口だけ用意してあり、**イメージには何も入りません** (`agent/Dockerfile` の
`ASICEN_USERLAND_VERSION=0.0.0` が「まだ無い」の印)。配布物が無ければエージェントは機材を挙げません。
0.1.0 が出ると Renovate が版を上げる PR を出し (自動では入れない)、その CI で配布物の名前や形式が
見込みどおりかを確かめます。

上流の現状 (2026-10): 実機で選局できるのは **受信機 0 の衛星と受信機 1 の T27 だけ**、使える受信機は**同時に1つ**、
1台のホストで**1筐体まで**。上流自身が「まだ4つの受信機として動くドライバではない」と言っています。

- **設定の `device` は `asicen:<USB ポート>:<受信機>`** (`asicen:1-2:1`)。USB の serial が無いので、
  内蔵ハブのポートで筐体を見分けます。**差すポートを変えると別のチューナーになります**
- **LNB は出せません。** 設定に `15v` と書いてあっても 0V で選局し、設定の「受信」の「チューナー」にその旨を出します
- **ファームウェアは上流の配布アーカイブに入っているものをそのまま使います。再配布の権利は確かめられていません**
  ([licenses.md](licenses.md))。配布物に無ければ「ファームウェアがありません」と記録して、その機材は使いません
- 上流の第一弾は Linux x86_64 だけなので、arm64 のイメージ・Mac・Windows には入りません
- **実機には当てていません** (手元に PX-W3U3 が無い)。当てるなら `denpa-agent --tune asicen:1-2:1 T27`

エージェントの中でどう扱っているかは [agent.md](agent.md#asicen-userland-の作り)。

## カードリーダー

**USB のリーダーは usbfs を直接扱います。** `/dev/bus/usb` が見えていれば動きます。
ホストや別のコンテナで pcscd が動いていると使えません (「別のプロセスがリーダーを
使っています」と出る)。TPDU 単位のリーダー (Gemalto PC Twin など) には T=1 の枠組みを
こちらで組み、APDU 単位のリーダーにはそのまま送ります。カードの無いリーダーや INT に
答えないカードは飛ばし、USB のリーダーを内蔵リーダーより先に試します (`CardLinks.cs`)。

動いているエージェントがカードと話せているかは `/denpa/card` で分かります (INT を
1回通す)。止めた状態なら `denpa-agent --card` でも確かめられます (リーダーを並べ、
ATR とカードの番号を出す。動いているエージェントがリーダーを使っている間は断られます)。
チューナーを使わずに B25 だけ確かめるなら `denpa-agent --decode-file <in.ts> <out.ts>` (`/denpa/decode`
と同じことをする。掛かったまま録れてしまったものを救うのにも使える)。

## B-CASカードとデスクランブル

スクランブルは**エージェント自身が復号します** (`B25.cs`)。カードが読めないときは
掛かったまま流し、理由を状態に出します。黙って素通しすると「録画は成功してサイズも
それらしいのに中身が全部スクランブル」という分かりにくい壊れ方になるためです。
選局を畳むときに、掛かったまま流したパケットの数と理由を記録にも残します。

- **録画は止めません。** 電波は二度と来ないので、スクランブルされたままでも
  録ります。denpa がエンコードの前に見て、掛かったままならエージェントに
  復号させます (`src/lib/server/scramble.ts` → `/denpa/decode`)
- やり取りするのはパスだけです。元のTSの置き場 (`/media/raw`) を両方のコンテナに
  見せてあるので、読み書きはエージェントが直接やり、数十GBを HTTP で往復させません
  (`charts/denpa` が一緒に出すときは、置き場が RWO なので**両方の Pod が同じノードにあることが前提**です)
- 元のTSを残す設定のときは、残るのは復号したTSだけです。掛かったままのものは、
  あとから復号できる保証がありません
- 状態は設定の「受信」の「チューナー」にある「カードリーダー」の表に出ます。
  リーダーごとに1行で、カードの番号・状態 (使用中・予備・カードなし・エラー)・
  そのカードで復号しているチューナーを並べます。`CARD_URL` で鍵を貰っているときは、
  表の代わりに配り役の URL を出します
- **使うカードは1枚です。** INT に答えた最初のリーダーのカードを全部のチューナーで
  使い回します (ECM は鍵が変わるときにしか来ないので、1枚で足ります)。残りの
  リーダーは予備で、使っているカードが答えなくなると、繋ぎ直すときに探し直して
  使います。チューナーごとにカードは割り当てません

### 直らないとき

まず `/denpa/card` で、見えているリーダーと、カードに INT が通るかを見ます
(設定の「受信」の「チューナー」にある「カードリーダー」の表と同じもの)。使っているリーダーは鍵の出どころに
INT を通させ、他のリーダーは開いて覗いて閉じます (USB のリーダーは使うと他から
開けないので、使っているリーダーは開き直しません)。

```json
{
  "ok": true,
  "message": "",
  "source": "local",
  "readers": [
    { "name": "Gemplus USB SmartCard Reader (usb 4-11)", "card": true, "ids": ["0000012345678901"],
      "active": true, "tuners": ["PT3-T1", "PT3-S1"] },
    { "name": "PX4 内蔵リーダー", "card": false, "ids": [], "active": false, "tuners": [] }
  ]
}
```

`message` は困ったときだけ入ります (カードがどこにも無い、など)。覗けなかった
リーダーは `error` に理由が入ります。`CARD_URL` のときは `source: "remote"` で、
`remote` (配り役の URL)・`ids`・`tuners` が付き、`readers` は空です。
鍵を配る範囲と、断られたときの文は [鍵を配るのは LAN の中だけ](agent.md#鍵を配るのは-lan-の中だけ) にあります。

```sh
# ホストから呼ぶ (イメージには curl もシェルも無い)。compose は 25252 を出してある。Kubernetes は kubectl -n denpa port-forward deploy/tuner-agent 25252 を挟む
curl -s localhost:25252/denpa/card
```

- **`readers` が空** — `/dev/bus/usb` がコンテナに見えていない
- **`card: false` で `error` が無い** — そのリーダーにカードが挿さっていない
- **「別のプロセスがリーダーを使っています」** — ホストで pcscd が動いている。
  止めるか、リーダーをそちらから外す (`denpa-agent --card` を動いているエージェントの
  横で起こしたときも、エージェントが使っているのでこう出る)
- **応答が無い (タイムアウト)** — リーダーが固まっている。USB レベルで入れ直すと戻ります
  (`4-11` は `lsusb` と `/sys/bus/usb/devices` から引く)

```sh
echo 4-11 | sudo tee /sys/bus/usb/drivers/usb/unbind
sleep 2
echo 4-11 | sudo tee /sys/bus/usb/drivers/usb/bind
```

エージェントは起こし直さなくて構いません。次の ECM で探し直します。

実際に復号できているかは `--tune ... --decode` で見ます (復号したあとが 0% 近くなら正常)。
衛星で LNB に電源を送るなら `--lnb 15v` を足します。

```sh
kubectl -n denpa exec deploy/tuner-agent -- denpa-agent --tune /dev/dvb/adapter1/frontend0 T27 --decode
```
