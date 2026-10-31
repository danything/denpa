/**
 * **字の表の字が、取ってくるフォント (Denpa Font) に全部入っているか。**
 *
 * 字幕と番組表 (`b24-tables.ts`。JIS X 0213 の1面・2面も)・番組表などの外字 (`aribtext-gaiji.ts`)・DRCS の置き換え先・データ放送
 * (`src/lib/bml/euc.ts`。1〜84 区は `TextDecoder('euc-jp')`、85 区から先は `ADDITIONAL`) の字を、Dockerfile が留めているバージョンのリリースの woff2 の 2 つ (基本の字と JIS X 0213 で足された漢字) の cmap と突き合わせる。
 * 表に字を足したのにフォントに無いと、その字だけ端末の字で出て見た目が揃わない。
 *
 * 落ちたら: danything/denpa-font の `DENPA_COMMIT` を上げて (元に無い字は描き方を足して) リリースを出し、
 * ここの Dockerfile の `DENPA_FONT_VERSION` を上げる (docs/licenses.md)。
 *
 * フォントはイメージに入れたものと同じリリースのファイルをここで取ってくる (同じリリースの SHA256SUMS で照らす)。
 * CI では必ず確かめ、手元で取れないとき (オフライン) は飛ばす。
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { GAIJI } from "@danything/arib/aribtext-gaiji";
import {
  ADDITIONAL,
  ALNUM_FULL,
  ALNUM_HALF,
  DRCS_REPLACE,
  HIRAGANA,
  JISX0201,
  JISX0201_HALF,
  KANA_SYMBOLS_HALF,
  KANJI_DIFF,
  KANJI_SEQUENCES,
  KANJI_SYMBOLS_HALF,
  KATAKANA,
  PLANE1_HIGH,
  PLANE2,
} from "@danything/arib/b24-tables";

/** フォントに入れないと決めた字 (denpa-font の missing.txt と同じ)。いまは無い */
const ALLOWED_MISSING = new Set<number>([]);

const root = join(import.meta.dir, "../../..");
const VERSION = readFileSync(join(root, "Dockerfile"), "utf8").match(
  /^ARG DENPA_FONT_VERSION=(\S+)/m,
)?.[1];
const RELEASE = `https://github.com/danything/denpa-font/releases/download/${VERSION}`;

/** 128 進の可変長の数 (WOFF2 の UIntBase128)。[値, 次の位置] */
function base128(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[at + i]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error("WOFF2 の数が長すぎます");
}

/**
 * WOFF2 の cmap の字。**表を展開して cmap だけ読む** — 表は brotli で 1 つに圧縮してあり、
 * 目録の順に並んでいる (glyf・loca・hmtx は変換して詰めてあるので長さが違うが、cmap は元のまま)
 */
function woff2Codepoints(woff2: Uint8Array): Set<number> {
  const v = new DataView(woff2.buffer, woff2.byteOffset, woff2.byteLength);
  if (v.getUint32(0) !== 0x774f4632) throw new Error("WOFF2 ではありません");
  const tables = v.getUint16(12);
  let at = 48;
  let offset = 0;
  let cmap: { offset: number; length: number } | null = null;
  for (let i = 0; i < tables; i++) {
    const flags = woff2[at++]!;
    const known = flags & 0x3f;
    if (known === 63) at += 4; // 目録に無い表は名前が続く
    let length: number;
    [length, at] = base128(woff2, at);
    // glyf (10)・loca (11) は変換の種類 0 が「変換した」、hmtx (3) は 1 が「変換した」。変換した表は詰めた長さが続く
    const transform = flags >> 6;
    const transformed =
      known === 10 || known === 11 ? transform === 0 : transform !== 0;
    if (transformed) [length, at] = base128(woff2, at);
    if (known === 0) cmap = { offset, length };
    offset += length;
  }
  if (cmap === null) throw new Error("cmap がありません");
  const data = new Uint8Array(
    brotliDecompressSync(woff2.subarray(at, at + v.getUint32(20))),
  );
  return cmapCodepoints(
    new DataView(data.buffer, data.byteOffset + cmap.offset, cmap.length),
  );
}

/** cmap (format 12 か 4) の字。`v` は cmap の表 */
function cmapCodepoints(v: DataView): Set<number> {
  const out = new Set<number>();
  let f4 = -1;
  for (let i = 0; i < v.getUint16(2); i++) {
    const off = v.getUint32(8 + i * 8);
    const format = v.getUint16(off);
    if (format === 12) {
      for (let g = 0; g < v.getUint32(off + 12); g++) {
        const r = off + 16 + g * 12;
        for (let c = v.getUint32(r); c <= v.getUint32(r + 4); c++) out.add(c);
      }
      return out;
    }
    if (format === 4) f4 = off;
  }
  if (f4 < 0) throw new Error("cmap に Unicode の表がありません");
  const segs = v.getUint16(f4 + 6) / 2;
  for (let i = 0; i < segs; i++) {
    const end = v.getUint16(f4 + 14 + i * 2);
    const start = v.getUint16(f4 + 16 + segs * 2 + i * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) out.add(c);
  }
  return out;
}

