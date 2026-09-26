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

依存を足したら `docker compose run --rm unit bun install` を一度回します
(`node_modules` は名前付きボリュームなので、イメージの焼き直しは要りません)。

手元だけの上書きは `compose.override.yml` に (Compose が自動で読む。コミットしない)。
`.env` は使いません。

## README の絵

`docs/images/` の絵は **動いている denpa から撮ります** (偽エージェントではなく、
番組表も録画も入っているもの)。撮る条件 (1600×900・暗いテーマ・ja-JP・Asia/Tokyo。
動く絵も同じ広さで撮り、貼るときに 1120×630 へ縮める) は `scripts/capture-docs.ts` の頭にあります。

```sh
ssh -N -L 3399:<denpa の ClusterIP>:3000 <ホスト>   # 見えるところに繋ぐ
bun scripts/capture-docs.ts                          # 全部 (名前を挙げるとそのぶんだけ)
python3 scripts/docs-webp.py                         # 動く絵を組み立てて docs/images へ
```

閲覧だけで、予約も削除も保存もしません。自分の値が入る欄 (通知先・VLC・郵便番号) と
映像はぼかします。見た目を変えたら撮り直してください (古い絵は README を見て入れた人を迷わせます)。

## テストの方針

**E2E が主で、単体テストは純粋関数の境界条件だけ。** 偽エージェント・偽の通知先・
偽ffmpeg を立てて、予約から録画・CM検出・エンコード・保存先への配置・
視聴済み削除までを通します (`tests/fake/`)。偽エージェントの BS は1番組5秒 (地上波は30分) で、
録画完了まで待っても30秒です。

