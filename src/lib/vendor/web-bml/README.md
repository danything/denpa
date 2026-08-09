# web-bml から借りているもの

データ放送 (ARIB STD-B24 の BML) のために、[otya128/web-bml](https://github.com/otya128/web-bml)
から**2つだけ**持ってきています。**中身は書き換えていません** — 上流を追いやすく
するためで、denpa 側の都合は [ts/bml.ts](../../ts/bml.ts) に寄せてあります。

直すのは取り込むときの**型だけの import** 1箇所だけです。denpa は
`verbatimModuleSyntax` で組んでいるので、型を値と同じ形で import していると通りません
(下の「更新のしかた」に手順)。

| | |
| --- | --- |
| 出どころ | <https://github.com/otya128/web-bml> |
| 版 | `d784fd9e3376cf74dd85ba8b9879e6d2b714044c` (2026-07-23) |
| 許諾 | MIT ([LICENSE](LICENSE)) |
| 持ってきたもの | `server/entity_parser.ts` `server/ws_api.ts` |

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

## 描画側は借りる

**BML を動かすところは自前で書きません。** スクリプトは ECMA-262 第3版どきの方言で、
専用の DOM と `browser` オブジェクトと NVRAM の上で動くので、**ES2 の処理系まで
抱える**ことになります (向こうは手書きのぶんだけでも `browser.ts` 58KB・
`content.ts` 69KB・`drcs.ts` 31KB)。放送の仕様に当たり続ける仕事で、字幕を絵で出す
ことにしたのと同じ理由で、自前で持つ価値がありません
([docs/stream.md](../../../../docs/stream.md#56-データ放送の統合))。

**解く側と線を引けるのは `ws_api.ts` があるからです。** 解くのは自前、描画は借りもの、
その間を型が見張る。

## 更新のしかた

上流の差分を見てから、2つのファイルを取り直して版を書き換えます。`ws_api.ts` の型が
変わったときだけ `bml.ts` に響きます。

```sh
SHA=<新しい commit>
for f in entity_parser.ts ws_api.ts; do
  gh api "repos/otya128/web-bml/contents/server/$f?ref=$SHA" --jq '.content' | base64 -d \
    > "src/lib/vendor/web-bml/$f"
done
```

そのあと `bun run check` が**型だけの import** を言ってくるので、直します
(`ws_api.ts` の `MediaType`)。**除外設定では逃げられません** — こちらから import して
いる以上、型検査は追ってきます。整形からは外してあります
([biome.json](../../../../biome.json) の `!src/lib/vendor`)。
