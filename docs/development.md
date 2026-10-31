# 開発する

**ホストに bun は入れません。全部コンテナの中で動かします。**
実チューナーも B-CASカードも ffmpeg も要りません。

入口は [genkan](https://github.com/danything/genkan) (ホスト名でコンテナに振り分ける
リバースプロキシ)。ポートを公開しないので、他のプロジェクトとぶつかりません。先に1回だけ起こします。

```sh
curl -sf https://raw.githubusercontent.com/danything/genkan/main/init.sh | sh -s
```

```sh
docker compose up                           # 開発サーバ (http://denpa.localhost) + 偽エージェント (http://denpa-agent.localhost)
docker compose run --rm unit                # 単体テスト
docker compose run --rm e2e                 # E2E (Playwright)
docker compose run --rm unit bun run lint   # リント + フォーマット確認
docker compose run --rm unit bun run format # フォーマット適用
docker compose run --rm unit bun run check  # 型 (svelte-check)
```

リントは oxlint (`.oxlintrc.json`)、整形は `bun fmt` (`bunfig.toml` の `[fmt]`。bun 1.4.4 から)。
`package.json` に `fmt` という名前の script は置かない (`bun fmt` はその script を先に呼ぶ)。

依存を足したら `docker compose run --rm unit bun install` を一度回します
(`node_modules` は名前付きボリュームなので、イメージを作り直す必要はありません)。

ブラウザに配るデコーダ (`wasm/decoder.c`。Dockerfile の `mpeg2wasm` 段) はイメージの中で組むので、
変わったら `docker compose build e2e` で組み直します。古いままだと E2E は始める前に止まります (`tests/global-setup.ts`)。

手元だけの上書きは `compose.override.yml` に (Compose が自動で読む。コミットしない)。
`.env` は使いません。

## README の画像

`docs/images/` の画像は **偽の放送で撮ります** — 局も番組もロゴも映像も字幕も作り物
(`tests/fake/docs.ts`)。本物の放送・ロゴ・本番の画面は画像に出しません。
E2E と同じ一式 (denpa + 偽エージェント) を立て、ルール・予約・録画を入れてから撮り、静止画は WebP、動く画像は AVIF にして置きます。

```sh
docker compose run --rm docs                                          # 全部撮り直して docs/images へ
docker compose run --rm docs bun scripts/capture-docs.ts watch live   # 名前を挙げるとそのぶんだけ
```

手元で回せなければ Actions の **Screenshots** (`.github/workflows/screenshots.yml`) を手で走らせると、
撮った画像が artifact に上がります。

撮るイメージ (Dockerfile の `docs` 段) には、本番と同じ字が入っています — 画面の BIZ UDPゴシック
(OFL で配られているもの) と、放送の字の Denpa Font (denpa-font のリリースの woff2)。撮る条件 (1600×900・暗いテーマ・
ja-JP・Asia/Tokyo。動く画像も同じ広さで撮り、縮めずに 30fps で組む) は `scripts/capture-docs.ts` の頭に
あります。見た目を変えたら撮り直してください (古い画像は README を見て入れた人を迷わせます)。

## README の謝辞

「謝辞」の節のうち `<!-- thanks:start -->` と `<!-- thanks:end -->` の間は、マージされた PR の作者と
Issue・Discussion を立てた人を GitHub の履歴から並べたもので、`scripts/thanks.ts` が書きます (手で直さない)。
Actions の **Thanks** (`.github/workflows/thanks.yml`) が週に 1 回回し、変わっていれば image marks と同じく
PR を出して自分でマージします。急ぐときは Actions から手で走らせるか、手元で
`GH_TOKEN=$(gh auth token) bun run thanks` (コンテナの中で) を回して PR にします。
特別協賛と土台にしている仕事は印の外で、手で書きます。載せない人 (持ち主) は `EXCLUDE` にあります

## テストの方針

**E2E が主で、単体テストは純粋関数の境界条件だけ。** 偽エージェント・偽の通知先・偽の EPGStation・偽の EpgTimerSrv・
偽ffmpeg を立てて、予約から録画・CM検出・エンコード・保存先への配置・
視聴済み削除までを通します (`tests/fake/`)。偽エージェントの BS は1番組5秒 (地上波は30分) で、
録画完了まで待っても30秒です。

