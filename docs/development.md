# 開発する

**ホストに bun は入れません。全部コンテナの中で動かします。**
実チューナーも B-CAS カードも ffmpeg も要りません。

入口は [genkan](https://github.com/danything/genkan) (ホスト名でコンテナに振り分ける
リバースプロキシ)。ポートを公開しないので、他のプロジェクトとぶつかりません。先に 1 回だけ起こします。

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

`docs/images/` の画像は **偽の放送で撮ります。** 局も番組もロゴも映像も字幕も作り物です
(`tests/fake/docs.ts`)。本物の放送・ロゴ・本番の画面は画像に出しません。
E2E と同じ一式 (denpa + 偽エージェント) を立て、ルール・予約・録画を入れてから撮り、静止画は WebP、動く画像は AVIF にして置きます。

```sh
docker compose run --rm docs                                          # 全部撮り直して docs/images へ
docker compose run --rm docs bun scripts/capture-docs.ts watch live   # 名前を挙げるとそのぶんだけ
```

手元で回せなければ Actions の **Screenshots** (`.github/workflows/screenshots.yml`) を手で走らせると、
撮った画像が artifact に上がります。

撮るイメージ (Dockerfile の `docs` 段) には、本番と同じ字が入っています。画面の BIZ UDPゴシック
(OFL で配られているもの) と、放送の字の Denpa Font (denpa-font のリリースの woff2)。撮る条件 (1600×900・暗いテーマ・
ja-JP・Asia/Tokyo。動く画像も同じ広さで撮り、縮めずに 30fps で組む) は `scripts/capture-docs.ts` の冒頭に
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
偽 ffmpeg を立てて、予約から録画・CM 検出・エンコード・保存先への配置・
視聴済み削除までを通します (`tests/fake/`)。偽エージェントの BS は 1 番組 5 秒 (地上波は 30 分) で、
録画完了まで待っても 30 秒です。

単体テスト (`bun run test:unit`) は `bun test --isolate` で、**ファイルごとに新しいグローバルで動かします。**
前のファイルで始めた処理や差し替えた `config` が、次のファイルに届きません。
そのぶん、DB や録画の置き場に触るテストは、それぞれのファイルで `config` を一時ディレクトリに向けます。

