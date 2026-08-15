# 誰を通すか

**口によって守り方が違います。** 画面は人が見るもので、録画のファイルは
プレイヤー (テレビの VLC など) が取りに来るもの。同じ守り方はできません。

| 探しもの | 見る場所 |
| --- | --- |
| 全体像 | [architecture.md](architecture.md) |
| 環境変数の一覧 | [app.md](app.md) |
| ホーム画面に置く | [player.md](player.md) |

| 口 | 守り方 |
| --- | --- |
| `/api/recordings/<id>/file` | **期限付きのリンク** (`?token=…`、`share.ts`。控えは `share_links`)。OIDC で入った画面のぶんは**ログインの控えも受ける** |
| `/api/live/socket` | **使い捨ての札** (下記)。ここだけ SvelteKit に届きません |
| それ以外 (画面と API) | **OIDC** (設定してあれば) |
| どの口も | **`TRUSTED_NETWORKS` に当たれば素通し** (下記) |
| `/login` `/login/callback` `/login/out` `/logout` | 素通し |
| `/api/health` | 素通し |
| `/manifest.webmanifest` | 素通し |

**OIDC も `TRUSTED_NETWORKS` も設定していなければ、全部断ります** (403、
理由を本文に書いて返す)。ベーシック認証は廃止しました — パスワードを使っていた
場面 (プレイヤー登録・ダウンロードURL) が全部署名リンクに置き換わり、残っていたのは
「画面に出して覚えさせるパスワード」だけでした。全部開けたいなら
`TRUSTED_NETWORKS=0.0.0.0/0` です (公開時の注意は README)。

**`/api/live/socket` だけは前段の `Bun.serve` が受けます** (`server.js`)。bun の
`node:http` では WebSocket の握手ができないためで、SvelteKit の `hooks.server.ts` には
届かない = **ここに書いてある守り方が効きません**。

