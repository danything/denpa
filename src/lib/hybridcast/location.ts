/**
 * **アプリに、自分の本来の置き場所を見せる** (`shim.ts` の `__hcLocation`)。
 *
 * アプリは使い捨てのオリジンの iframe (denpa の `/api/bml/hybridcast`) で動くので、`location.hostname` は denpa の名前になる。
 * NHK のアプリはこの頭 (`hc.nhk.or.jp` の `hc`) から次に開く住所を組み立てる (`https://hc.nhk.jp/hc-home/…`) ので、
 * denpa の中では `https://dp.nhk.jp/…` のような無い住所へ移ろうとして止められていた。
 *
 * ブラウザの `location` は書き換えられないので、**配る script と HTML の中の読み書きを置き換える**。
 * `location.hostname` などを、差し込みが置く `self.__hcLocation` から読ませる — 読むとアプリの元の場所を返し、
 * `href` に入れる・`assign`・`replace`・`reload` は、iframe ごと移らずに親に開き直してもらう (使い捨てのオリジンの
 * iframe の中では、Navigation API で移動を止められなかった)。
 *
 * **扱えないもの:** `location = …`・`window.location = …` と location そのものに入れる書き方と、`<a href>` を押して移るもの。
 * これらは今までどおり iframe ごと移ろうとして止められる (NHK のアプリは `location.href = …` で移る)。
 * 文字列やコメントの中の `location.href` も置き換わるが、読む先が変わるだけで害は無い
 */

/** `hash` は入れない — ハッシュで画面を切り替えるアプリは、iframe の中の本物の `location.hash` を書き換えて動く */
const PARTS =
  "hostname|host|origin|href|protocol|port|pathname|search|assign|replace|reload";
const READ = new RegExp(
  `(?<![\\w$.])(?:(?:window|self|document)\\.)?location\\.(${PARTS})\\b`,
  "g",
);

/** 文字の中の `location.hostname` などを、差し込みの `__hcLocation` を通すものに置き換える */
export function rewriteLocation(text: string): string {
  return text.replace(
    READ,
    (_, part: string) => `(self.__hcLocation||location).${part}`,
  );
}

/** script と HTML か (中の `location.hostname` などを置き換えるもの) */
export function scriptable(contentType: string): boolean {
  return /javascript|ecmascript|html/i.test(contentType);
}

/**
 * バイトのまま置き換える (中継で配る script・HTML と、アプリが通信で取って実行する script。jQuery の `getScript` など)。
 * 置き換えるのは ASCII だけなので、1 バイトを 1 字として読めば文字の符号に関係なく壊さない
 */
export function rewriteLocationBytes(body: Uint8Array): Uint8Array {
  let text = "";
  for (let i = 0; i < body.length; i += 0x8000)
    text += String.fromCharCode(...body.subarray(i, i + 0x8000));
  const out = rewriteLocation(text);
  if (out === text) return body;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
