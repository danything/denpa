# web-bml から借りているもの

データ放送 (ARIB STD-B24 の BML) を出すために、[otya128/web-bml](https://github.com/otya128/web-bml)
から**解く側だけ**を持ってきています。**中身は書き換えていません** — 上流を追いやすく
するためで、denpa 側の都合は `src/lib/server/databroadcast.ts` に寄せてあります。

直すのは取り込むときの**型だけの import** 4箇所だけです。denpa は
`verbatimModuleSyntax` で組んでいるので、型を値と同じ形で import していると通りません
(下の「更新のしかた」に手順)。

| | |
| --- | --- |
| 出どころ | <https://github.com/otya128/web-bml> |
| 版 | `d784fd9e3376cf74dd85ba8b9879e6d2b714044c` (2026-07-23) |
| 許諾 | MIT ([LICENSE](LICENSE)) |
| 持ってきたもの | `server/decode_ts.ts` `server/entity_parser.ts` `server/ws_api.ts` |

## なぜ借りるのか

`decodeTS()` は **TS を流し込む Node のストリーム**で、出てくるのは生の TS でも
セクションでもなく、**組み立て終わったモジュール**です。DSM-CC のカルーセルを
束ね直すところまで向こうが持っています。

自分で書くなら、カルーセルの組み立てだけでは済みません。BML のスクリプトは
ECMA-262 第3版どきの方言で、専用の DOM と `browser` オブジェクトと NVRAM の上で
動くので、**ES2 の処理系まで抱える**ことになります (向こうは手書きのぶんだけでも
`browser.ts` 58KB・`content.ts` 69KB・`drcs.ts` 31KB)。放送の仕様に当たり続ける
仕事で、字幕を絵で出すことにしたのと同じ理由で、自前で持つ価値がありません
([docs/stream.md](../../../../docs/stream.md#56-データ放送の統合))。

## 実測

実機の録画 (テレビ朝日、1局に絞った 83MB = 約40秒ぶん) を流したもの:

| | |
| --- | --- |
| 出てきた知らせ | `pcr` 2,136 / `moduleDownloaded` 16 / `currentTime` 13 / `moduleListUpdated` 3 / `programInfo` 2 / `pmt` 1 |
| 揃ったモジュール | 16個・約 1.4MB (中身は application / image / text / audio) |
| 速さ | 120 MB/s。放送の 17 Mbit/s に対して **1コアの 1.8%** |

**常に回していい安さ**です。データ放送を見ていない人のぶんまで解いても、
映像を焼く手間に埋もれます。

## 更新のしかた

上流の差分を見てから、3つのファイルを取り直して版を書き換えます。`ws_api.ts` の型が
変わったときだけ `databroadcast.ts` に響きます。

```sh
SHA=<新しい commit>
for f in decode_ts.ts entity_parser.ts ws_api.ts; do
  gh api "repos/otya128/web-bml/contents/server/$f?ref=$SHA" --jq '.content' | base64 -d \
    > "src/lib/vendor/web-bml/$f"
done
```

そのあと `bun run check` が**型だけの import** を4箇所言ってくるので、直します
(`ws_api.ts` の `MediaType`、`decode_ts.ts` の `MediaType` / `ComponentPMT` /
`AdditionalAribBXMLInfo`)。**除外設定では逃げられません** — こちらから import して
いる以上、型検査は追ってきます。
