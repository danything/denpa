# @danything/arib

日本のデジタル放送 (ISDB-T / ISDB-S / ISDB-C、ARIB 規格) の MPEG-TS と、4K の放送の MMT/TLV を TypeScript で読むライブラリです。
録画サーバ [denpa](https://github.com/danything/denpa) の中で使っているものを切り出しました。

- PSI (`psi`): パケットの切り出し、セクションの組み立て、PAT / PMT / SDT / NIT。衛星はネットワークの全部の TS の NIT と、ほかの TS の SDT もそろえて読む。ケーブルは SDT だけで局をそろえる
- 映像・音声の PES と ADTS を取り出す (`pes`)
- 番組表の EIT[p/f] と EIT[schedule] を、ジャンル・音声・拡張形式イベント・シリーズ記述子まで読む。放送の時刻 (TDT / TOT) もここ (`eit`)
- ARIB STD-B24 の 8 単位符号 (JIS X 0213 の 1 面・2 面まで) と ARIB 外字を文字列にする (`aribtext`、`aribtext-gaiji`)
- 字幕は STD-B24 の字幕文を、字の置き場所まで決めた JSON にする (`b24caption`、形式は `caption-text`)
- データ放送は DSM-CC のカルーセルからモジュールとファイルを組み立てる (`dsmcc`、`multipart`、`bml`、形式は `bml-protocol`)
- Hybridcast の AIT を読む (`ait`)
- 1 つの局だけを TS のまま抜き出す (`service-filter`)
- 4K の放送 (MMT/TLV。ARIB STD-B32・B60) の土台として、TLV パケットの切り出し (`tlv`)、IP とヘッダー圧縮した IP から UDP の中身を取り出す処理 (`tlv-ip`)、MMTP のヘッダーとスクランブルの印、信号メッセージの分割と集約 (`mmtp`)
- 4K の放送の表は、TLV-NIT・PLT・MPT・MH-SDT・MH-TOT (`mmt-si`)。局の一覧と、局ごとの CA_system_id (MPT のアクセス制御記述子) をそろえて読む `TlvServiceReader` もここ (TS の `psi` の `ServiceReader` に当たる)。番組表の MH-EIT は TS と同じ形式の番組にする (`mh-eit`)。1 つの局だけを TLV のまま抜き出す (`mmt-service-filter`)
- 4K の放送の映像 (HEVC)・音声 (AAC)・字幕 (TTML) のアクセスユニットを、MPT の記述子から付けた PTS・DTS (90 kHz) と一緒に取り出す (`mmt-media`)。音声は LATM を外した AAC のフレームと AudioSpecificConfig、映像は NAL ユニットの並び。字幕の TTML は、TS の字幕と同じ字幕の文字の配置にする (`ttml`)。スクランブルの復号は無い
- 試験用の TS (PSI・EIT・字幕・カルーセル・映像と音声) を組み立てる (`synth`、`synth-caption`、`synth-av`)
- 試験用の TLV (TLV・IP・MMTP・MMT-SI と、MPU の中身・時刻の記述子・LATM) を組み立てる (`synth-mmt`)。本物の HEVC と AAC を時刻を進めて流し続ける (`synth-mmt-av`)
- ほかのモジュールが使う道具として、バイト列 (`bytes`)、ビット単位の読み取り (`bits`)、言語の名前 (`language`)、文字の表 (`b24-tables`)、字幕の外字の画像をなめらかにする処理 (`drcs-smooth`)

依存するパッケージはありません。

## 入れ方

```sh
npm install @danything/arib
```

ES モジュールだけです。`bml`・`b24caption`・`drcs-smooth` は `node:zlib`・`node:crypto`・`node:buffer` を使うので、
Node.js・Bun・Deno で動きます。ほかのモジュールはブラウザでも動きます。型は TypeScript 5.7 以降で読めます。

## 使い方

モジュールごとに読み込みます (`@danything/arib/<名前>`)。

```ts
import { EpgReader } from "@danything/arib/eit";

const epg = new EpgReader();
for await (const chunk of stream) {
  // 長さはそろっていなくてよい
  if (epg.feed(chunk)) {
    // 返るのは開始時刻と尺の決まった番組だけ
    for (const event of epg.takeChanged()) {
      console.log(event.serviceId, new Date(event.startAt!), event.name);
    }
  }
}
```

```ts
import { decodeAribText } from "@danything/arib/aribtext";

decodeAribText(bytes); // "🈟ニュース"
```

4K の放送は TLV のバイト列を渡します。番組は TS の `EpgReader` と同じ形式 (`EitEvent`) で返ります。

```ts
import { MmtEpgReader } from "@danything/arib/mh-eit";

const epg = new MmtEpgReader();
for await (const chunk of tlv) {
  if (epg.feed(chunk)) {
    for (const event of epg.takeChanged()) console.log(event.name); // "🈑報道１９３０"
  }
}
```

映像・音声・字幕は、1 局に絞った TLV のバイト列から取り出します。局 (MMT_package_id = service_id) を渡します。

```ts
import { MmtMediaReader } from "@danything/arib/mmt-media";
import { ttmlPages } from "@danything/arib/ttml";

const media = new MmtMediaReader(0xa1);
for await (const chunk of tlv) {
  for (const unit of media.feed(chunk)) {
    if (unit.kind === "assets") continue; // 選んだアセットが変わった (受け側を作り直す)
    if (unit.kind === "video") decodeHevc(unit.nals, unit.pts, unit.dts); // 時刻は 90 kHz
    if (unit.kind === "audio")
      decodeAac(unit.frame, unit.config.audioSpecificConfig);
    if (unit.kind === "caption")
      for (const { at, page } of ttmlPages(unit.document, unit.pts))
        draw(at, page);
  }
}
```

```ts
import { B24CaptionDecoder } from "@danything/arib/b24caption";

const captions = new B24CaptionDecoder();
// 字幕の PES の中身 (データ識別 0x80 から) を 1 つずつ渡す
const page = captions.decode(pesPayload);
if (page !== null) draw(page); // 形式は caption-text.ts の CaptionPage
```

## バージョン

[セマンティック バージョニング](https://semver.org/lang/ja/) に従います。互換のない変更 (モジュールや書き出している名前を消す・型や形式を変える) はメジャーバージョンを上げます。

## ライセンス

MIT。字幕の表とデコードの方法は [libaribcaption](https://github.com/xqq/libaribcaption) (MIT)、
外字表の一部は [ariblib](https://github.com/youzaka/ariblib) (MIT)、
JIS X 0213 の表は [x0213.org](https://x0213.org/) の対応表 (自由に使ってよいと書かれたもの) から来ています。
著作権表示は [LICENSE](LICENSE) にあります。
