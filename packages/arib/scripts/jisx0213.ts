/**
 * `src/b24-tables.ts` の JIS X 0213 の表 (`KANJI_SEQUENCES`・`PLANE1_HIGH_ROWS`・`PLANE2`) を書く。
 * `bun packages/arib/scripts/jisx0213.ts` で、印 (「ここから JIS X 0213 の表」〜「ここまで」) の間を書き直す。
 *
 * 元は x0213.org の対応表 (jisx0213-2004-std.txt。「You can use, modify, distribute this table freely.」)。
 * 2009 年から変わっていないので、SHA-256 で留めて取る。
 *
 * 1面の 1〜84区は字幕の漢字の表 (EUC-JP + `KANJI_DIFF`) が元からほぼ同じ字を出す。違ってよいのは
 * 対応表が「Fullwidth」と書き添えた全角の字、`ARIB_CHOICES`、2つのコードポイントで表す字
 * (`KANJI_SEQUENCES` に書く) だけ。ほかに違いがあれば止める
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { KANJI_DIFF } from "../src/b24-tables.js";

const URL_ = "https://x0213.org/codetable/jisx0213-2004-std.txt";
const SHA256 =
  "388ae7822cbf0aecff09b8466dd630ea343673d01a3c7df9d61947ad1ad5b2dd";
const TABLES = new URL("../src/b24-tables.ts", import.meta.url);
const BEGIN = "// ここから JIS X 0213 の表";
const END = "// ここまで JIS X 0213 の表";

/**
 * 字幕の表が JIS X 0213 と違えている区点 (区×94+点。0 から)。libaribcaption の表のとおりで、
 * 放送の字 (全角の形・Windows と同じ字) に合わせたもの
 */
const ARIB_CHOICES = new Map<number, string>([
  [16, "￣ (JIS X 0213 は ‾)"],
  [28, "― (JIS X 0213 は —)"],
  [78, "￥ (JIS X 0213 は ¥)"],
  [80, "￠ (JIS X 0213 は ¢)"],
  [81, "￡ (JIS X 0213 は £)"],
  [137, "￢ (JIS X 0213 は ¬)"],
  [147, "⦅ (JIS X 0213 は ｟)"],
  [148, "⦆ (JIS X 0213 は ｠)"],
]);

const res = await fetch(URL_);
if (!res.ok) throw new Error(`${URL_}: ${res.status}`);
const raw = new Uint8Array(await res.arrayBuffer());
const sum = createHash("sha256").update(raw).digest("hex");
if (sum !== SHA256) throw new Error(`${URL_} の SHA-256 が違う: ${sum}`);

/** 面 → 区点 (0 から) → 字 (コードポイント1つか2つ) */
const planes = new Map<number, Map<number, string>>([
  [1, new Map()],
  [2, new Map()],
]);
/** 1面で、対応表が全角の字も書き添えている区点 → 全角の字 */
const fullwidth = new Map<number, string>();
for (const line of new TextDecoder().decode(raw).split("\n")) {
  const m = line.match(
    /^([34])-([0-9A-F]{4})\tU\+([0-9A-F+]+)\t.*?(?:Fullwidth: U\+([0-9A-F]+))?$/,
  );
  if (!m) continue;
  const code = Number.parseInt(m[2]!, 16);
  const cell = ((code >> 8) - 0x21) * 94 + (code & 0xff) - 0x21;
  const chars = m[3]!.split("+").map((h) => Number.parseInt(h, 16));
  planes.get(m[1] === "3" ? 1 : 2)!.set(cell, String.fromCodePoint(...chars));
  if (m[1] === "3" && m[4])
    fullwidth.set(cell, String.fromCodePoint(Number.parseInt(m[4], 16)));
}
const plane1 = planes.get(1)!;
const plane2 = planes.get(2)!;

