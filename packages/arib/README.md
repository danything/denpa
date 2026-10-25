# @doany/arib

日本のデジタル放送 (ISDB-T / ISDB-S、ARIB 規格) の MPEG-TS を TypeScript で読むライブラリです。
録画サーバー [denpa](https://github.com/danything/denpa) の中で使っているものを切り出しました。

- **PSI** — パケットの切り出し、セクションの組み立て、PAT / PMT / SDT / NIT (`psi`)
- **PES** — 映像・音声の PES と ADTS (`pes`)
- **番組表** — EIT[p/f] と EIT[schedule]。ジャンル・音声・拡張形式イベント記述子まで (`eit`)
- **ARIB の文字** — STD-B24 の8単位符号と ARIB 外字 (`aribtext`、`aribtext-gaiji`)
- **字幕** — STD-B24 の字幕文を、字の置き場所まで決めた JSON にする (`b24caption`、形式は `caption-text`)
- **データ放送** — DSM-CC のカルーセルからモジュールとファイルを組み立てる (`dsmcc`、`multipart`、`bml`)
- **Hybridcast の AIT** (`ait`)、**1つの局だけを抜き出す** (`service-filter`)

依存するパッケージはありません。

## 入れ方

```sh
npm install @doany/arib
```

ES モジュールだけです。`bml` と `b24caption` は `node:zlib` / `node:crypto` を使うので、
Node.js・Bun・Deno で動きます。ほかのモジュールはブラウザでも動きます。型は TypeScript 5.7 以降で読めます。

## 使い方

モジュールごとに読み込みます (`@doany/arib/<名前>`)。

```ts
import { EpgReader } from "@doany/arib/eit";

const epg = new EpgReader();
for await (const chunk of stream) {
  // 長さはそろっていなくてよい
  if (epg.feed(chunk)) {
    for (const event of epg.takeChanged()) {
      console.log(event.serviceId, new Date(event.startAt), event.name);
    }
  }
}
```

```ts
import { decodeAribText } from "@doany/arib/aribtext";

decodeAribText(bytes); // "🈟ニュース"
```

```ts
import { B24CaptionDecoder } from "@doany/arib/b24caption";

const captions = new B24CaptionDecoder();
// 字幕の PES の中身 (データ識別 0x80 から) を1つずつ渡す
const page = captions.decode(pesPayload);
if (page !== null) draw(page); // 形式は caption-text.ts の CaptionPage
```

## 版

0.x の間は、小さい版 (0.1 → 0.2) で互換のない変更をすることがあります。

## ライセンス

MIT。字幕の表とデコードの方法は [libaribcaption](https://github.com/xqq/libaribcaption) (MIT)、
外字表の一部は [ariblib](https://github.com/youzaka/ariblib) (MIT) から来ています。
著作権表示は [LICENSE](LICENSE) にあります。
