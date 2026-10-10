/**
 * 字幕の文字の表 (`src/lib/ts/b24-tables.ts`) を libaribcaption の表から作り直す。
 *
 *     bun scripts/b24-tables.ts <パッチを当てた libaribcaption のソース>
 *
 * 字幕を文字で送る道 (`ts/b24caption.ts`) は、絵にしていた頃と**同じ字**を選ぶ
 * ために libaribcaption の表をそのまま使う。Dockerfile の版を上げたら、同じ版に
 * `patches/libaribcaption-*.patch` を当てたもので作り直すこと。
 *
 * 漢字の表 (7896字) は抱えない。EUC-JP として読めば JIS X 0208 になるので、
 * それと**違うところだけ**を持つ (`aribtext.ts` と同じやり方)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (root === undefined) throw new Error('libaribcaption のソースを渡してください');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** C の配列 `name[] = { ... };` の中身を数にする */
function table(source: string, name: string): number[] {
    const start = source.indexOf(`${name}[]`);
    if (start < 0) throw new Error(`${name} がありません`);
    const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('};', start));
    return [...body.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => Number(m[0]));
}

const conv = read('src/decoder/b24_conv_tables.hpp');
const gaiji = read('src/decoder/b24_gaiji_table.hpp');
const colors = read('src/decoder/b24_colors.cpp');
const drcs = read('src/decoder/b24_drcs_conv.cpp');

/** 94字の表を文字列にする。U+FFFD は規格で空いているところ */
const chars = (codes: number[]) => JSON.stringify(String.fromCodePoint(...codes));

// 漢字は EUC-JP で読んだものと違うところだけ
const kanji = table(conv, 'kKanjiTable');
const euc = new TextDecoder('euc-jp');
const kanjiDiff: [number, number][] = [];
for (let i = 0; i < kanji.length; i++) {
    const ku = Math.floor(i / 94);
    const ten = i % 94;
    const decoded = euc.decode(Uint8Array.of(ku + 0xa1, ten + 0xa1));
    const code = decoded.length > 0 ? decoded.codePointAt(0)! : 0;
    if (code !== kanji[i] || [...decoded].length !== 1) kanjiDiff.push([i, kanji[i]!]);
}

/** 続いている番号を1つにまとめる (表が半分ほどの大きさになる) */
function runs(pairs: [number, number][]): [number, string][] {
    const out: [number, string][] = [];
    let last = -2;
    for (const [i, code] of pairs) {
        const char = String.fromCodePoint(code);
        if (i === last + 1 && out.length > 0) out[out.length - 1]![1] += char;
        else out.push([i, char]);
        last = i;
    }
    return out;
}

const clut = [...colors.matchAll(/ColorRGBA\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g)].map((m) =>
    [m[1], m[2], m[3], m[4]].map((v) => Number(v).toString(16).padStart(2, '0')).join(''),
);

const replacements = [...drcs.matchAll(/\{"([0-9a-f]{32})",\s*(0x[0-9a-f]+)\}/g)].map(
    (m) => `['${m[1]}', 0x${Number(m[2]).toString(16)}]`,
);

const out = `/**
 * 字幕の文字の表。**libaribcaption の表をそのまま写したもの** (scripts/b24-tables.ts で作る。手で直さない)。
 *
 * 絵にしていた頃と同じ字を選ぶため。漢字は EUC-JP で読んだものと違うところだけ持つ。
 * 外字 (DRCS) の置き換え表は denpa が当てているパッチ (patches/libaribcaption-drcs.patch) の分も入る。
 *
 * libaribcaption: Copyright (C) 2021 magicxqq <xqq@xqq.im> (MIT。docs/licenses.md)
 */

/* biome-ignore-all format: 作った表 */

export const HIRAGANA = ${chars(table(conv, 'kHiraganaTable'))};
export const KATAKANA = ${chars(table(conv, 'kKatakanaTable'))};
/** 中くらい (MSZ) のときに半角へ寄せる、かなの表の 0x79 以降 */
export const KANA_SYMBOLS_HALF = ${chars(table(conv, 'kKanaSymbolsTable_Halfwidth'))};
export const JISX0201 = ${chars(table(conv, 'kJISX0201KatakanaTable'))};
export const JISX0201_HALF = ${chars(table(conv, 'kJISX0201KatakanaTable_Halfwidth'))};
export const ALNUM_FULL = ${chars(table(conv, 'kAlphanumericTable_Fullwidth'))};
export const ALNUM_HALF = ${chars(table(conv, 'kAlphanumericTable_Halfwidth'))};
/** 漢字の表の1・2区を、中くらいのときに半角へ寄せたもの */
export const KANJI_SYMBOLS_HALF = ${chars(table(conv, 'kKanjiSymbolsTable_Halfwidth'))};
/** 漢字の表のうち、EUC-JP で読んだものと違うところ。[区×94+点, そこから続く字] の並び */
export const KANJI_DIFF: [number, string][] = ${JSON.stringify(runs(kanjiDiff))};
/** 追加記号・追加漢字 (85区から)。区×94+点の順 */
export const ADDITIONAL = ${chars(table(gaiji, 'kAdditionalSymbolsTable_Unicode'))};
/** 色の表 (CLUT)。8つの組 × 16色、RGBA の16進 */
export const CLUT = ${JSON.stringify(clut)};
/** 外字 (DRCS) の絵の MD5 → 置き換える字 */
export const DRCS_REPLACE = new Map<string, number>([
${replacements.map((line) => `    ${line},`).join('\n')}
]);
`;
writeFileSync('src/lib/ts/b24-tables.ts', out);
console.log(`kanji diff ${kanjiDiff.length}, clut ${clut.length}, drcs ${replacements.length}`);