画面まわりの入口は [app.md](app.md#テスト)、置いてあるものの一覧は
[app.md](app.md#構成) にあります。

### 並べて流す

**ワーカーごとに denpa と偽エージェントと偽通知先と偽 EPGStation と偽 EpgTimerSrv を 1 式ずつ立てます** (`tests/stack.ts`)。
ポートも置き場も DB も別なので、同時に走るファイル同士は互いに見えません (12 コアで 2 分半 → 50 秒)。

- ファイルの中は順番 (`fullyParallel: false`)。前のテストが作った予約や録画を次が当てにしてよい
- ファイルをまたいでは当てにできない。実体のある録画が要るテストは `recordOne()` で自分のぶんを録る
- アプリは開発サーバではなく組んだもの (`bun run build` → `adapter-bun`) をワーカーの数だけ
  動かす。開発サーバを 4 つ立てるより軽く、本番と同じ出力を試せる
- API へ直接投げるときは `Origin` を付ける。SvelteKit は Origin の無いフォーム形式の POST を
  別サイトからの送信として断る (3 からは Content-Type の無い POST/PUT/PATCH/DELETE も)。
  `tests/stack.ts` が付けている。`x-forwarded-proto` は付けない。前段の無い平文の接続には
  server.js が `http` を入れるので、本番の `http://<IP>:3000` と同じ経路を試せる

**1 台ではこれ以上縮みません。** 中身の合計は約 3 分で大半は偽の放送を待つ時間、
下限はいちばん長いファイル 1 本の時間です。

CI では 10 組に割って別のランナーに出し、3 ワーカー×8 台と 1 ワーカー×2 台の 10 組 (下) で 26 ワーカーぶん並べます。
組の中身は `tests/e2e/shards.json` で、実測の所要時間 (CI の結果に出る 1 本ずつの秒数) で人が割っています。
組ごとにテストの秒数の和がそろうように割り、長いファイルは組の先頭のほうに来るように組みます
(組の中ではファイル名の順にワーカーへ配られるので、遅れて始まらずに済む)。組の時間の下限は、その組でいちばん長いファイル 1 本です。

- 映像を長くデコードし続けるスペック (20-live・22-watch・互換モードのものなど。一覧は shards.json の注記) は 1 つの組に 3 本までにします。混むとどれも遅くなります
- 名前が後ろの長いスペック (57-jikkyo など) は、前に並ぶスペックが少ない組に置きます。
  前のスペックがワーカーを埋めていると遅れて始まり、組がそのぶん長くなります
- 9 組と 10 組は、ライブの貯め方 (50-live-pacing・51-live-gaps) を 1 本ずつ 1 ワーカーで流します (test.yml)。同じ組でほかのワーカーが動くと
  届く間隔が乱れ、貯める量がその間隔を覆う高さ (`pacing.ts` の `cover`) へ上がって、「下限のまま」を見るテストが落ちるためです
  (軽いスペックと組ませても 5 回に 2 回落ちた)。デコードが重なると、途中から入ったときにコマも落とします。
  1 ワーカーなので、ほかのスペックを足すとそのぶん組が長くなります。2 本を 1 つの組で順に流すと 2 分を超えるので、組を分けています
- 1 本で長いスペックは、組の時間の下限を押し上げるので分けます (57-jikkyo-recorded・26-hwenc-hevc・20-live-player はそうして分けたもの)。
  20-live はテストが細かく多く、1 本で CI の 2.4 分かかっていたので、選局・一覧・データ放送 (20-live) と
  操作バーから先 (20-live-player) の 2 本に分けました。どちらも 1 分強です。
  いまいちばん長いのは 57-jikkyo (CI で 2 分ほど) で、20-live-player・22-watch (100 秒ほど)、03-recording (90 秒ほど) が続きます。
  57-jikkyo の組は、この 1 本で 2 分を超えます。57-jikkyo・22-watch・03-recording は 1 組に集めて 1 ワーカーに 1 本ずつ流し、ほかのスペックを足しません (足すと、どれかの後ろに並んで組が延びる)
- 組の時間は、組の秒数の和を 3 で割った値と、長いファイルが始まる時刻にその長さを足した値の、大きいほうで決まります。
  割り直すときは、ファイル名の順に空いたワーカーへ配って両方を見積もります
- 実時間を待つテストは、確かめる性質が出る最短の尺で見ます。51-live-gaps は空きを 3 回 (縮めにかかる 20 秒より長い間隔で)、
  50-live-pacing は 20 秒、録画を待つテストはすぐ次の番組 (`reserveSoon` の `skip` を付けない) を録ります
- どの組にも入れていない新しいスペックは **5 組で流れます** (CI に注記が出る)。あとで所要時間を見て割り直してください
- shards.json にあるのにファイルが無い・2 つの組に入っている、は CI の「組分けの検算」が落とします
- 組を増やしたら、test.yml の `shard` の並びと検算の組の名前、main の ruleset の必須チェックにも `e2e (n)` を足します

ワーカー数は**手元では CPU の数そのまま (下限 2・上限 6)、CI (`CI=1`。`docker compose run e2e` も
そう) では 3 で固定**です (4 つ並べるとチューナー待ちで落ちる。実測は `playwright.config.ts` の冒頭)。
混み具合でごく稀にブラウザ側が落ちるので、1 回だけやり直します (`retries: 1`)。

## CI

**PR の CI は、触ったファイルに関係するジョブだけ中身を回します。** main への push では全部回します。
PR で飛ばしたものが main で赤くなったら、見て直します。

main は ruleset の必須チェックで守ってあります。`check`・`agent`・`agent-asicen-mock`・`install-linux`・`talos`・
`agent-windows`・`agent-windows-install`・`agent-macos`・`e2e (1)`〜`(10)`・`claude-review` と、CodeQL の
`codeql / Analyze (actions・c-cpp・csharp・javascript-typescript)` です。確かめるには `gh api repos/danything/denpa/rules/branches/main`。

### 中身を回すジョブを決める

**関係ないジョブは、ジョブごと飛ばします。** ジョブの `if` で飛ばしたジョブは、必須チェックでも成功として数えられ、ランナーを使いません。

- 決めるのは `.github/ci-changes.sh` です。PR の触ったファイルを GitHub の API から読み、下の組ごとに回すかを出します

  | 組      | ジョブ                                                                           | 回すとき                                                                                      |
  | ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
  | e2e     | `e2e (1)`〜`(10)`                                                                | エージェント・通知領域のアプリ・文書・入れ方・配備のほかを触ったとき                          |
  | windows | `agent-windows`・`agent-windows-install`                                         | `agent/`・`tray/Denpa.Tray*`・`install.ps1`・`scripts/build-wdi-simple.ps1`                   |
  | macos   | `agent-macos`・`tray-macos`                                                      | `agent/`・`tray/mac/`・`install.sh`                                                           |
  | android | `agent-android`                                                                  | `agent/` と、android.yml・Android で組む部品                                                  |
  | bundle  | `server-windows-bundle`・`server-windows`・`server-macos-bundle`・`server-macos` | 配布物の組み方・ffmpeg・入れ方・`tests/native-*`・依存と、OS ごとに扱いが違うサーバのファイル |

- test.yml・ci-changes.sh・global.json を触ったときは全部回します。bundle を回すときは windows と macos も回します (配布物を確かめるジョブが、そちらで組んだエージェントを使う)
- 回したか飛ばしたかは `changes` ジョブの Summary に出ます。`changes` が落ちたときも、必須チェックのジョブは回します
- e2e だけはジョブを走らせ、`changes` を待たずにそれぞれのジョブの最初の段で決めて、中身の段を飛ばします。E2E がいちばん長いので、始まりを遅らせないためです
- CodeQL の C# の解析は、PR が `agent/`・`tray/`・C# のファイル・global.json を触っていなければ飛ばします (codeql.yml の `language-paths`。中身は 5ym/repo-config の共有の workflow)。
  matrix の 1 つだけはジョブの `if` で飛ばせないので、ジョブは走らせて解析の段を飛ばします。main への push と週 1 回の実行では全部解析します
- `check`・`agent`・`agent-asicen-mock`・`install-linux`・`talos` はいつも回します。どれも ubuntu のランナーで 2 分かかりません
- ジョブが読むファイルを足したら、ci-changes.sh の一覧にも足します。足さないと、そのファイルだけを触った PR でジョブの中身が回りません

### キャッシュ

**キャッシュの鍵は、中身を決めるものだけから作ります。** バージョン・csproj・組むスクリプトが変わったときだけ外れます。

- .NET の SDK と NuGet は別のキャッシュに置き、置くのは main だけです。PR が置いたキャッシュはその PR でしか使えません。
  前は PR ごとに SDK と NuGet を合わせて 840MB 置いていて、リポジトリの上限 (10GB) を超えるたびに、ffmpeg や Playwright のキャッシュが古いものから消されていました
- csproj を変えた PR は main の前の NuGet を戻し、足りないぶんだけを取ります (`restore-keys`)
- ffmpeg (Windows・Mac) の鍵は、Dockerfile の ffmpeg 段と組むスクリプトから作ります。そこを変えた PR と、それが main に入った直後の 1 回は組み直します (Windows で 15 分ほど)
- wdi-simple の鍵は、組むスクリプトとランナーのイメージのバージョンです。イメージが上がるたびに組み直し、新しい MSVC で組めるかを見ます。置くのは main だけです

## DB の列を足す

テーブルの定義は **`src/lib/server/schema.ts` にしか無い** (drizzle)。行の型
(`Recording` など) もマイグレーションもそこから出る。.NET の EF Core と同じく、
書くのはオブジェクトだけ。

1. `schema.ts` の列を変える (足す・消す・型を変える)
2. `bun run db:generate` で、前回の snapshot との差分が `drizzle/` に SQL で出る。
   一緒にコミットする (CI が出し直して、増えていれば落とす)
3. 起動時に当たる (`db.ts` の `bootstrap`)。手で流すものは無い

読み書きは `orm()` (`db.ts`) から。`orm().select().from(recordings).where(eq(recordings.id, id)).get()`
のように書き、列の名前と型はそこで決まる。組み立てで書けないもの (相関サブクエリ・CASE)
は `sql` テンプレート (`sql<型>`) で列を名指しして挟む (例: `schema.ts` の `reservationState`)。
生の SQL の文字列に型を付けて返す関数は置かない。それはキャストで、型が嘘をつく元になる。

JSON で持つ列 (ジャンル・音声の構成・ルールの対象の局など) は `schema.ts` の
`json(名前, 読み取り関数)` で書く。読み書きのときに変換するので、使う側は `JSON.parse` を書かない。
読み取り関数は列ごとに書き、壊れた行は「持っていない」(空の並び・NULL) にする
(1 行のせいで一覧ごと出なくなるのを避ける)。

## 型の締め方

`tsconfig.json` は `strict` に加えて `exactOptionalPropertyTypes` (省けるのと undefined を
入れてよいのは別)、`noPropertyAccessFromIndexSignature` (index signature のものは `[]` で読む)、
`noUncheckedIndexedAccess` (添字で読んだものは undefined かもしれない) を入れてある。

`noUncheckedIndexedAccess` は次のように書き分ける。

- **バイト列の読み** (`data[i]`、`packages/arib/src/` の PSI/EIT/字幕と `src/lib/ts/` の TS・mkv のパーサ) は、長さを確かめた
  上で `data[i]!`。1 バイトごとに undefined を見てもパーサのコードが二倍の長さになるだけ。
  確認が無いところに `!` を足さない
- **配列の先頭・regex の group・`split()` の結果** は undefined を見る (`?? ''`、
  `const [a = NaN] = ...`、`if (x === undefined) return`)。`[0]!` にしてよいのは、直前で
  空でないことを確かめている (`tests/e2e/helpers.ts` の `atLeastOne` のような) 場合だけ
- **テスト** は `!` でよい。外れればテストが落ちる

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
3. **`packages/arib/` が変わっていれば、その `version` を上げる** ([下](#danythingarib-を出す))。リリースといっしょに npm へ出ます
4. main のイメージのビルドが通ったのを確かめて、次のコマンドでリリースを作る。
   `gh release create vX.Y.Z --target main --generate-notes --title vX.Y.Z`。
   イメージは組み直さず、そのコミットのものにバージョンを貼り足します ([下](#イメージ))

### `@danything/arib` を出す

`packages/arib/` はふだん denpa のリリースといっしょに npm へ出ます。前のタグ `arib-v*` から `packages/arib/` が
変わっていれば、`.github/workflows/arib-publish.yml` が `packages/arib/package.json` の `version` で出して、
リリースのコミットにタグ `arib-v<バージョン>` を付けます。変わっていなければ何もしません。
上げる `version` は、互換が壊れるなら major、機能を足したなら minor、直しだけなら patch。
上げ忘れるとリリースのときにこの workflow が止まります (勝手には上げない)。

リリースを待たずに出すときは、`version` を上げる PR をマージしてから、main のそのコミットにタグを押します
(`git tag arib-v1.0.1 <そのコミット> && git push origin arib-v1.0.1`)。
**main の先頭には付けないこと。** マージのあとに `chore: bump image marks [skip ci]` が積まれることが多く、`[skip ci]` のコミットに付けたタグでは Actions が動きません。
どちらもテストとビルドをしてから、Trusted Publishing (トークンは持たない) で **npm にステージまで置きます**。
公開されるのは、npmjs.com のパッケージの画面 (または `npm stage approve <id>`) で確定したときです (2FA が要る)。
乗っ取られた workflow から勝手に公開されないよう、npm 側ではこの workflow に `npm stage publish` だけを許しています。
ステージに置いた時点で `arib-v<バージョン>` のタグが付くので、確定せずに却下したら、次は `version` を上げて出し直します。
リポジトリの中では `exports` が TypeScript のまま (`src/*.ts`) を指していて、出すときだけ `packages/arib/scripts/manifest.ts` が
組んだ `dist/` に向け直します

## イメージ

`Dockerfile` が denpa 本体、`agent/Dockerfile` がチューナー側です。
CI が両方をビルドして `deploy/` の印を書き戻します。**main は直接 push できない**
(ruleset の必須チェック。[CI](#ci)) ので、
書き戻しは bot が PR を出し、必須チェックの status を自分で付けてマージします
(手順と理由は `.github/bump-pr.sh`。release の Chart.yaml の書き戻しと README の謝辞の一覧も同じ)。
release は組み直さず、main で組んだイメージにバージョンを 1 層足します
(`.github/release.Dockerfile`。タグの決め方と理由は [architecture.md](architecture.md#イメージのタグ)、
出し方は `.github/image-tags.sh`)。

**イメージは amd64 と arm64 の 2 つ**で、同じタグに束ねてあります (理由と組み方は
[architecture.md](architecture.md#イメージのタグ))。Dockerfile は BuildKit の `TARGETARCH`
で配布物 (asicen-userland) の名前と .NET の RID を読み替え、
Intel と AMD の VA-API ドライバは amd64 だけに入れます
(Debian の arm64 には Intel のドライバが無く、AMD の GPU を載せた arm の機械はまず無い)。Dockerfile やそこへ入るもの (`agent/`・`patches/`・依存) を
触った PR では、`Docker build check` が両方の arch を本物のランナーで組みます
(push はしない。必須チェックではない)。手元で arm64 を組むなら
`docker buildx build --platform linux/arm64 -f agent/Dockerfile .` (amd64 の機械では
QEMU が要り、ffmpeg や AOT はかなり遅い)。

エージェントの API に当てる適合テストは `agent/conformance.test.ts` ([app.md](app.md) のテストの表)。

### イメージの土台は distroless

**本体もエージェントも土台は distroless** (本体は libssl の無い `gcr.io/distroless/base-nossl-debian13`、エージェントは `gcr.io/distroless/cc-debian13`) で、シェルも apt も
coreutils もありません。どちらも root で動きます。本体の ffmpeg が使うライブラリ
(libva・Intel と AMD の VA-API ドライバなど) は、Dockerfile の `runtime-libs` 段で
Debian のパッケージを入れてから要るファイルだけを写しています (dlopen で読むドライバはディレクトリごと)。
足りないものが無いかは `.github/image-smoke.sh` が ld.so に依存を解決させて確かめます。

denpa が起こすのは ffmpeg / ffprobe だけで、シェルを通しません (denpa-aio の入口・Helm の prepull も bun で動かす)。実行ファイルを直に呼ぶことはできます
(`kubectl exec deploy/denpa -- ffmpeg -hide_banner -hwaccels`、`kubectl exec deploy/tuner-agent -- denpa-agent --tune …`)。
コンテナの中を見たいときは、シェルのあるコンテナを横に付けます (手順は [install.md](install.md#うまくいかないとき)。エージェントは `--target=tuner-agent`)。

### 外から持ってくるものはバージョンで固定する

ffmpeg・SVT-AV1・emsdk・Denpa Font・asicen-userland は、どれも
`ARG` / `ENV` にバージョン (タグかコミット) を書いてから取ってきます。同じコミットからビルドすれば同じ中身になります。
Android 向けのエージェントに入れる OpenSSL は `.github/openssl-android.sh` に、NDK は `.github/workflows/android.yml` に、Android のアプリの AGP と依存は `android/gradle/libs.versions.toml` に、アプリに入れる bun は `.github/bun-android.sh` にバージョンを書いています。
`bun-android.sh` のバージョンは Dockerfile の `oven/bun` と別に Renovate が上げ、ずれている間は Android の CI が警告を出します。

**土台のイメージと GitHub Actions は digest で留めます。** Dockerfile の `FROM`・`COPY --from=` は
`名前:タグ@sha256:…`、ワークフローの `uses:` は `@<コミットの SHA> # vX.Y.Z` の形にします。
タグは同じ名前のまま中身が差し替わることがあるので、タグだけでは同じ中身になりません。

上げるのは Renovate 任せで、`# renovate:` の注釈と `renovate.json` の `customManagers` で
場所を教えてあります。タグのあるものはタグで、無いものはブランチの先頭のコミット (`git-refs`) で追います。
digest もタグと一緒に Renovate が上げ、タグだけで足した土台やアクションには digest を足す PR を出します (`renovate.json` の `pinDigests`)。
`renovate.json` の書き方は `docker compose run --rm unit bunx --package renovate renovate-config-validator` で確かめます。

## Android 向けのエージェント

**Android で動かすエージェントは、Linux と同じソースを `linux-bionic-arm64` の Native AOT で組みます。** CI のエミュレータのために `linux-bionic-x64` も組みます。
組み上がりは Android のアプリ (下の節) の APK に入れます。組むのは `.github/workflows/android.yml` で、test.yml が呼びます。

- .NET の SDK は ASP.NET Core の実行時パックを bionic 向けに出していません。csproj でその除外を外し、linux の実行時パックの IL を AOT で組ませています。
  SDK が対応していない使い方なので、SDK を上げたら Android の CI が通るかを見ます
- Android には OpenSSL が無いので、NDK で組んだ OpenSSL の静的ライブラリを実行ファイルに入れます (`StaticOpenSslLinking`)。
  組むのは `.github/openssl-android.sh` で、CI は組み上がりを actions/cache に置き、バージョン・組み方・NDK が変わるまで使い回します
- 出来上がりは `/system/bin/linker64` で動く PIE で、繋ぐのは libc・libm・libdl だけです。LOAD は 16 KB ページに揃えます。CI がこの 3 つを確かめます

手元で組むなら、NDK (バージョンは android.yml の `NDK_VERSION`) を置いたコンテナで、cmake と make を入れてから流します。

```sh
ANDROID_NDK_ROOT=/opt/ndk bash .github/openssl-android.sh arm64 /tmp/openssl-arm64
PATH=/opt/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH OPENSSL_ROOT_DIR=/tmp/openssl-arm64 \
  dotnet publish agent/Denpa.Agent/Denpa.Agent.csproj -c Release -r linux-bionic-arm64 -o out
```

## Android のアプリ

**Android で denpa を動かすアプリは `android/` の Gradle のプロジェクトです (パッケージは `io.github.danything.denpa`)。** 画面は持たず、常駐サービスがエージェントを子プロセスとして起動します。
使い方は [install-android.md](install-android.md)、エージェントとの取り決めは [agent.md](agent.md#android-でアプリから-usb-を受け取る) にあります。

- Kotlin で、Android の標準の API (`android.*`) だけで書きます。AndroidX も使わず、APK に入る依存は Kotlin の標準ライブラリだけです。
  Gradle・AGP・Kotlin・compileSdk・JDK・依存は、その時点の最新の安定版にします。上げるのは Renovate です (JDK は `renovate.json` の注釈で追う)
- エージェントは `android/agent-libs/<ABI>/libdenpa_agent.so` に置くと APK に入ります (`DENPA_AGENT_LIBS` で別の置き場も渡せます)。
  入れるときに `nativeLibraryDir` へ展開させ (`useLegacyPackaging`)、そこから exec します。Android 10 からは、アプリのデータの置き場のファイルは実行できません
- asicen-userland は `android/asicen-userland/` に置くと APK に入ります (`DENPA_ASICEN` で別の置き場も渡せます)。`bash .github/asicen-android.sh android/asicen-userland arm64 x86_64` が、
  上流の Android 版を SHA-256 で確かめて取り、`jniLibs/<ABI>/libasicend.so`・`libasicenctl.so`、ファームウェア、ライセンスの文書を並べます。
  バージョンが `agent/Dockerfile` と、組んだコミットが test.yml の `ASICEN_USERLAND_REF` と違えば止まります。置かなければ asicen-userland の無い APK になります
- bun は `android/bun/` に置くと APK に入ります (`DENPA_BUN` で別の置き場も渡せます)。`bash .github/bun-android.sh android/bun arm64 x86_64` が、
  公式の Android 版を SHA-256 で確かめて取り、`jniLibs/<ABI>/libbun.so` とライセンスの文書を並べます。x86_64 は CI のエミュレータ用で、AVX2 を使わない baseline を入れます。
  bun は配布物のまま入れます (`keepDebugSymbols`)。jniLibs は APK の中では圧縮されるので、増えるのは arm64 で約 53 MB です。端末には展開した 113 MB が置かれます
- 常駐サービスは、APK の assets に `server/` があれば、それを `files/denpa/server/` に書き出して `bun server/…/app/server.js` を部品として起動します (`Server.kt`)。
  置き場 (`DENPA_HOME`)・`HOME`・`TMPDIR` はエージェントと同じで、待ち受けるのは `PORT` (3000) です。出力は logcat の `denpa-server` に出ます。
  いまのリリースの APK には `server/` が無く、bun は起動しません。debug の APK にだけ、確かめ用の小さなサーバ (`src/debug/assets/server/app/server.js`) が入ります
- 挿したときにアプリを起こす機材の表 `res/xml/device_filter.xml` は手で書いています。エージェントが USB を直に持つ機材 (`WinUsbTargets.cs`) と asicen-userland の機材
  (`AsicenUserland.UsbIds`) と食い違わないことを、エージェントの単体テスト (`AndroidDeviceFilterTests.cs`) で確かめます。機種を足したら表にも足します
- debug の APK にだけ、エミュレータで確かめるための受け口 (`src/debug/` の `DebugReceiver`) が入ります。USB の機材の代わりにファイルの fd を送ること、
  通知の「終了」を押すこと、エージェントの異常終了の代わりに SIGKILL を送ることを `adb shell am broadcast` で代えます。DUMP の権限を持つもの (adb shell) からしか送れません

手元で組むなら、JDK と Android SDK を入れ、エージェント (上の節) を置いてから流します。

```sh
mkdir -p android/agent-libs/arm64-v8a && cp out/denpa-agent android/agent-libs/arm64-v8a/libdenpa_agent.so
bash .github/bun-android.sh android/bun arm64
cd android && ./gradlew lintDebug testDebugUnitTest assembleDebug
```

CI は android.yml で両方の ABI を入れた debug の APK を組み (成果物の `denpa-android-debug`)、Android 10 (API 29。minSdk) と Android 15 (API 35) の
x86_64 のエミュレータに入れて確かめます (`.github/android-app-smoke.sh`)。

- アイコンで起動すると、常駐サービスが connectedDevice で始まり、通知が出て、本文が「チューナー 0 台」になること
- エージェントがアプリの子プロセス (SELinux の `untrusted_app`) で動き、`<dataDir>/u` に USB_BROKER のソケット (0600) を作り、アプリが繋いで `synced` を送ること
- denpa と同じ手順で組み、`/denpa/about` (`os` が `android`)・`/denpa/tuners`・`/denpa/card` が答えること
- アプリの `LocalSocket` からファイルの fd を付けた `attached` を送ると、エージェントが fd ごと受け取ること
- エージェントが APK の `asicend --version` を起動できること。ファームウェア待ちの ID (`1738:5211`) でファイルの fd を送ると、エージェントがその fd を `asicend --fd` に継がせること
- bun がアプリの子プロセスで動き、確かめ用のサーバが 3000 番で答えること。サーバの `GET /check` で、JIT が動くこと、`localhost` を引けること、
  `/proc` から読めること、bun が自分を子プロセスで起動できること、`bun:sqlite` で置き場に書けることを見る。外の名前を引けるかと HTTPS は、ランナーのネットワークに左右されるので結果を残すだけ
- エージェントが落ちたらアプリが起動し直すこと、通知の「終了」でエージェントも bun も常駐サービスも残らないこと、端末を起動し直すと常駐サービスが始まること

エミュレータの列は必須チェックではありません (起動や応答の時間がばらつき、コードと関係なく落ちることがあるため)。
USB の機材はエミュレータに挿せないので、usbfs の fd (許可・`USBDEVFS_CONNINFO_EX`・確保) は CI では見ません。

### リリースの APK と署名の鍵

リリース (release.yml) は android.yml を `tag` 付きで呼び、arm64 のエージェントと asicen-userland だけを入れた release の APK を組んで、`denpa-<バージョン>-android-arm64.apk` と `.sha256` を添えます (出所の証明も付ける)。

- **リリースはいつも同じ鍵で署名します。** 鍵が違う APK は上書きで入れられないためです。denpa-tv とは別の鍵で、漏れたときに巻き込むアプリを 1 つにします
- 鍵は PKCS12 (RSA 4096 ビット、有効期限 36500 日。denpa-tv と同じ作り) で、リポジトリの Actions の secrets に `DENPA_ANDROID_KEYSTORE_BASE64` (keystore を base64 にしたもの)・
  `DENPA_ANDROID_KEYSTORE_PASSWORD`・`DENPA_ANDROID_KEY_ALIAS`・`DENPA_ANDROID_KEY_PASSWORD` として入れてあります。控えは管理者の手元にあります。
  Gradle には、CI が keystore のパスを `DENPA_ANDROID_KEYSTORE` で、ほかを同じ名前の環境変数で渡します
- android.yml は、署名した証明書の SHA-256 を、ワークフローに書いた値 (`CERT_SHA256`。install-android.md の「上げる」にも書いてある) と突き合わせます。
  secrets が無いときと値が違うときは、リリースの APK を出さずに止まります。突き合わせは .github/android-apk-cert.sh で、apksigner の出力の形が変わっても読めるように、
  `certificate SHA-256 digest:` の行を方式 (v2・v3) ごとにすべて比べます
- 鍵を渡さないとき (PR の CI・手元) は、release も debug の鍵で署名します。PR の CI は、R8 で縮めた release が組めることと、
  その証明書をランナーの debug の鍵と同じ手順で突き合わせられることもここで確かめます
- release は R8 で縮めます (`isMinifyEnabled`・`isShrinkResources`)。リフレクションで引くクラスが無く、マニフェストの部品は AGP の規則が残すので、規則は足していません。
  エミュレータで確かめるのは debug の APK だけなので、リフレクションを使うコードを足したら規則も足します
- エージェントに入っているもののライセンスの文書 (Siano のファームウェアの許諾と OpenSSL の LICENSE) を、APK の `assets/licenses/` に入れます
  (`licenseAssets`。OpenSSL のものは CI が `android/agent-licenses/` に置く。`DENPA_AGENT_LICENSES` で替えられる)。
  asicen-userland のライセンスの文書とソースの入手先は `assets/licenses/asicen-userland/` に入ります ([licenses.md](licenses.md#android-のアプリ))

文書の一覧は [README](../README.md#もっと詳しく) に。画面・docs・コメントの言葉の決まりは [writing.md](writing.md)。