// 1〜84区を字幕の表と突き合わせる
const eucjp = new TextDecoder("euc-jp");
const diff = new Map<number, string>();
for (const [start, chars] of KANJI_DIFF) {
  let i = start;
  for (const char of chars) diff.set(i++, char);
}
const caption = (cell: number) =>
  diff.get(cell) ??
  eucjp.decode(Uint8Array.of(Math.floor(cell / 94) + 0xa1, (cell % 94) + 0xa1));
const sequences: [number, string][] = [];
const wrong: string[] = [];
for (let cell = 0; cell < 84 * 94; cell++) {
  const want = plane1.get(cell) ?? "�";
  const have = caption(cell);
  if (have === want || have === fullwidth.get(cell) || ARIB_CHOICES.has(cell))
    continue;
  if ([...want].length > 1 && have === "�") sequences.push([cell, want]);
  else wrong.push(`${kuten(cell)}: 字幕の表は ${have}、JIS X 0213 は ${want}`);
}
if (wrong.length > 0)
  throw new Error(`字幕の表と JIS X 0213 が違う:\n${wrong.join("\n")}`);

function kuten(cell: number): string {
  return `${Math.floor(cell / 94) + 1}区${(cell % 94) + 1}点`;
}

/** 区の 94 字 (空きは U+FFFD) */
function row(plane: Map<number, string>, ku: number): string {
  let out = "";
  for (let ten = 0; ten < 94; ten++) {
    const char = plane.get((ku - 1) * 94 + ten) ?? "�";
    if ([...char].length > 1)
      throw new Error(`${kuten((ku - 1) * 94 + ten)} が2字`);
    out += char;
  }
  return out;
}

const lines = [
  BEGIN + " (packages/arib/scripts/jisx0213.ts が書く。手で直さない)",
  "/**",
  " * JIS X 0213:2004 の1面で、2つのコードポイントで表す字 (半濁点の付いたかな・発音記号と、声調の組)。",
  " * [区×94+点 (0 から), 字]。字幕は1区画、番組表は2つのコードポイントのまま出す",
  " */",
  "export const KANJI_SEQUENCES: [number, string][] = [",
  ...sequences.map(([cell, s]) => `    [${cell}, "${s}"], // ${kuten(cell)}`),
  "];",
  "/**",
  " * JIS X 0213:2004 の1面の 85〜94区 (第3水準の漢字)。JIS互換漢字1面 (終端 0x39) だけが引く。",
  " * 漢字集合 (0x42) と追加記号 (0x3B) の 85区から先は `ADDITIONAL`",
  " */",
  "const PLANE1_HIGH_ROWS: string[] = [",
  ...Array.from(
    { length: 10 },
    (_, k) => `    "${row(plane1, 85 + k)}", // ${85 + k}区`,
  ),
  "];",
  "/** `PLANE1_HIGH_ROWS` を1つの文字列にしたもの。(区 − 85) × 94 + (点 − 1) 番目のコードポイント */",
  "export const PLANE1_HIGH = PLANE1_HIGH_ROWS.join('');",
  "/**",
  " * JIS X 0213:2004 の2面 (JIS互換漢字2面。終端 0x3A)。[区, 94 字 (点の順)]。字のある区だけ",
  " */",
  "export const PLANE2: [number, string][] = [",
  ...[...new Set([...plane2.keys()].map((cell) => Math.floor(cell / 94) + 1))]
    .sort((a, b) => a - b)
    .map((ku) => `    [${ku}, "${row(plane2, ku)}"],`),
  "];",
  END,
];

const text = readFileSync(TABLES, "utf8");
const from = text.indexOf(BEGIN);
const to = text.indexOf(END);
if (from < 0 || to < from)
  throw new Error(`b24-tables.ts に印 (${BEGIN}) が無い`);
writeFileSync(
  TABLES,
  text.slice(0, from) + lines.join("\n") + text.slice(to + END.length),
);
console.log(
  `書いた: 2つのコードポイントの字 ${sequences.length}、1面 85〜94区、2面 ${plane2.size} 字`,
);
