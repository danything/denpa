/**
 * **字の表の字が、取ってくるフォント (Denpa Font) に全部入っているか。**
 *
 * 字幕 (`b24-tables.ts`)・番組表などの外字 (`aribtext-gaiji.ts`)・DRCS の置き換え先・データ放送
 * (web-bml の表) の字を、Dockerfile が留めている版のリリースの ttf の cmap と突き合わせる。
 * 表に字を足したのにフォントに無いと、その字だけ端末の字で出て見た目が揃わない。
 *
 * 落ちたら: danything/denpa-font の `DENPA_COMMIT` を上げて (元に無い字は描き方を足して) 版を出し、
 * ここの Dockerfile の `DENPA_FONT_VERSION` を上げる (docs/licenses.md)。
 *
 * ttf はイメージに入れず、ここで取ってくる (同じリリースの SHA256SUMS で照らす)。
 * CI では必ず確かめ、手元で取れないとき (オフライン) は飛ばす。
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAIJI } from './aribtext-gaiji';
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
    KANJI_SYMBOLS_HALF,
    KATAKANA,
} from './b24-tables';

/** フォントに入れないと決めた字 (denpa-font の missing.txt と同じ)。いまは無い */
const ALLOWED_MISSING = new Set<number>([]);

const root = join(import.meta.dir, '../../..');
const VERSION = readFileSync(join(root, 'Dockerfile'), 'utf8').match(/^ARG DENPA_FONT_VERSION=(\S+)/m)?.[1];
const RELEASE = `https://github.com/danything/denpa-font/releases/download/${VERSION}`;

/** cmap (format 12 か 4) の字 */
function cmapCodepoints(ttf: Uint8Array): Set<number> {
    const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
    let cmap = -1;
    for (let i = 0; i < v.getUint16(4); i++) {
        const r = 12 + i * 16;
        if (String.fromCharCode(...ttf.subarray(r, r + 4)) === 'cmap') cmap = v.getUint32(r + 8);
    }
    if (cmap < 0) throw new Error('cmap がありません');
    const out = new Set<number>();
    let f4 = -1;
    for (let i = 0; i < v.getUint16(cmap + 2); i++) {
        const off = cmap + v.getUint32(cmap + 8 + i * 8);
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
    if (f4 < 0) throw new Error('cmap に Unicode の表がありません');
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
    };
    for (const [name, value] of Object.entries(strings)) add(value, `b24-tables ${name}`);
    const { jisToUnicodeMap } = require(
        join(root, 'node_modules/web-bml/dist/client/jis_to_unicode_map.js'),
    ) as {
        jisToUnicodeMap: number[];
    };
    // JIS の差分は、放送が使う区点 (JIS X 0208 に字のある区点と外字の 85・86・90〜94 区) の分だけ。
    // 表は JIS X 0213 の字も持っているが、ARIB の放送はその区点を使わない (denpa-font の一覧と同じ)
    const used = (cell: number) => {
        const ku = Math.floor(cell / 94) + 1;
        return (jisToUnicodeMap[cell] ?? -1) >= 0 || ku === 85 || ku === 86 || (ku >= 90 && ku <= 94);
    };
    for (const [start, s] of KANJI_DIFF) {
        [...s].forEach((ch, k) => {
            if (used(start + k)) add(ch, 'b24-tables KANJI_DIFF');
        });
    }
    for (const c of DRCS_REPLACE.values()) add(String.fromCodePoint(c), 'b24-tables DRCS_REPLACE');
    for (const s of GAIJI.values()) add(s, 'aribtext-gaiji GAIJI');
    for (const c of jisToUnicodeMap) {
        // U+EC00〜ECBB は web-bml が自前の DRCS 用フォントで描く
        if (c >= 0 && !(c >= 0xec00 && c <= 0xecbb)) add(String.fromCodePoint(c), 'web-bml jisToUnicodeMap');
    }
    return out;
}

async function get(name: string): Promise<Uint8Array> {
    const res = await fetch(`${RELEASE}/${name}`);
    if (!res.ok) throw new Error(`${RELEASE}/${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

/** リリースの ttf を取り、同じリリースの SHA256SUMS で照らす。手元で取れなければ null */
async function fetchTtf(): Promise<Uint8Array | null> {
    let sums: string;
    let ttf: Uint8Array;
    try {
        sums = new TextDecoder().decode(await get('SHA256SUMS'));
        ttf = await get('denpa-font.ttf');
    } catch (e) {
        if (process.env['CI']) throw e;
        console.warn(`フォントを取れないので飛ばす (オフライン?): ${e}`);
        return null;
    }
    const want = sums.match(/^([0-9a-f]{64}) +denpa-font\.ttf$/m)?.[1];
    expect(createHash('sha256').update(ttf).digest('hex')).toBe(want!);
    return ttf;
}

describe('字の表とフォント', () => {
    test('Dockerfile がフォントの版 (タグ) を留めている', () => {
        expect(VERSION).toMatch(/^v\d+\.\d+$/);
    });

    test('表の字がフォントに全部ある', async () => {
        const ttf = await fetchTtf();
        if (!ttf) return;
        const have = cmapCodepoints(ttf);
        const lack = [...tableCodepoints()]
            .filter(([c]) => !have.has(c) && !ALLOWED_MISSING.has(c))
            .map(
                ([c, where]) =>
                    `U+${c.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(c)} (${where})`,
            );
        // 無い字を全部出す
        expect(lack).toEqual([]);
    }, 60_000);
});
