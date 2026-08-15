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
| 持ってきたもの | `BMLBrowser` から辿れるもの **44ファイル・1.2MB** |
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
**`BMLBrowser` は画面の器を持っていない**ので、あそこがやっていたことは
こちらでやることになります ([DataBroadcast.svelte](../../components/player/DataBroadcast.svelte))。
**どれも抜けると「押しても何も出ない」形で壊れます** — 実機で全部踏みました。

1. **d を BML に渡す。** 出す操作は文書にとっての d の1押しで、`DataButtonPressed`
   を受けてアプリがメニューを出します。**器を作っただけでは何も出ません** (NHK は
   `invisible` のまま d を待ち、日テレ・テレ朝・フジは待機ページを自分で出してから
   d を待つ)。しかも文書ができた瞬間に叩いても届きません — `beitem` を `subscribe`
   にするのはアプリの `onload` なので、それより前に投げた分は誰にも拾われずに
   消えます。**聞いている文書が出てくるまで見に行き、最初の1つに1回だけ届けます**
   (2回届けると、開いたメニューを閉じたり頭に戻したりする局がある)
2. **隠れている間、映像を元の場所へ戻す。** 借りものは文書を組むたびに、渡された
   `mediaElement` を BML の `<object>` の**中へ移します**
   (`content.ts` の `videoElementNew.appendChild`)。データ放送が「小窓に映せ」と
   言っているならそれで正しいのですが、**隠れている間もそのまま**なので、
   放っておくと映像が小窓の形に潰れたまま戻りません。向こうは `invisible`
   イベントで別の入れ物へ移し替えています
3. **960x540 を枠に合わせて伸ばす。** 向こうは原寸のまま置いて、
   100%/150%/200% のボタンを付けています。denpa の枠は端末しだいなので
   `transform: scale()` で合わせます (`load` が寸法を教えてくれる)
4. **映像の入れ物の大きさを、じかに書く。** 2番で移される先は**閉じた影の
   中**なので、**表の CSS (Tailwind) が届きません**。しかも借りものが敷く
   既定のスタイルは `div` に `width:0; height:0` を与えるので、class で
   書いていると**移された瞬間に映像が消えます** (`MediaStack.svelte`、`watch/[id]/+page.svelte`)
5. **「データ取得中」を出す。** 借りものは `Indicator` という口で教えて
   くれます。テレビは電波をずっと拾い続けているので押せばすぐ出ますが、
   denpa は**押されてから解きはじめる**ので数秒待ちます (実測で8秒)。
   入口の文書はほぼ白紙のまま自分で `invisible` を外してくるので、
   素直に映すと**その数秒が真っ白**になります — 最初の1枚が揃うまでは
   映像のままにして、この札だけ出します

**局を変えたら作り直します。** 借りものは一度に一つの放送しか持てません
(カルーセルも覚えるものも局ごと) し、2番の通り**前の局の文書が映像を掴んだまま**
になります。

**押されるまで読み込みません。** 組み上がると 700KB (gzip 前) の塊になるので
`import()` で分けてあり (`DataBroadcast.svelte`)、d ボタンを押した人だけが
取りに行きます。**上の表の 1.2MB は置いてある元のほうで、別の数**です。

**フォントは向こうのものを使いません。** denpa は字幕を焼くのに
`rounded-mplus-1m-arib` を既に積んでいて、それが BML の要る3つ —
**等幅** (仕様で必須)・**丸ゴシック**・**ARIB の外字** — を1本で満たします。
向こうの Kosugi (4.4MB) は外字を持っていません。**同じ字なので、データ放送と
字幕で字形が揃います** (`/api/font`)。

## Vite で組むための細工

借りものを書き換えずに済ませるため、denpa 側で2つ面倒を見ています。

- **`import css from "../public/default.css"`** は**文字列として**読ませます。
  向こうは webpack の `asset/source`、こちらは
  [vite.config.ts](../../../../vite.config.ts) の `denpa:bml-css`。
  **偽の名前は `.js` で終わらせます** — `.txt` にすると Rolldown が
  *テキスト*と見なして、こちらが返した JS をもう一度文字列に包み、
  **既定のスタイルが丸ごと効かなくなります** (そこに書いてあります)
- **`js_interpreter.ts`** は写さず、denpa の1行に差し替えています (そのファイルの頭)
- **`Buffer` を global に据えます。** 借りものは Node の `Buffer` 前提で書かれて
  いて、多くのファイルは `buffer` を import しますが、音声と**通信系コンテンツの
  取得**は素の `Buffer` を当てにしています。無いと `Buffer is not defined` で
  止まる — 実機で「通信機能について」を選ぶと `http://bml.nhk.jp/…` へ飛び、
  取ってきた BML を包むところ (`resource.fetchRemoteResource`) で落ちました。
  データ放送を開くときにだけ据えます ([DataBroadcast.svelte](../../components/player/DataBroadcast.svelte) の `provideBuffer`)

## 更新のしかた

**毎週、GitHub Actions が写し直して PR にします**
([vendor-web-bml.yml](../../../../.github/workflows/vendor-web-bml.yml) と
[vendor-web-bml.ts](../../../../.github/vendor-web-bml.ts))。手元でも走ります:

```sh
git clone --filter=blob:none https://github.com/otya128/web-bml.git /tmp/web-bml
bun .github/vendor-web-bml.ts /tmp/web-bml
```

**Renovate では見えません。** 木ごと写しているので、あちらからは「ただの
`src/` の中のファイル」に見えます。仮に版だけ書き換える PR を出せたとしても、
**中身は古いまま新しい版だと名乗るファイル**ができるだけです。

写すのは**いま置いてあるのと同じ顔ぶれ**で、そのつど `BMLBrowser` から
辿り直しはしません。**上流が依存を増やしたときは `bun run check` が
「そんなファイルは無い」で落ちます** — それが「人が見て決め直せ」という札に
なります (落ちても PR は出ます。結果は説明に書いてあります)。

型が変わったときも同じで、`ts/bml.ts` と `DataBroadcast.svelte` に響きます
(`ResponseMessage` と `BMLBrowserOptions`)。整形と検査からは外してあります
([biome.jsonc](../../../../biome.jsonc) の `!src/lib/vendor`)。

**中身は上流と1バイトも違いません** (足すのは頭の2行だけ)。改行の有無まで
揃えてあるので、PR の差分は**上流の変更そのもの**になります。