画面まわりの入口は [app.md](app.md#テスト)、置いてあるものの一覧は
[app.md](app.md#構成) にあります。

### 並べて流す

**ワーカーごとに denpa と偽エージェントと偽通知先と偽 EPGStation と偽 EpgTimerSrv を1式ずつ立てます** (`tests/stack.ts`)。
ポートも置き場もDBも別なので、同時に走るファイル同士は互いに見えません (12コアで 2分半 → 50秒)。

- ファイルの中は順番 (`fullyParallel: false`)。前のテストが作った予約や録画を次が当てにしてよい
- ファイルをまたいでは当てにできない。実体のある録画が要るテストは `recordOne()` で自分のぶんを録る
- アプリは開発サーバではなく組んだもの (`bun run build` → `adapter-bun`) をワーカーの数だけ
  動かす。開発サーバを4つ立てるより軽く、本番と同じ出力を試せる
- API へ直接投げるときは `Origin` を付ける。SvelteKit は Origin の無いフォーム形式の POST を
  別サイトからの送信として断る (3 からは Content-Type の無い POST/PUT/PATCH/DELETE も)。
  `tests/stack.ts` が付けている。`x-forwarded-proto` は付けない — 前段の無い平文の接続には
  server.js が `http` を入れるので、本番の `http://<IP>:3000` と同じ経路を試せる

**1台ではこれ以上縮みません。** 中身の合計は約3分で大半は偽の放送を待つ時間、
下限はいちばん長いファイル1本の時間です。

CI では5つに割って別のランナーに出し、3ワーカー×5台 = 15ワーカーぶん並べます。
組の中身は `tests/e2e/shards.json` で、実測の所要時間 (CI の結果に出る1本ずつの秒数) で人が割っています。
組ごとにテストの秒数の和がそろうように割り、長いファイルは組の頭のほうに来るように組みます
(組の中ではファイル名の順にワーカーへ配られるので、遅れて始まらずに済む)。組の時間の下限は、その組でいちばん長いファイル1本です。

- どの組にも入れていない新しいスペックは **5 組で流れます** (CI に注記が出る)。あとで所要時間を見て割り直してください
- shards.json にあるのにファイルが無い・2つの組に入っている、は CI の「組分けの検算」が落とします
- 組を増やしたら、test.yml の `shard` の並びと検算の組の名前、main の ruleset の必須チェックにも `e2e (n)` を足します

ワーカー数は**手元では CPU の数そのまま (下限2・上限6)、CI (`CI=1`。`docker compose run e2e` も
そう) では 3 で固定**です (4つ並べるとチューナー待ちで落ちる。実測は `playwright.config.ts` の頭)。
混み具合でごく稀にブラウザ側が落ちるので、1回だけやり直します (`retries: 1`)。

## DB の列を足す

テーブルの定義は **`src/lib/server/schema.ts` にしか無い** (drizzle)。行の型
(`Recording` など) もマイグレーションもそこから出る。.NET の EF Core と同じく、
書くのはオブジェクトだけ。

1. `schema.ts` の列を変える (足す・消す・型を変える)
2. `bun run db:generate` — 前回の snapshot との差分が `drizzle/` に SQL で出る。
   一緒にコミットする (CI が出し直して、増えていれば落とす)
3. 起動時に当たる (`db.ts` の `bootstrap`)。手で流すものは無い

読み書きは `orm()` (`db.ts`) から。`orm().select().from(recordings).where(eq(recordings.id, id)).get()`
のように書き、列の名前と型はそこで決まる。組み立てで書けないもの (相関サブクエリ・CASE)
は `sql` テンプレート (`sql<型>`) で列を名指しして挟む (例: `schema.ts` の `reservationState`)。
生の SQL の文字列に型を付けて返す関数は置かない。それはキャストで、型が嘘をつく元になる。

JSON で持つ列 (ジャンル・音声の構成・ルールの対象の局など) は `schema.ts` の
`json(名前, 読み取り関数)` で書く。読み書きのときに変換するので、使う側は `JSON.parse` を書かない。
読み取り関数は列ごとに書き、壊れた行は「持っていない」(空の並び・NULL) にする
(1行のせいで一覧ごと出なくなるのを避ける)。

## 型の締め方

`tsconfig.json` は `strict` に加えて `exactOptionalPropertyTypes` (省けるのと undefined を
入れてよいのは別)、`noPropertyAccessFromIndexSignature` (index signature のものは `[]` で読む)、
`noUncheckedIndexedAccess` (添字で読んだものは undefined かもしれない) を入れてある。

`noUncheckedIndexedAccess` の書き分け:

- **バイト列の読み** (`data[i]`、`packages/arib/src/` の PSI/EIT/字幕と `src/lib/ts/` の TS・mkv のパーサ) は、長さを確かめた
  上で `data[i]!`。1 バイトごとに undefined を見てもパーサのコードが二倍の長さになるだけ。
  確認が無いところに `!` を足さない
- **配列の先頭・regex の group・`split()` の結果** は undefined を見る (`?? ''`、
  `const [a = NaN] = ...`、`if (x === undefined) return`)。`[0]!` にしてよいのは、直前で
  空でないことを確かめている (`tests/e2e/helpers.ts` の `atLeastOne` のような) 場合だけ
- **試験** は `!` でよい。落ちれば試験が落ちる

外から来る JSON (チューナーエージェントの答え、OIDC の相手、取り込み元の DB) は
`res.json() as X` と書かず、`src/lib/shape.ts` の読み取り関数で形式を確かめてから型にする
(`tolerate(array(AGENT_CHANNEL), await res.json(), 'エージェントの PUT /denpa/channels')`。`tuner.ts`)。型は形式から
導く (`Infer<typeof AGENT_CHANNEL>`) ので、形式と型を別々に書かない。

読み方は 2 つ。`tolerate` は形式が違っても止めず、警告を 1 回出して来たものをそのまま使う
(エージェントの答え。バージョンがずれただけで録画が止まっては困る)。`read` は止める
(ID トークン。違う形式のまま進むと危ない)。迷ったら `tolerate`。自分のサーバから自分の画面へ
渡すもの (同じリポジトリの中) はキャストのままでよい。

**マイグレーションを持つ前の DB** (1.7.x まで。`CREATE TABLE IF NOT EXISTS` を起動のたびに
流していた) にも、最初のマイグレーション (baseline) が `IF NOT EXISTS` なのでそのまま当たる。1.7.x を一度も起動していない古い DB は列が足りないことがあり、起動時に
どの列かを言って止まる。その場合は 1.7.x を一度起動してから上げる。

## リリース

出す前に、この順で済ませます。

1. **矛盾と圧縮を点検して直す。** 前のリリースからの差分だけでなく、**毎回あらためて全体を**読みます。
   docs・CSS とそのコメント・コード (エージェントも) を通して、今のコードや [design.md](design.md) と食い違う説明を直し、
   使っていないもの・同じことを何か所にも書いたもの・回りくどい書き方を縮めます。範囲ごとに PR に分けて出します
2. **画面を変えたなら、docs の画像を撮り直す** ([上](#readme-の画像))。Actions の **Screenshots** を main で走らせ、
   artifact の `shots` を `docs/images/` に写して PR にします
3. main のイメージのビルドが通ったのを確かめて、リリースを作る:
   `gh release create vX.Y.Z --target main --generate-notes --title vX.Y.Z`。
   イメージは組み直さず、そのコミットのものにバージョンを貼り足します ([下](#イメージ))

### `@danything/arib` を出す

`packages/arib/` は denpa のリリースとは別に npm へ出します。`packages/arib/package.json` の `version` を上げる PR を
マージしてから、main のそのコミットにタグ `arib-v<バージョン>` を押します (`git tag arib-v0.2.0 <そのコミット> && git push origin arib-v0.2.0`)。
**main の先頭には付けないこと。** マージのあとに `chore: bump image marks [skip ci]` が積まれることが多く、`[skip ci]` のコミットに付けたタグでは Actions が動きません。
`.github/workflows/arib-publish.yml` がテストとビルドをして、Trusted Publishing で出します (トークンは持たない)。
リポジトリの中では `exports` が TypeScript のまま (`src/*.ts`) を指していて、出すときだけ `scripts/manifest.ts` が
組んだ `dist/` に向け直します

## イメージ

`Dockerfile` が denpa 本体、`agent/Dockerfile` がチューナー側です。
CI が両方をビルドして `deploy/` の印を書き戻します。**main は直接 push できない**
(ruleset の必須チェック `check` / `agent` / `e2e (1)`〜`(5)` / `claude-review`) ので、
書き戻しは bot が PR を出し、必須チェックの status を自分で付けてマージします
(手順と理由は `.github/bump-pr.sh`。release の Chart.yaml の書き戻しと README の謝辞の一覧も同じ)。
release は組み直さず、main で組んだイメージにバージョンを 1 層足します
(`.github/release.Dockerfile`。タグの決め方と理由は [architecture.md](architecture.md#イメージのタグ)、
出し方は `.github/image-tags.sh`)。

**イメージは amd64 と arm64 の2つ**で、同じタグに束ねてあります (理由と組み方は
[architecture.md](architecture.md#イメージのタグ))。Dockerfile は BuildKit の `TARGETARCH`
で配布物 (px4-userland / siano-ts) の名前と .NET の RID を読み替え、
Intel の QSV (libvpl・libmfx-gen・intel-media-va-driver) と AMD の VA-API ドライバは amd64 だけに入れます
(Debian の arm64 には QSV が無く、AMD の GPU を載せた arm の機械はまず無い)。Dockerfile やそこへ入るもの (`agent/`・`patches/`・依存) を
触った PR では、`Docker build check` が両方の arch を本物のランナーで組みます
(push はしない。必須チェックではない)。手元で arm64 を組むなら
`docker buildx build --platform linux/arm64 -f agent/Dockerfile .` (amd64 の機械では
QEMU が要り、ffmpeg や AOT はかなり遅い)。

エージェントの API に当てる適合テストは `agent/conformance.test.ts` ([app.md](app.md) のテストの表)。

### イメージの土台は distroless

**本体もエージェントも土台は distroless** (本体は libssl の無い `gcr.io/distroless/base-nossl-debian13`、エージェントは `gcr.io/distroless/cc-debian13`) で、シェルも apt も
coreutils もありません。どちらも root で動きます。本体の ffmpeg が使うライブラリ
(libva・Intel と AMD の VA-API ドライバ・QSV のランタイムなど) は、Dockerfile の `runtime-libs` 段で
Debian のパッケージを入れてから要るファイルだけを写しています (dlopen で読むドライバはディレクトリごと)。
足りないものが無いかは `.github/image-smoke.sh` が ld.so に依存を解かせて確かめます。

denpa が起こすのは ffmpeg / ffprobe だけで、シェルを通しません (denpa-aio の入口・Helm の prepull も bun で動かす)。実行ファイルを直に呼ぶことはできます
(`kubectl exec deploy/denpa -- ffmpeg -hide_banner -hwaccels`、`kubectl exec deploy/tuner-agent -- denpa-agent --tune …`)。
コンテナの中を見たいときは、`kubectl debug -it <Pod> --image=busybox --target=denpa`
(エージェントは `--target=tuner-agent`。Docker なら `docker run --rm -it --pid=container:<名前> --network=container:<名前> busybox` で、
中のファイルは `/proc/1/root/` の下) のようにシェルのあるコンテナを横に付けます。

### 外から持ってくるものはバージョンで固定する

ffmpeg・SVT-AV1・emsdk・Denpa Font・px4-userland / siano-userland / asicen-userland は、どれも
`ARG` / `ENV` にバージョン (タグかコミット) を書いてから取ってきます。同じコミットからビルドすれば同じ中身になります。
バージョンの無い PLEX のドライバの zip (IT930x のファームウェアを切り出す元) はイメージに入れず、エージェントが使う人の
機械で取ってきます。取ったものの SHA-256 を確かめ、中身が変わっていれば使いません (`Px4Firmware.cs`)。

**土台のイメージと GitHub Actions は digest で留めます。** Dockerfile の `FROM`・`COPY --from=` は
`名前:タグ@sha256:…`、ワークフローの `uses:` は `@<コミットの SHA> # vX.Y.Z` の形にします。
タグは同じ名前のまま中身が差し替わることがあるので、タグだけでは同じ中身になりません。

上げるのは Renovate 任せで、`# renovate:` の注釈と `renovate.json` の `customManagers` で
場所を教えてあります。タグのあるものはタグで、無いものはブランチの先頭のコミット (`git-refs`) で追います。
digest もタグと一緒に Renovate が上げ、タグだけで足した土台やアクションには digest を足す PR を出します (`renovate.json` の `pinDigests`)。
`renovate.json` の書き方は `docker compose run --rm unit bunx --package renovate renovate-config-validator` で確かめます。

文書の一覧は [README](../README.md#もっと詳しく) に。画面・docs・コメントの言葉の決まりは [writing.md](writing.md)。
