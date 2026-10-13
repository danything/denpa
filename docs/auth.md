# 誰を通すか

**アカウントを作れるのは、同じ世帯の人だけにしてください。** denpa は自分の世帯の中で私的に観るための
ものです。OIDC のグループ (`OIDC_GROUP`) に入れる人、ペアリングするテレビ、`TRUSTED_NETWORKS` に入れる
ネットワークも、同じ世帯の人と機器に限ります。考え方は [Discussion #760](https://github.com/danything/denpa/discussions/760) にあります。

**エンドポイントによって守り方が違います。** 録画のファイル (`/api/recordings/<id>/file`) も画面と同じ守り方です。

| エンドポイント | 守り方 |
| --- | --- |
| `/api/live/socket` | 使い捨てのチケット (下記)。ここだけ SvelteKit に届きません |
| それ以外 (画面・録画のファイル・[外から使う API](api.md)) | OIDC (設定してあれば) |
| どのエンドポイントも | `TRUSTED_NETWORKS` に当たれば素通し (下記) |
| どのエンドポイントも | アクセストークン (`Authorization: Bearer denpa_…`) があれば、どこから来ても通す ([下記](#アプリのペアリング)) |
| `/login*` `/logout` `/api/health` `/manifest.webmanifest` `/api/device/code` `/api/device/token` | 素通し (`auth.ts` の `OPEN_PATHS`) |

**OIDC も `TRUSTED_NETWORKS` も設定していなければ、認証なしで通すエンドポイントのほかは全部断ります** (403、
理由を本文に書いて返す。[下記](#ログイン方法が無ければ全部断る))。全部開けたいなら
`TRUSTED_NETWORKS=0.0.0.0/0` です ([公開時の注意](#ネットワークの中なら何も聞かない))。

**`/api/live/socket` だけは前段の `Bun.serve` が受けます** (`server.js`)。bun の
`node:http` では WebSocket の握手ができないためで、SvelteKit の `hooks.server.ts` に
届かず、ここに書いた守り方は効きません。

**ブラウザは WebSocket の握手に `Authorization` を付けてくれない**ので、画面が先に
`POST /api/live/ticket` で使い捨てのチケットを取り、URL に付けて繋ぎます。チケットの発行は
普通の HTTP なので、OIDC も信頼したネットワークもそのまま効きます。チケットは1回使ったら
消し、寿命は30秒 (`src/lib/server/tickets.ts`、詳しくは [stream.md](stream.md#繋ぐときの認証))。

**`/api/health` を守ると Pod が再起動を繰り返します。** Kubernetes の `livenessProbe`
が呼ぶエンドポイントで、掛ける範囲を選べるのをやめたときに踏みました (E2E のスタックが起動待ちで固まって気付いた)。
出しているのは「生きているか・動いている版と新しい版・局が何件か・録画が何本か」だけです。

**`/manifest.webmanifest` を守るとホーム画面の名前が付きません。** ブラウザは
マニフェストを資格情報を付けずに取りに来るので、401 で落ちます。
中身は表示名・色・アイコンの場所だけです ([player.md](player.md#ホーム画面に置く))。

**録画のファイルも、ほかの API と同じ守り方です。** 観る画面の `<video>` も端末に保存も、
画面と同じログインの控え (Cookie) を付けて `/api/recordings/<id>/file` をリクエストします。テレビのアプリは
アクセストークンを付けます。ログインせずに開ける URL を渡す仕組み (前の「再生リンク」) はやめました
(外部のプレイヤーには対応しないため。[app.md](app.md#再生リンクをやめた-前の版から上げるとき))。

## ログイン方法が無ければ、全部断る

**何も設定しないまま立てると、認証なしで通すエンドポイント (上の `OPEN_PATHS`) のほかは 403 で断ります** (fail-closed)。
起動ログに1度だけ案内を出します。

```text
[boot] ログイン方法が設定されていないため、すべてのアクセスを断ります。
       OIDC (docs/auth.md) か TRUSTED_NETWORKS (CIDR のカンマ区切り) を設定してください。
       すべて開けるなら TRUSTED_NETWORKS=0.0.0.0/0 (公開時の注意は docs/auth.md)
```

**ベーシック認証 (起動時に自動生成) は廃止しました。** 起動ログで
しか受け取れないパスワードは流すと詰み、自動で掛かる方式は「設定を忘れた」と区別が
付きません。閉じていれば閉じていると分かるほうを採りました。

## OIDC でのログイン

**3つ揃ったときだけ有効**になります。揃っていなければ、ログイン方法は
`TRUSTED_NETWORKS` だけです。

| 変数 | |
| --- | --- |
| `OIDC_ISSUER` | 例 `https://login.microsoftonline.com/<tenant>/v2.0` |
| `OIDC_CLIENT_ID` | アプリ登録のアプリケーションID |
| `OIDC_CLIENT_SECRET` | クライアントシークレット |
| `OIDC_GROUP` | このグループにいるか、このロールを持つ人だけ通す。空なら入れた人は全員 |
| `TRUSTED_NETWORKS` | 何も聞かずに通すネットワーク (例 `10.10.0.0/16`)。下記 |
| `OIDC_SESSION_TTL` | ログインの有効期間(ms)。既定30日 |

秘密を含むので環境変数だけから読み、設定画面には出しません。

> **scheme は `x-forwarded-proto` から読みます** (`server.js` が常に設定する。前段が付けなければ、受けた接続の scheme を入れる)。
> コールバックの URL も、控えの Cookie に `Secure` を付けるかどうかも、リクエストの
> scheme で決めます。前段が接頭辞を剥がして渡す構成 (`/denpa` の下など) では、前段が付ける
> `X-Forwarded-Prefix` (Home Assistant は `X-Ingress-Path`) をコールバックの URL の頭に付けます
> (`paths.ts` の `publicBase`)。登録するリダイレクト URI も接頭辞込みです。

### ライブラリを入れていません

使うエンドポイントは discovery・authorize・token・jwks の4つだけで、どれも素の HTTP と
WebCrypto で足ります。認証まわりで「中で何をしているか分からない」を抱えるより、
200行書くほうを選びました (`src/lib/server/oidc.ts`)。

OIDC の標準しか使っていないので、Keycloak でも Google でも同じはずです
(実機で当てたのは Entra ID だけ)。

- **認可コードフロー + PKCE (S256)**。`state` と `nonce` も使います
- **ID トークンは署名まで見ます。** 認可コードフローでは TLS 越しに相手から直に
  受け取るので仕様上は省けますが (OIDC Core 3.1.3.7)、省くと安全が
  「トークンをどこから受け取ったか」に乗ります。WebCrypto で数行です
- **受ける署名方式は RS256 だけ。** `alg: none` を受けると署名を見ない抜け道ができます
- 発行元・宛先・期限・合言葉 (`nonce`) を確かめます。時計のずれは60秒まで許します

### グループかロールで決める

**誰がログインしたかでは決めません。** 人が増えても denpa 側を触らずに済みます。

**見るのは `groups` と `roles` の両方で、どちらかに `OIDC_GROUP` があれば通します。**
この家はグループクレーム (グループのオブジェクトID) からアプリロールへ移しました。
グループを載せると ID トークンが大きくなり、oauth2-proxy の Cookie セッションが
壊れるためです。両方受ければ、どちらの形式の登録でも、切り替えの途中でも入れます。

Entra ID でグループを載せるには、アプリ登録の「トークン構成」で
`groupMembershipClaims` を有効にしてください。既定で載るのは
グループのオブジェクトID (GUID) なので、`OIDC_GROUP` にもそれを書きます。

```sh
OIDC_GROUP=6f1b2c3d-4e5f-6789-abcd-ef0123456789
```

ロールで決めるなら、アプリ登録のアプリロールを作って人に割り当て、`OIDC_GROUP`
にはそのロールの値を書きます。

断るときは理由を画面に出します。**黙って弾くと「なぜか自分だけ入れない」になる**ためです。

| 出るもの | 意味 |
| --- | --- |
| `... のグループにもロールにも入っていません` | そのとおり |
| `ID トークンに groups も roles もありません` | `groupMembershipClaims` がまだ無効で、アプリロールも割り当てていない |
| `グループが多すぎて ID トークンに載っていません` | Entra が `groups` の代わりに `_claim_names` を返し、`roles` も無かった。アプリロールに移すか、グループを減らすか、`OIDC_GROUP` を空にして Entra 側のアプリ割り当てで決める |

## アプリのペアリング

**テレビのアプリ ([danything/denpa-tv](https://github.com/danything/denpa-tv)) は、QR で
ペアリングしてアクセストークンを持ちます** (`device-auth.ts`)。家の外から OIDC 越しに使うためで、
信頼するネットワークの中ならペアリングは要りません (アプリはアクセストークンなしで API を呼び、
401 の JSON が返ったときだけペアリングに進む。[api.md](api.md#認証))。

方式は OAuth のデバイス認可 (RFC 8628) と同じです (API の形式は [api.md](api.md#ペアリング-post-apidevicecode--post-apidevicetoken))。
テレビがコードを貰って `device?code=…` を QR に出し、スマホで開くと、いつものログイン方法
(信頼するネットワーク、無ければ OIDC のログイン) を通ったうえで**そのまま済む**。テレビは待っていたアクセストークンを1度だけ受け取り、
以後は `Authorization: Bearer denpa_…` でどのエンドポイントにも入る (`/device` で別の端末を済ませることだけは断る。下記)。

**「許す / 断る」は聞きません。** 家で使う前提で、QR を読めるのはテレビの前にいる人だからです。
その代わり:

- **コードは10分で切れ、1度しか使えない。** アクセストークンを渡したらコードは使い終わり (`consumed_at`)
- **コードは画面に出さない。** QR を読んだ時点でそのテレビと結び付いていて、コードは URL に入って自動で渡る。人が打つことも見比べることも無いので、出しても読む人がいない
- **開いただけでは済ませない。** `/device` は開くと自分でフォームを送る (POST。CSRF の守りが効く)。
  GET のまま済ませると、ブラウザの先読みやリンクの下見で黙って済んでしまう。
  読み直してもアクセストークンは2つにならない (作るのはテレビが受け取るとき)
- **有効なコードは20まで** (`MAX_PENDING`)。コードを発行するエンドポイントは誰でも呼べるので溜め込ませない。
  埋められても10分でペアリングできるようになり、入れるようにはならない
- **秘密は DB に置かない。** `deviceCode` もアクセストークンも SHA-256 だけ持つ (`device_codes` / `api_tokens`)。
  アクセストークンは許した瞬間ではなく**渡すときに作る**ので、生のアクセストークンを預かっておく場所が要らない
- **無効にした・知らないアクセストークンは 401** (`{"error":"invalid_token"}`)。**信頼するネットワークの中でも、
  ほかの認証へは回さない** — 黙って通すと、アプリは取り消されたことに気付けず、外へ出た途端に
  使えなくなる。`denpa_` で始まらない Bearer (前段の SSO などが付けるもの) は見ずに、いつもの認証へ回す
- **取り消しは設定画面の「テレビのアプリ」から** (行は消さずに `revoked_at`。いつ・誰が許したかを残す)。
  アプリの「サーバーから外す」は `POST /api/device/logout` で自分のアクセストークンを無効にする
- 最後に使った時刻は1分に1度だけ書く (映像は Range ごとに来るので、毎回書くと DB に書き続けることになる)
- **アクセストークンで入った相手は `/device` で済ませられない** (403。`approve` が断る)。盗まれたアクセストークンで
  別のアクセストークンを作れると、元のものを取り消しても作ったものが生き残るため

**確かめずに済ませることで残る危うさ (承知のうえ)。** コードを発行するエンドポイントは誰でも呼べるので、
**悪意のある人が自分の端末でコードを作り、その `device?code=…` を、denpa に入れる人に開かせる**と
(メッセージのリンク・QR を差し替えるなど)、開いた瞬間に相手の端末へアクセストークンが渡ります
(デバイス認可のフィッシング)。家で使う前提で、確かめの手順を挟まないことを選んでいます。代わりに:

- コードは10分で切れ、1度しか使えない (古いリンクを後から開かせても効かない)
- 完了の画面に**端末の名前**を出す。テレビの前にいないのにこの画面が出たら、それはおかしい
  (名前は端末の自己申告で、だれでも「テレビ」と名乗れる)
- 渡したアクセストークンは設定画面の「テレビのアプリ」に**名前・ペアリングした時刻・最後に使った時刻**つきで並び、
  その場で取り消せる。**覚えのない端末が無いか、ときどき見てください**
- 人から送られてきた `device?code=` のリンクは開かない (QR はテレビに出ているものだけ読む)

## ネットワークの中なら、何も聞かない

**`TRUSTED_NETWORKS` に当たると、OIDC も掛かりません。**
LAN のテレビのアプリ (denpa-tv) に、ログインもペアリングもなしで使わせるためのものです。

```sh
TRUSTED_NETWORKS=10.10.0.0/16
# いくつでも並べられる
TRUSTED_NETWORKS=10.10.0.0/16,10.20.0.0/16,192.168.1.5
# 全部開ける (家の中だけで完結する構成向け。公開時の注意は下)
TRUSTED_NETWORKS=0.0.0.0/0
```

**`0.0.0.0/0` はインターネットに向けて開くのと同じです。** 録画も設定も誰でも触れます。
家の外に出す構成では使わず、OIDC にします。

**見るのは住所だけで、どの名前で来たかは問いません。** LAN から外向きの
`dp.doany.io` を開いても通ります。前段 (chart の `httpRoute`) は2つの名前を
1つの HTTPRoute で denpa に届けるだけです。LAN 用の名前 `dp.l.doany.io` が家の中でだけ
引けるのは DNS の側の話です ([player.md](player.md))。

### 前段の後ろに置くとき (`TRUSTED_PROXIES`)

**前段 (Gateway やリバースプロキシ) があるなら、前段のアドレスを `TRUSTED_PROXIES` に書くこと。**
書かないと接続元が前段のアドレスになり、`TRUSTED_NETWORKS` が誰にも当たりません (=全員が認証を
求められます。開いてしまう向きには倒れません)。前段が無い (ブラウザが直に denpa へ来る) なら
何も要りません。

```sh
# この構成 (k3s + Cilium Gateway。Envoy は hostNetwork で、Pod の網のアドレスから繋いでくる)
TRUSTED_PROXIES=10.42.0.0/16,fd42::/64
# 同じ compose のネットワークにいるリバースプロキシ
TRUSTED_PROXIES=172.16.0.0/12
```

決め方は nginx の `set_real_ip_from` + `real_ip_recursive on` と同じです
(`src/lib/server/address.ts` の `resolveClient`。入口の `server.js` が使う)。

- 直の相手が `TRUSTED_PROXIES` に**当たらなければ、相手そのもの**が接続元。`X-Forwarded-For` は
  誰でも付けられるので読みません。denpa のポートへ前段を通らずに届く経路があっても、ヘッダで
  `TRUSTED_NETWORKS` を名乗ることはできません
- 当たれば `X-Forwarded-For` を**右から**辿り、前段のアドレスを飛ばして、最初に出てきた
  前段でないアドレスを接続元にします。前段を何段重ねても、全部 `TRUSTED_PROXIES` に入っていれば
  段数を数える必要はありません。全部が前段なら左端を使います
- 読めない項目に当たったら、そこで止めます (その先は信じない)
- `::ffff:10.0.0.1` のような IPv4 を写した IPv6 は IPv4 として扱います
- **前段の網を広く書くと、その網の中の誰もが前段を名乗れます。** Pod の網を入れると、
  クラスタの中の Pod は `X-Forwarded-For` を付けて denpa に直に来れば好きな接続元を名乗れます。
  クラスタの中を信じられないなら、前段のアドレスだけに絞ってください

決めたアドレスは内側の adapter-node へ `x-denpa-remote` で渡します (外から同じ名前で付けて
来ても上書きで消えます)。アドレスを読めなかったときは通しません。

**`X-Forwarded-Proto` は前段かどうかを問わず読みます。** 付けられて変わるのは、付けた本人に
返る origin の見た目だけです (CSRF の判定はブラウザが付ける `Origin` と比べるので、他人の
ブラウザからは付けられない)。前段だけに絞ると、`TRUSTED_PROXIES` を書き忘れた https の構成で
POST が全部断られるようになるだけで、守れるものがありません。

> 前の版の `ADDRESS_HEADER=x-forwarded-for` は廃止しました (読みません)。上げるときは
> [docs/app.md](app.md#接続元の読み方を変えた-前の版から上げるとき)。

ネットワークの書き方は CIDR (`10.10.0.0/16`・`fd00::/8`) か住所そのまま。IPv4 と IPv6 の
どちらも書けます。

### ログインの控え

**DBに持ちます** (`sessions`)。署名した Cookie に中身を入れる手もありますが、それだと
「この端末だけ切る」ができません。Cookie に入るのは推測できない32バイトだけです。

- `httpOnly` / `SameSite=Lax` / https のときは `Secure`
- 切れたものは `RECONCILE_INTERVAL` ごとに片付けます (読む側は先に無視しています)
- **ログアウトはこちらの控えを消すだけ**で、Entra 側からは出しません。
  `end_session_endpoint` へ送ると、同じ Entra で入っている他のものまで巻き添えで
  切れるためです

### Entra ID 側の用意

1. **アプリの登録**を作る (シングルテナントでよい)
2. **リダイレクト URI** を「Web」で登録する。denpa の名前ごとに1つずつ要ります
   (`https://dp.doany.io/login/callback` と `https://dp.l.doany.io/login/callback`)
3. **クライアントシークレット**を作る
4. **トークン構成**で `groupMembershipClaims` を有効にする (グループで絞るなら)。
   ロールで絞るなら、代わりに**アプリロール**を作って割り当てる

> **リダイレクト URI は authorize を呼んでも確かめられません。** 未登録の URI でも
> Entra はまずログイン画面を返し、認証が済んでから `AADSTS50011` を出します
> (出鱈目な URI を対照にして確認済み)。登録は Azure の画面で見るしかありません。

#### この構成で実際に使っている値

**oauth2-proxy (`auth` 名前空間) と同じアプリ登録を使い回しています。** テナントも
同じなので、入れる人の集合は前段で forward-auth していたときと変わりません。

値は `denpa` 名前空間の Secret `denpa-oidc` (鍵は `issuer` / `client-id` /
`client-secret` / `group`) に入っていて、chart はその名前 (`denpa.oidcSecretName`、
この家の値は `deploy/application.yaml` の `helm.valuesObject`) を `secretKeyRef` で引くだけです。

**Secret は Infisical の operator が作ります** (`deploy/oidc-secret.yaml` の InfisicalSecret)。
値は Infisical (https://il.doany.io、このクラスタでセルフホスト) のフォルダ
`/denpa/denpa-oidc` にあり、シークレット名がそのまま Secret の鍵になります。
手で作った Secret だと、クラスタを立て直したとき他は全部 ArgoCD がリポジトリから戻すのに、
これだけ手順を思い出して打ち直すことになります。リポジトリには「どこから取るか」だけが
あって値は入っていません。

値を変えるときは Infisical の UI で書き換えるだけです。Secret はすぐ追いつき、
Deployment に付けた `secrets.infisical.com/auto-reload` で Pod も入れ替わります
(denpa は Secret を環境変数で読むので、入れ替えないと古い値を使ったまま。
録画中なら終わるまで居座ってから)。

### 前段の forward-auth は使わない

前段に `forward-auth` (oauth2-proxy) は挟みません。「配信だけ通す」仕分けは denpa 側
(`auth.ts`) がやります。前段から外すときは「denpa 側を設定 → 実機で入れることを確かめる →
前段から外す」の順にします。逆にすると、OIDC の設定を間違えていたときに、誰も入れないのではなく
誰でも入れる状態になります。

## 画面で動いてよいもの (CSP)

**画面の HTML には Content-Security-Policy を付けています** (設定は `vite.config.ts` の
`csp`、SvelteKit が毎回付ける)。上までは「誰を通すか」ですが、ここは「通した人の画面で、
**誰が書いたスクリプトを動かすか**」です。

**狙いは放送が書いたスクリプト。** データ放送のエンジン (`src/lib/bml/`) は BML の
`onclick` などを DOM に写さず、自前の VM で動かします (描く要素に付くのは `style` と画像の
`src`・`alt` だけ)。それでも写し漏れがあったとき、放送の文字列が **denpa の origin で本物の
JS として動き**、ログインの控えで API を呼べることになるので、「放送のものを本物の JS として
動かさない」最後の砦として CSP でも止めます。

| 指令 | 値 | 理由 |
| --- | --- | --- |
| `script-src` | `'self'` + nonce | 自分の束 (`_app/`。データ放送のエンジンの遅延読み込みも) と、SvelteKit の起動・後から流すデータの `<script>` (nonce)。**`'unsafe-inline'` と `'unsafe-eval'` は入れない** |
| `script-src-attr` | `'none'` | `onclick="…"` などの属性のハンドラを止める (上の穴そのもの) |
| `style-src` | `'self' 'unsafe-inline'` | 下の「スタイルは止めない」 |
| `img-src` | `'self' data: blob:` | 局ロゴ・ポスターは自分。データ放送の画像は作り直して blob:、DRCS (外字) は canvas から data: |
| `font-src` | `'self' data: blob:` | Denpa Font は自分 (`/api/font/denpa-font.woff2`)。DRCS は FontFace にバイト列で渡すので URL ではない |
| `media-src` | `'self' blob:` | 録画は自分。ライブの MSE と端末に保存した録画は blob: |
| `connect-src` | `'self'` | fetch・SSE・データ放送の双方向の中継 (`/api/bml/…`)・ライブの WebSocket。`'self'` は同じ host の `ws:` / `wss:` も含む |
| `worker-src` | `'self'` | 変換せずに観る経路の worker (`src/lib/raw/worker.ts`) と PWA の ServiceWorker |
| `object-src` / `frame-src` | `'none'` | どちらも使わない。BML の `<object>` はエンジンが画像 (`<img>`) か映像の場所の目印にするので読み込まない |
| `base-uri` / `form-action` | `'self'` | `<base>` とフォームの送り先は自分だけ |
| `default-src` | `'self'` | 上に無いもの (マニフェストなど) |

**画面の移動は関わりません。** OIDC のログイン (`/login` が Entra へ 302)・
Hybridcast (別のタブで開く)・更新のお知らせのリンクは移動なので、上のどれにも掛かりません。
フォームの送り先 (`form-action 'self'`) は自分だけで、送ったあとに外へ回すフォームはありません
(ログアウトは `/login/out` へ戻すだけ。期限切れの POST はリダイレクトせず 401)。
`frame-ancestors` は「denpa を枠に入れて使う」構成を止めるかどうかの別の話なので、
ここでは決めていません。

**WebSocket を `'self'` で通すのは CSP3 の決まり**で、今のブラウザ (Chrome・Edge・Firefox・Safari)
は同じ host の `ws:` / `wss:` を `'self'` に含めます。CSP3 より前の作りの古いブラウザ (数年前の Safari など) では
ライブが繋がりません。`ws:` / `wss:` を足せば通りますが、どこへでも繋げるようになるので足していません。

### nonce にする (hash ではなく)

**設定画面とチューナーの画面は、load から Promise を返して後から流しています**
(SvelteKit のストリーミング)。流れてくる `<script>` は頭 (ヘッダ) を送ったあとに組まれるので、
hash を頭に載せられず、hash の方式だと止まります。`app.html` の色当てのスクリプトも
`nonce="%sveltekit.nonce%"` で通しています。

nonce は毎回変わるので、**画面の HTML は 304 になりません** (中身の指紋が毎回変わる)。
HTML は小さく、重いもの (`_app/immutable/`) は永く持たせたままなので困りません
(`hooks.server.ts` の `finish`)。

### スタイルは止めない

`style-src` には `'unsafe-inline'` を残しています。その場で書くスタイルが多いためです。
サーバで組んだ HTML の `style` 属性 (Svelte の `style:` と、観る画面の映像の箱などに直に書いたもの) と、
`+layout.svelte` の @font-face の `<style>`。属性のスタイルは nonce では通せず、hash で通すには
`'unsafe-hashes'` と1つずつの hash が要るので見合いません。データ放送のエンジンは
`element.style` (CSSOM) で書くので、これには頼っていません (CSSOM からの書き込みは CSP に掛からない)。

**CSS からできることは、スクリプトよりずっと少ない。** 見た目を変えることと、
上の `img-src` / `font-src` の範囲での読み込みまでです (外へは出られない)。denpa の DOM に
CSS で抜き出して困る秘密 (属性に入った鍵など) はありません。

**この「外へは出られない」は `img-src` / `font-src` を自分・data:・blob: に絞っているから**
成り立っています。外のサーバの画像や字を許すと、BML の CSS (属性セレクタ + `url()`) で
画面の中身を外へ送れるようになるので、そのときはスタイルも絞り直します。

### 増やすとき

新しく読み込み元を足したら (外のサーバの画像・iframe など) ここの表と `vite.config.ts` を一緒に
直します。止められたものは開発者ツールのコンソールに `Refused to …` と出ます。
E2E (`tests/e2e/35-csp.spec.ts`) は主な画面を回って違反が1つも出ないこと、
BML の `onclick` を押しても動かないことを見ています。