**ブラウザは WebSocket の握手に `Authorization` を付けてくれない**ので、画面が先に
`POST /api/live/ticket` で**使い捨ての札**を取り、URL に付けて繋ぎます。**札の発行は
普通の HTTP** なので、OIDC も信頼したネットワークもそのまま効きます。1回使ったら
消し、寿命は30秒 (`src/lib/server/tickets.ts`、詳しくは [stream.md](stream.md#繋ぐときの認証))。

**`/api/health` を守ると Pod が再起動を繰り返します。** Kubernetes の `livenessProbe`
が叩く口で、掛ける範囲を選べるのをやめたときに実際に踏みました
(E2E のスタックが起動待ちで固まって気付いた)。出しているのは「生きているか・局が何件か・
録画が何本か」だけです。

**`/manifest.webmanifest` を守るとホーム画面の名前が付きません。** ブラウザは
マニフェストを**資格情報を付けずに**取りに来るので、掛けると 401 で落ちます。
中身は表示名と色だけです ([player.md](player.md#ホーム画面に置く))。

**プレイヤーはリダイレクトを扱えません。** ログイン画面へ
飛ばされたところで何もできず「再生できません」で終わります。だからファイルを取りに
来る口は、ログインではなく **URL そのものが資格になる期限付きリンク**で開けます —
「テレビで再生」も「再生リンクをコピー」もダウンロードも、押した瞬間に
24時間で切れるリンクを作って渡します (`share.ts`)。

**1録画につき現役のリンクは1本**で、控えをDB (`share_links`) に持ちます。
期限内にもう一度押すと、同じURLのまま期限だけ延びる — テレビの履歴に残った
URLが、使い続けているかぎり切れません。全部を今すぐ切りたければ
`share_links` の行を消します。

### ファイルの口は、ログインの控えも受ける

**録画をブラウザで観るようになったので、`<video>` が同じ口を取りに来ます**
([library.md](library.md#観るのはブラウザで))。`<video>` の再生には署名リンクを
使わない (画面はログイン済みなので要らない) ため、ログインの控えをここでも
受けます (`auth.sessionMayRead`)。通る相手が増えるわけではありません —
「この denpa に入れる人」のままです。

## 入る道が無ければ、全部断る

**何も設定しないまま立てると、すべてのアクセスを 403 で断ります** (fail-closed)。
起動ログに1度だけ案内を出します。

```text
[boot] 入る道が設定されていないため、すべてのアクセスを断ります。
       OIDC (docs/auth.md) か TRUSTED_NETWORKS (CIDR のカンマ区切り) を設定してください。
       すべて開けるなら TRUSTED_NETWORKS=0.0.0.0/0 (公開時の注意は README)
```

以前はベーシック認証を起動時に自動生成して掛けていました。廃止した理由:

- **パスワードを使う場面が消えました。** プレイヤーへの登録は再生リンク、
  ダウンロードも署名リンクになり、資格情報を手で入れる口が残っていません
- **受け取り損ねると詰みます。** 自動生成のパスワードは起動ログでしか受け取れず、
  流してしまうとDBから直に読むしかありませんでした
- **閉じていることが分かる**ようになりました。自動で掛かる形は「掛かっているが
  入れない」と「設定を忘れた」の区別が付きませんでした

## OIDC でのログイン

**3つ揃ったときだけ有効**になります。揃っていなければ、入る道は
`TRUSTED_NETWORKS` だけです。

| 変数 | |
| --- | --- |
| `OIDC_ISSUER` | 例 `https://login.microsoftonline.com/<tenant>/v2.0` |
| `OIDC_CLIENT_ID` | アプリ登録のアプリケーションID |
| `OIDC_CLIENT_SECRET` | クライアントシークレット |
| `OIDC_GROUP` | **このグループに居る人だけ通す。** 空なら入れた人は全員 |
| `TRUSTED_NETWORKS` | **何も聞かずに通すネットワーク** (例 `10.10.0.0/16`)。下記 |
| `OIDC_SESSION_TTL` | ログインの有効期間(ms)。既定30日 |

**秘密を含むので環境変数だけから読み、設定画面には出しません。**

> **scheme は `x-forwarded-proto` から読みます** (`server.js` が常に設定する。
> 選べるオプションではなくなりました)。戻ってくる口の住所も、控えの Cookie に
> `Secure` を付けるかどうかも、リクエストの scheme から決めています。

### ライブラリを入れていません

使う口は discovery・authorize・token・jwks の4つだけで、どれも素の HTTP と
WebCrypto で足ります。認証まわりで「中で何をしているか分からない」を抱えるより、
200行書くほうを選びました (`src/lib/server/oidc.ts`)。

使っているのは OIDC の標準だけなので、Keycloak でも Google でも同じはずです
(**実機で当てたのは Entra ID だけ**)。

- **認可コードフロー + PKCE (S256)**。`state` と `nonce` も使います
- **ID トークンは署名まで見ます。** 認可コードフローでは TLS 越しに相手から直に
  受け取るので仕様上は省けますが (OIDC Core 3.1.3.7)、省くと安全が
  「トークンをどこから受け取ったか」に乗ります。WebCrypto で数行です
- **受ける署名方式は RS256 だけ。** `alg: none` を受けると署名を見ない道ができます
- 発行元・宛先・期限・合言葉 (`nonce`) を確かめます。時計のずれは60秒まで許します

### グループで決める

**誰がログインしたかでは決めません。** 人が増えても denpa 側を触らずに済みます。

Entra ID でグループを載せるには、**アプリ登録の「トークン構成」で
`groupMembershipClaims` を有効に**してください。既定で載るのは
**グループのオブジェクトID (GUID)** なので、`OIDC_GROUP` にもそれを書きます。

```sh
OIDC_GROUP=6f1b2c3d-4e5f-6789-abcd-ef0123456789
```

断るときは理由を画面に出します。**黙って弾くと「なぜか自分だけ入れない」になる**ためです。

| 出るもの | 意味 |
| --- | --- |
| `... のグループに入っていません` | そのとおり |
| `ID トークンに groups がありません` | `groupMembershipClaims` がまだ無効 |
| `グループが多すぎて ID トークンに載っていません` | Entra が `groups` の代わりに `_claim_names` を返した。グループを減らすか、`OIDC_GROUP` を空にして Entra 側のアプリ割り当てで決める |

## ネットワークの中なら、何も聞かない

**`TRUSTED_NETWORKS` に当たると、OIDC も掛かりません。**
LAN のプレイヤー (テレビの VLC) に資格情報を入れずにファイルを取らせるためのものです。

```sh
TRUSTED_NETWORKS=10.10.0.0/16
# いくつでも並べられる
TRUSTED_NETWORKS=10.10.0.0/16,10.20.0.0/16,192.168.1.5
# 全部開ける (家の中だけで完結する構成向け。公開時の注意は README)
TRUSTED_NETWORKS=0.0.0.0/0
```

**見るのは住所だけです。どの名前で来たかは問いません** — LAN から外向きの
`dp.doany.io` を開いても、そのまま通ります。前段 (Traefik の IngressRoute、
chart の `traefik.enabled`) は2つの名前を同じ Rule で denpa に届けるだけで、
名前ごとに何かを分けてはいません。LAN 用の名前 `dp.l.doany.io` が家の中でだけ
引けるのは DNS の側の話です ([player.md](player.md))。

> **`ADDRESS_HEADER=x-forwarded-for` を一緒に渡すこと。** 渡さないと adapter-node は
> 接続元として Traefik の Pod の住所を返すので、住所の側が誰にも当たりません
> (=全員が認証を求められます)。逆に、denpa へ直に届く経路があるとヘッダを
> 詐称できます — Pod が Service 経由でしか触れないことが前提です。
>
> **読めなかったときは通しません。** 分からないほうを通すと、ヘッダを外すだけで
> 認証を抜けられてしまいます。

ネットワークの書き方は IPv4 の CIDR (`10.10.0.0/16`) か住所そのまま。
**IPv6 は書いたとおりに一致したときだけ**通します (前置き長での判定は入れていません)。

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
2. **リダイレクト URI** を「Web」で登録する。**denpa の名前ごとに1つずつ**要ります
   (`https://dp.doany.io/login/callback` と `https://dp.l.doany.io/login/callback`)
3. **クライアントシークレット**を作る
4. **トークン構成**で `groupMembershipClaims` を有効にする (グループで絞るなら)

> **リダイレクト URI は authorize を叩いても確かめられません。** 未登録の URI でも
> Entra はまずログイン画面を返し、**認証が済んでから** `AADSTS50011` を出します
> (出鱈目な URI を対照にして確認済み)。**登録してあることは Azure の画面で見るしか
> ありません。**

#### この構成で実際に使っている値

**oauth2-proxy (`auth` 名前空間) と同じアプリ登録を使い回しています。** テナントも
グループも同じなので、入れる人の集合は forward-auth のときと変わりません。

値は **`denpa` 名前空間の Secret `denpa-oidc`** に入っていて、chart はその名前
(`denpa.oidcSecretName`、この家の値は `k3s/application.yaml` の `helm.valuesObject`) を `secretKeyRef` で引くだけです。

| 鍵 | 何 |
| --- | --- |
| `issuer` | `OAUTH2_PROXY_OIDC_ISSUER_URL` と同じ |
| `client-id` | `OAUTH2_PROXY_CLIENT_ID` と同じ |
| `client-secret` | `auth/auth-secrets` の `oidc-client-secret` を写したもの |
| `group` | `OAUTH2_PROXY_ALLOWED_GROUPS` と同じ |

#### 封をして git に置いてあります

**`k3s/oidc-sealed.yaml` は SealedSecret です。** クラスタの中の鍵でしか開けないので、
公開リポジトリに置いても中身は読めません。`kube-system` の
`sealed-secrets-controller` がこれを見て Secret `denpa-oidc` を作ります。

そうする理由は、**手で作った Secret がどこにも書かれていない状態を無くす**ためです。
クラスタを立て直したら、他は全部 ArgoCD が git から戻すのに、これだけ手順を
思い出して打ち直すことになります。

**名前と名前空間を変えると開けなくなります** (既定の scope が `denpa/denpa-oidc` を
鍵の一部にしているため)。移すときは封をし直します。

作り直すときは `~/bootstrap/kubeseal.sh` に通します。

```sh
umask 077
cat > /tmp/oidc.yaml <<'YAML'
apiVersion: v1
kind: Secret
metadata: { name: denpa-oidc, namespace: denpa }
type: Opaque
stringData:
  issuer: "..."
  client-id: "..."
  client-secret: "..."
  group: "..."
YAML
~/bootstrap/kubeseal.sh /tmp/oidc.yaml k3s/oidc-sealed.yaml && rm /tmp/oidc.yaml
```

**平文の Secret が先にあると、controller は上書きしません。** 自分が作ったもので
なければ触らない作りです。引き取らせるには印を付けます (この構成では実施済み)。

```sh
kubectl -n denpa annotate secret denpa-oidc sealedsecrets.bitnami.com/managed=true
```

> **グループが載ってくるかは、入ってみるまで分かりません。** oauth2-proxy が
> `ALLOWED_GROUPS` で絞れている以上、載っている見込みは高いのですが、あちらは
> 載っていなければ Graph に聞きに行く作りなので**証拠にはなりません**。
> 載っていなければ denpa は理由を出して断るので、そこで分かります
> (「ID トークンに groups がありません」)。

### 前段の forward-auth は外しました

IngressRoute から `forward-auth` と `forward-auth-errors` (oauth2-proxy) を
落としてあります (いまは chart の `charts/denpa/templates/ingress.yaml`)。denpa が自分でログインさせるので、前段に置く理由がなくなりました。

**順番が大事です。** 「denpa 側を設定 → **実機で入れることを確かめる** → ingress から
外す」。先に外すと、OIDC の設定を間違えていたときに*誰も入れない*ではなく
**誰でも入れる**状態になります。

外したことで、`dp.doany.io` のルートは1つに戻りました。2つに割れていたのは
「配信だけ forward-auth を通さない」ためで、その仕分けは
いま denpa 側 (`auth.ts`) がやっています。

> **oauth2-proxy 自体は残っています。** 同じアプリ登録を他のもの (Mattermost など)
> も使っているので、`auth` 名前空間には手を触れていません。