画面まわりの入口は [app.md](app.md#テスト)、置いてあるものの一覧は
[app.md](app.md#構成) にあります。

### 並べて流す

**ワーカーごとに denpa と偽エージェントと偽通知先を1式ずつ立てます** (`tests/stack.ts`)。
ポートも置き場もDBも別なので、同時に走るファイル同士は互いに見えません。1つのアプリとDBを
共有していた頃は、予約もルールも同じ表に入って件数が合わなくなるので直列でした。
2分半 → 50秒 (12コアで実測)。

- ファイルの中は順番 (`fullyParallel: false`)。前のテストが作った予約や録画を次が当てにしてよい
- ファイルをまたいでは当てにできない。実体のある録画が要るテストは `recordOne()` で自分のぶんを録る
- アプリは開発サーバではなく組んだもの (`bun run build` → `adapter-node`) をワーカーの数だけ
  動かす。開発サーバを4つ立てるより軽く、本番と同じ出力を試せる
- API へ直接投げるときは `Origin` を付ける。SvelteKit は Origin の無いフォーム形式の POST を
  別サイトからの送信として断る

**1台ではこれ以上縮みません。** 中身の合計は約3分で大半は偽の放送を待つ時間、
下限はいちばん長いファイル1本の時間です。

CI では4つに割って別のランナーに出し、3ワーカー×4台 = 12ワーカーぶん並べます。
組の中身は `tests/e2e/shards.json`。`--shard` の機械割りだと重いスペック (録画完了を実時間で
待つもの) が同じ組に固まるので、実測の所要時間で人が割っています。新しいスペックは必ず
どこかの組に入れてください (入れ忘れは CI の「組分けの検算」が落とす。`.github/workflows/test.yml`)。
リント・型・単体と .NET のエージェントも別のジョブなので、待つのはいちばん遅い1つだけです
(4分37秒 → 2分ほど)。

| 効いたこと | 効果 |
| --- | --- |
| ワーカー 4 → 6 | 1分43秒 → 59秒。8 にすると取り合いで落ちるものが出た |
| いちばん長いファイル (放送の延長、58秒) を2つに割る | 59秒 → 50秒 |

ワーカー数は**手元では CPU の数そのまま (下限2・上限6)、CI (`CI=1`。`docker compose run e2e` も
そう) では 3 で固定**です。待ち時間が大半なのでコア数ぶん立ててよいのですが、
CI のランナー (4コア) で4つ並べると、チューナーを掴むのを待つテストが
30秒待っても掴めずに落ちました (実測は `playwright.config.ts` の頭)。

混み具合でごく稀にブラウザ側が落ちるので、1回だけやり直します (`retries: 1`)。
赤くしても直すものがありません。

次に効くのは 03 (録画の通し、30秒) を割ることですが、その先は偽番組の尺 (BSは5秒) と
録画の前後マージンに当たり、詰めると「録り始めより先に番組が終わる」ので不安定になります。

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
生の SQL の文字列に型を付けて返す口は置かない。それはキャストで、型が嘘をつく元になる。

JSON で持つ列 (ジャンル・音声の構成・ルールの対象チャンネルなど) は `schema.ts` の
`json(名前, 読み手)` で書く。読み書きで解いて畳むので、使う側は `JSON.parse` を書かない。
読み手は列ごとに書き、壊れた行は「持っていない」(空の並び・NULL) にする
(1行のせいで一覧ごと出なくなるのを避ける)。

## 型の締め方

`tsconfig.json` は `strict` に加えて `exactOptionalPropertyTypes` (省けるのと undefined を
入れてよいのは別)、`noPropertyAccessFromIndexSignature` (index signature のものは `[]` で読む)、
`noUncheckedIndexedAccess` (添字で読んだものは undefined かもしれない) を入れてある。

`noUncheckedIndexedAccess` の書き分け:

- **バイト列の読み** (`data[i]`、`src/lib/ts/` の TS/PSI/EIT/PGS の読み手) は、長さを確かめた
  上で `data[i]!`。1 バイトごとに undefined を見ても読み手が二倍の長さになるだけ。
  確認が無いところに `!` を足さない
- **配列の先頭・regex の group・`split()` の結果** は undefined を見る (`?? ''`、
  `const [a = NaN] = ...`、`if (x === undefined) return`)。`[0]!` にしてよいのは、直前で
  空でないことを確かめている (`atLeastOne` のような) 場合だけ
- **試験** は `!` でよい。落ちれば試験が落ちる

外から来る JSON (チューナーエージェントの答え、OIDC の相手、取り込み元の DB) は
`res.json() as X` と書かず、`src/lib/shape.ts` の読み手で形を確かめてから型にする
(`tolerate(array(AGENT_CHANNEL), await res.json(), 'エージェントの /denpa/channels')`)。型は形から
導く (`Infer<typeof AGENT_CHANNEL>`) ので、形と型を別々に書かない。

読み方は 2 つ。`tolerate` は形が違っても止めず、警告を 1 回出して来たものをそのまま使う
(エージェントの答え。版がずれただけで録画が止まっては困る)。`read` は止める
(ID トークン。違う形のまま進むと危ない)。迷ったら `tolerate`。自分のサーバから自分の画面へ
渡すもの (同じリポジトリの中) はキャストのままでよい。

**マイグレーションを持つ前の DB** (1.7.x まで。`CREATE TABLE IF NOT EXISTS` を起動のたびに
流していた) にも、最初のマイグレーション (baseline) が `IF NOT EXISTS` なのでそのまま当たる。1.7.x を一度も起動していない古い DB は列が足りないことがあり、起動時に
どの列かを言って止まる。その場合は 1.7.x を一度起動してから上げる。

## イメージ

`Dockerfile` が denpa 本体、`agent/Dockerfile` がチューナー側です。
CI が両方を焼いて `deploy/` の印を書き戻します。**main は直接 push できない**
(ruleset の必須チェック `check` / `agent` / `e2e (1)`〜`(4)` / `claude-review`) ので、
書き戻しは bot が PR を出し、必須チェックの status を自分で付けてマージします
(手順と理由は `.github/bump-pr.sh`。release の Chart.yaml の書き戻しも同じ)。
release は組み直さず、main で組んだイメージに版を 1 層足します
(`.github/release.Dockerfile`。タグの決め方と理由は [architecture.md](architecture.md#イメージのタグ)、
出し方は `.github/image-tags.sh`)。

**イメージは amd64 と arm64 の2つ**で、同じタグに束ねてあります (理由と組み方は
[architecture.md](architecture.md#イメージのタグ))。Dockerfile は BuildKit の `TARGETARCH`
で配布物 (px4-userland / siano-ts) の名前と .NET の RID を読み替え、
Intel の QSV (libvpl・libmfx-gen・intel-media-va-driver) は amd64 だけに入れます
(Debian の arm64 には無い)。Dockerfile やそこへ入るもの (`agent/`・`patches/`・依存) を
触った PR では、`Docker build check` が両方の arch を本物のランナーで組みます
(push はしない。必須チェックではない)。手元で arm64 を組むなら
`docker buildx build --platform linux/arm64 -f agent/Dockerfile .` (amd64 の機械では
QEMU が要り、ffmpeg や AOT はかなり遅い)。

エージェントの口に当てる適合テストは `agent/conformance.test.ts` ([app.md](app.md) のテストの表)。

### 外から持ってくるものは版で固定する

ffmpeg・libaribcaption・CM検出の一式・ARIB のフォント・px4-userland / siano-userland は、どれも
`ARG` / `ENV` に版 (タグかコミット) を書いてから取ってきます。**`master` を
追っていた頃は、同じコミットから焼いても中身が違いえました** (実機の中身は Pod へ入らないと
分からなかった)。CM検出の3つ (`logoframe`・`chapter_exe`・`dtvindex`) は
毎週書き換わるので、固定しないと次のデプロイで判定の中身が黙って変わります。

上げるのは Renovate 任せで、`# renovate:` の注釈と `renovate.json` の `customManagers` で
場所を教えてあります。タグのあるものはタグで、無いものは枝の先頭のコミット (`git-refs`) で追います。
注釈と実際の行が噛み合っているかは、こう確かめます。

```sh
bunx --package renovate renovate-config-validator   # 設定そのもの
```

文書の一覧は [README](../README.md#もっと詳しく) と [architecture.md](architecture.md) の冒頭の表に。