/** 表の字 (出しうる字) → どの表の字か */
function tableCodepoints(): Map<number, string> {
  const out = new Map<number, string>();
  const add = (s: string, where: string) => {
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c >= 0x20 && c !== 0xfffd && !out.has(c)) out.set(c, where);
    }
  };
  const strings = {
    HIRAGANA,
    KATAKANA,
    KANA_SYMBOLS_HALF,
    JISX0201,
    JISX0201_HALF,
    ALNUM_FULL,
    ALNUM_HALF,
    KANJI_SYMBOLS_HALF,
    ADDITIONAL,
    PLANE1_HIGH,
  };
  for (const [name, value] of Object.entries(strings))
    add(value, `b24-tables ${name}`);
  /*
   * 1〜84 区は `TextDecoder('euc-jp')` が返す字 (データ放送の `src/lib/bml/euc.ts` と同じ読み方。
   * 字幕と番組表も EUC-JP で読み、差分 `KANJI_DIFF` と2つのコードポイントの字を足す)。
   * 13 区 (WHATWG の EUC-JP では NEC 特殊文字。JIS X 0213 の1面もほぼ同じ字) も入れる
   */
  const decoder = new TextDecoder("euc-jp");
  for (let cell = 0; cell < 84 * 94; cell++) {
    const ch = decoder.decode(
      Uint8Array.of(0xa1 + Math.floor(cell / 94), 0xa1 + (cell % 94)),
    );
    add(ch, "EUC-JP の 1〜84 区 (データ放送・字幕・番組表)");
  }
  for (const [, s] of KANJI_DIFF) add(s, "b24-tables KANJI_DIFF");
  for (const [, s] of KANJI_SEQUENCES) add(s, "b24-tables KANJI_SEQUENCES");
  for (const [, s] of PLANE2) add(s, "b24-tables PLANE2");
  for (const c of DRCS_REPLACE.values())
    add(String.fromCodePoint(c), "b24-tables DRCS_REPLACE");
  for (const s of GAIJI.values()) add(s, "aribtext-gaiji GAIJI");
  return out;
}

async function get(name: string): Promise<Uint8Array> {
  const res = await fetch(`${RELEASE}/${name}`);
  if (!res.ok) throw new Error(`${RELEASE}/${name}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 配るファイル (イメージに入れるもの。Dockerfile の `denpa-font` 段と同じ) */
const FILES = [
  "denpa-font.woff2",
  "denpa-font-jisx0213.woff2",
  "denpa-font-jisx0213.txt",
] as const;

/** リリースのファイルを取り、同じリリースの SHA256SUMS で照らす。手元で取れなければ null */
async function fetchFiles(): Promise<Uint8Array[] | null> {
  let sums: string;
  let files: Uint8Array[];
  try {
    sums = new TextDecoder().decode(await get("SHA256SUMS"));
    files = await Promise.all(FILES.map(get));
  } catch (e) {
    if (process.env["CI"]) throw e;
    console.warn(`フォントを取れないので飛ばす (オフライン?): ${e}`);
    return null;
  }
  FILES.forEach((name, i) => {
    const want = sums
      .split("\n")
      .find((line) => line.endsWith(` ${name}`))
      ?.slice(0, 64);
    expect(createHash("sha256").update(files[i]!).digest("hex")).toBe(want!);
  });
  return files;
}

/** CSS の unicode-range の値の字 */
function rangeCodepoints(ranges: string): Set<number> {
  const out = new Set<number>();
  for (const part of ranges.trim().split(",")) {
    const [a, b = a] = part.replace(/^U\+/i, "").split("-");
    for (let c = Number.parseInt(a!, 16); c <= Number.parseInt(b!, 16); c++)
      out.add(c);
  }
  return out;
}

describe("字の表とフォント", () => {
  test("Dockerfile がフォントのバージョン (タグ) を留めている", () => {
    expect(VERSION).toMatch(/^v\d+\.\d+$/);
  });

  /*
   * ブラウザが使う 2 つの woff2 (基本の字と JIS X 0213 で足された漢字) を合わせて見る。
   * 後のほうは CSS の unicode-range (`denpa-font-jisx0213.txt`) の字のときだけ取りに行くので、
   * 範囲がそのファイルの字とずれていると、字があっても取りに行かない (か、要らないのに取りに行く)
   */
  test("表の字がフォントに全部ある", async () => {
    const files = await fetchFiles();
    if (!files) return;
    const [base, extra, ranges] = files as [Uint8Array, Uint8Array, Uint8Array];
    const extraHave = woff2Codepoints(extra);
    expect([...rangeCodepoints(new TextDecoder().decode(ranges))]).toEqual([
      ...extraHave,
    ]);
    const have = new Set([...woff2Codepoints(base), ...extraHave]);
    const lack = [...tableCodepoints()]
      .filter(([c]) => !have.has(c) && !ALLOWED_MISSING.has(c))
      .map(
        ([c, where]) =>
          `U+${c.toString(16).toUpperCase().padStart(4, "0")} ${String.fromCodePoint(c)} (${where})`,
      );
    // 無い字を全部出す
    expect(lack).toEqual([]);
  }, 60_000);
});
