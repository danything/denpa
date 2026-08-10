# web-bml から借りているもの

データ放送 (ARIB STD-B24 の BML) のために、[otya128/web-bml](https://github.com/otya128/web-bml)
から**描く側**を持ってきています。**中身は書き換えていません** — 上流を追いやすく
するためで、denpa 側の都合は [ts/bml.ts](../../ts/bml.ts) と
[DataBroadcast.svelte](../../components/player/DataBroadcast.svelte) に寄せてあります。

置き方は**上流と同じ木の形**にしてあります (`client/` `es2/` `public/` `server/`)。
向こうのファイルどうしが相対で指し合っているので、崩すと全部書き換えることになります。

| | |
| --- | --- |
| 出どころ | <https://github.com/otya128/web-bml> |
| 版 | `d784fd9e3376cf74dd85ba8b9879e6d2b714044c` (2026-07-23) |
| 許諾 | MIT ([LICENSE](LICENSE)) |
| 持ってきたもの | `BMLBrowser` から辿れるもの **44ファイル・1.4MB** |
| 写していないもの | `client/interpreter/js_interpreter.ts` (下の説明)、単体ページ・サーバ・自前再生 |

## 手を入れているのは2つだけ

**1行目に `@ts-nocheck` を足しています。** denpa は `verbatimModuleSyntax` で
組んでいるので、そのままでは型だけの import 64箇所を直して回ることになります。
**借りものの中身を検査しても直せるものが無い**ので、丸ごと外しました。
**denpa 側の検査は効いたままです** — 型そのものは読まれるので、`ts/bml.ts` が
`ResponseMessage` に無い物を入れれば、いまでも `bun run check` が止めます
(確かめてあります)。

**`client/interpreter/js_interpreter.ts` だけ denpa が書いています。** 理由は
そのファイルの頭に書いてあります (向こうの README が「未使用」と言っている道で、
Vite では読み込んだ時点で転ぶ)。

## 何を借りていて、何を借りていないか

**`ws_api.ts` は型だけ。** 解いた結果をどんな形で渡すかの取り決めで、
**描画側 (web-bml のブラウザ) との契約**です。denpa は自前で解いた結果をこの形に
詰めるので、**食い違えば型検査が止めてくれます**。ここを借りているからこそ、
解く側を自前にできています。

**`entity_parser.ts` は multipart を解くだけ。** モジュール1つに BML と画像が
`multipart/mixed` でまとめて入っているのを、ファイルごとに切り分けます。
**依存の無いただの解析**で、書き直しても得るものがありません。

**解く側 (`decode_ts.ts`) は借りていません。** 一度は借りましたが、998行のうち
denpa が通るのは3割 (DSM-CC と PMT の記述子) だけで、残りは EIT/SDT/NIT や字幕の
PES — どれも denpa に自前のものがあります ([eit.ts](../../ts/eit.ts) /
[psi.ts](../../ts/psi.ts) / 字幕は ffmpeg が絵にする)。その3割のために
`@chinachu/aribts` (2.3MB) を抱えることになるので、[dsmcc.ts](../../ts/dsmcc.ts) と
[bml.ts](../../ts/bml.ts) に書き直しました。**運び方は衛星のロゴ
([logo-dsmcc.ts](../../ts/logo-dsmcc.ts)) と同じ DSM-CC** で、denpa は既に持って
いたものです。

実機の録画 (79MB = 約40秒ぶん) で突き合わせて、**揃うモジュール16個・ファイル数・
バイト数・種別まで完全に一致**しました (速さは 120 → 128 MB/s)。借りていた頃と違うのは
2つだけです。

- **`pcr` を出さない。** 毎秒50個来るうえ、denpa では**映像そのものが時計**
- **`programInfo` を出さない。** 向こうは EIT/SDT/NIT から組み立てていたが、
  denpa は**自前の番組表を持っている**ので、そちらから作るほうが正確で安い
  (描画側を入れるときに繋ぐ)

## 描く側は借りる

**BML を動かすところは自前で書きません。** スクリプトは ECMA-262 第3版どきの方言で、
専用の DOM と `browser` オブジェクトと NVRAM の上で動くので、**ES2 の処理系まで
抱える**ことになります (`es2/index.ts` だけで 200KB)。放送の仕様に当たり続ける
仕事で、字幕を絵で出すことにしたのと同じ理由で、自前で持つ価値がありません
([docs/stream.md](../../../../docs/stream.md#56-データ放送の統合))。

繋ぎ口は `ResponseMessage` ひとつです:

```ts
const browser = new BMLBrowser({ containerElement, mediaElement, fonts });
browser.emitMessage(message);   // ← ts/bml.ts が吐くものをそのまま
browser.destroy();
```

**映像は渡すだけ。** `client/player/*.ts` は向こうの単体ページが hls.js /
mpegts.js で自前再生するためのもので、`BMLBrowser` は受け取りません。
denpa の `<video>` はそのまま、上に BML が載ります。

### 借りていないぶん、こちらでやること

**`client/index.ts` (向こうの単体ページ) は借りていません。** あれは koa と
react と hls.js を引き連れていて、denpa の画面とは形が違います。ただし
**`BMLBrowser` は画面の器を持っていない**ので、あそこがやっていた3つは
こちらでやることになります ([DataBroadcast.svelte](../../components/player/DataBroadcast.svelte))。
**3つとも、抜けると「押しても何も出ない」形で壊れます** — 実機でその3つを踏みました。

1. **d を BML に渡す。** BML の `body` は `invisible` で始まり、
   `DataButtonPressed` を受けてアプリが自分で出てきます。**器を作っただけでは
   何も出ません。** しかも文書ができた瞬間に叩いても届きません —
   `beitem` を `subscribe` にするのはアプリの `onload` なので、それより前に
   投げた分は誰にも拾われずに消えます (出てくるまで叩き直す)
2. **隠れている間、映像を元の場所へ戻す。** 借りものは文書を組むたびに、渡された
   `mediaElement` を BML の `<object>` の**中へ移します**
   (`content.ts` の `videoElementNew.appendChild`)。データ放送が「小窓に映せ」と
   言っているならそれで正しいのですが、**隠れている間もそのまま**なので、
   放っておくと映像が小窓の形に潰れたまま戻りません。向こうは `invisible`
   イベントで別の入れ物へ移し替えています
3. **960x540 を枠に合わせて伸ばす。** 向こうは原寸のまま置いて、
   100%/150%/200% のボタンを付けています。denpa の枠は端末しだいなので
   `transform: scale()` で合わせます (`load` が寸法を教えてくれる)

**局を変えたら作り直します。** 借りものは一度に一つの放送しか持てません
(カルーセルも覚えるものも局ごと) し、2番の通り**前の局の文書が映像を掴んだまま**
になります。

**押されるまで読み込みません。** 1.4MB あるので `import()` で分けてあり
(`DataBroadcast.svelte`)、d ボタンを押した人だけが取りに行きます。

**フォントは向こうのものを使いません。** denpa は字幕を焼くのに
`rounded-mplus-1m-arib` を既に積んでいて、それが BML の要る3つ —
**等幅** (仕様で必須)・**丸ゴシック**・**ARIB の外字** — を1本で満たします。
向こうの Kosugi (4.4MB) は外字を持っていません。**同じ字なので、データ放送と
字幕で字形が揃います** (`/api/font`)。

## Vite で組むための細工

借りものを書き換えずに済ませるため、denpa 側で2つ面倒を見ています。

- **`import css from "../public/default.css"`** は**文字列として**読ませます。
  向こうは webpack の `asset/source`、こちらは
  [vite.config.ts](../../../../vite.config.ts) の `denpa:bml-css`
- **`js_interpreter.ts`** は写さず、denpa の1行に差し替えています (そのファイルの頭)

## 更新のしかた

上流の差分を見てから、木ごと取り直します。**`BMLBrowser` から辿れるものだけ**で、
`js_interpreter.ts` は写しません。

```sh
SHA=<新しい commit>
git clone --depth 1 https://github.com/otya128/web-bml.git /tmp/web-bml
# client/ es2/ public/ server/ を、いまある形に合わせて写す
# そのあと、写した .ts の1行目に `// @ts-nocheck` を足す
```

型が変わったときだけ `ts/bml.ts` と `DataBroadcast.svelte` に響きます
(`ResponseMessage` と `BMLBrowserOptions`)。整形と検査からは外してあります
([biome.jsonc](../../../../biome.jsonc) の `!src/lib/vendor`)。
