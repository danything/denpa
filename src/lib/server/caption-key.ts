import { searchable } from "./title";

/**
 * **字幕で探すための文字の揃え方** (`caption-index.ts` が入れ、`search.searchCaptions` が探す)。入れる側と探す側は、必ずここを通す。
 *
 * 1. 揃える (`captionKey`)。空白と制御文字を消し、残りを 1 字ずつ `title.searchable` に通す (検索のほかの節と同じ揃え方)。
 *    字幕は 1 文を 2 行に分けて出すことが多く (「東京都の」「天気は」)、行の間の空白を残すと「東京都の天気」が当たらない
 * 2. 2 字ずつ重ねて区切る (`captionGrams`)。FTS5 は区切ったもの 1 つを 1 語として持つ (`drizzle/0047_caption-fts.sql`)
 * 3. 探す語も同じように揃えて区切り、フレーズで引く (`captionMatch`)。当たった行は、揃えた文字が語をそのまま含むかで確かめ直す (`captionHits`)
 *
 * 1 字の語はインデックスで引けない (2 字ずつ区切るため)。ほかの語と一緒なら確かめ直すときにだけ見て、
 * 語がどれも 1 字ならインデックスを引かない (`captionMatch` が null)
 */

/** 消す字。空白 (全角も) と制御文字・書式の字 (ゼロ幅の空白など) */
const DROP = /[\s\p{Cc}\p{Cf}]/u;

/**
 * 揃えた文字と、その 1 文字 (UTF-16 の 1 単位) ごとの、元の文字の中の位置。当たった所を元の文字に印を付けて見せるのに使う (`captionHits`)
 */
export interface CaptionKey {
  key: string;
  /** `key` の i 番目の単位が来た、元の文字の中の位置 (UTF-16)。外字を昔の書き方に開いた字は、同じ位置が続く */
  from: number[];
  /** 元の文字の、その位置の字の終わり (UTF-16)。`from` と同じ並び */
  to: number[];
}

export function captionKey(text: string): CaptionKey {
  let key = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const char of text) {
    const end = at + char.length;
    if (!DROP.test(char)) {
      const folded = searchable(char);
      key += folded;
      for (let i = 0; i < folded.length; i++) {
        from.push(at);
        to.push(end);
      }
    }
    at = end;
  }
  return { key, from, to };
}

/** 揃えた文字を 2 字ずつ重ねて区切り、空白でつなぐ。1 字だけならその字。空なら空 */
export function captionGrams(key: string): string {
  const chars = [...key];
  if (chars.length <= 1) return key;
  const grams: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++)
    grams.push(chars[i]! + chars[i + 1]!);
  return grams.join(" ");
}

/** 探す語を揃える。空になった語は落とす */
export function captionTerms(words: readonly string[]): string[] {
  return words.map((word) => captionKey(word).key).filter((key) => key !== "");
}

/**
 * FTS5 の MATCH の式。2 字以上の語をそれぞれフレーズにして AND でつなぐ。
 * **2 字以上の語が 1 つも無ければ null** (式を空にしない。空の式は FTS5 が構文の誤りにする)
 *
 * @param keys 揃えた語 (`captionTerms`)
 */
export function captionMatch(keys: readonly string[]): string | null {
  const phrases = keys
    .filter((key) => [...key].length >= 2)
    .map((key) => `"${captionGrams(key).replaceAll('"', '""')}"`);
  return phrases.length === 0 ? null : phrases.join(" AND ");
}

/**
 * 字幕の 1 枚が語をすべて含むかを確かめ、含めば当たった所 (元の文字の中の [始め, 終わり)。重なりはまとめる) を返す。含まなければ null
 *
 * @param keys 揃えた語 (`captionTerms`)
 */
export function captionHits(
  text: string,
  keys: readonly string[],
): [number, number][] | null {
  const { key, from, to } = captionKey(text);
  const spans: [number, number][] = [];
  for (const word of keys) {
    let at = key.indexOf(word);
    if (at < 0) return null;
    while (at >= 0) {
      spans.push([from[at]!, to[at + word.length - 1]!]);
      at = key.indexOf(word, at + word.length);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span[0] <= last[1])
      last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}
