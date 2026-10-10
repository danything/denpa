/**
 * 放送の字幕 (ARIB STD-B24 の字幕文) を解いて、**字の置き場所まで決める** ([caption-text.ts](../caption-text.ts))。
 *
 * 絵にしていた頃 (ffmpeg の `-sub_type bitmap`) の中身は libaribcaption で、あちらは
 * 「解く (decoder)」と「描く (renderer)」が分かれている。ここは**解く側をそのまま写した
 * もの** — 置き場所・大きさ・色・外字の置き換えまでは同じ計算で、絵にする手前で止める。
 * 描くのは受け側 (ブラウザ・アプリ)。
 *
 * 写したのは日本の放送で要るところだけ: 8単位符号 (JIS)・Profile A (フルセグ)・第1言語。
 * ブラジルの Latin・UTF-8・ワンセグ (Profile C) は持たない。
 *
 * ## libaribcaption と違えたところ
 *
 * - **字幕管理データの「送り直し」の見分け。** あちらは群 (A/B) を `(id & 0xF0) >> 8` で
 *   取っていて常に 0 になり、最初の1回しか読まない。ここは群を正しく見る
 *   (番組が変わって群が替わったときに書式を読み直す)
 * - **点滅 (FLC) を拾う。** あちらは読み捨てている
 *
 * 入力は字幕の PES の中身 (データ識別 0x80 から)。ffmpeg が `-c:s copy` で Matroska
 * (`S_ARIBSUB`) に入れたコマの中身がそのままこれになる。
 */

import { createHash } from 'node:crypto';
import { CAPTION_TEXT_VERSION, type CaptionDrcs, type CaptionPage, type CaptionRun } from '../caption-text';
import {
    ADDITIONAL,
    ALNUM_FULL,
    ALNUM_HALF,
    CLUT,
    DRCS_REPLACE,
    HIRAGANA,
    JISX0201,
    JISX0201_HALF,
    KANA_SYMBOLS_HALF,
    KANJI_DIFF,
    KANJI_SYMBOLS_HALF,
    KATAKANA,
} from './b24-tables';

/** 符号の集合。DRCS は 0〜15 の面 */
type GraphicSet =
    | 'kanji'
    | 'alnum'
    | 'hiragana'
    | 'katakana'
    | 'mosaic'
    | 'jisx0201'
    | 'additional'
    | 'macro'
    | { drcs: number };

interface Entry {
    set: GraphicSet;
    bytes: 1 | 2;
}

const KANJI: Entry = { set: 'kanji', bytes: 2 };
const ALNUM: Entry = { set: 'alnum', bytes: 1 };
const HIRA: Entry = { set: 'hiragana', bytes: 1 };
const KATA: Entry = { set: 'katakana', bytes: 1 };
const MACRO: Entry = { set: 'macro', bytes: 1 };
const MOSAIC: Entry = { set: 'mosaic', bytes: 1 };

/** 終端バイト → 集合 (G の指示)。プロポーショナルも JIS X 0213 も同じ表で引く (libaribcaption と同じ) */
const G_SETS = new Map<number, Entry>([
    [0x42, KANJI],
    [0x4a, ALNUM],
    [0x30, HIRA],
    [0x31, KATA],
    [0x32, MOSAIC],
    [0x33, MOSAIC],
    [0x34, MOSAIC],
    [0x35, MOSAIC],
    [0x36, ALNUM],
    [0x37, HIRA],
    [0x38, KATA],
    [0x49, { set: 'jisx0201', bytes: 1 }],
    [0x39, KANJI],
    [0x3a, KANJI],
    [0x3b, { set: 'additional', bytes: 2 }],
]);

/** 終端バイト → DRCS の面 (0x40 は2バイトの面 0)。0x70 はマクロ */
function drcsSet(final: number): Entry | undefined {
    if (final === 0x70) return MACRO;
    if (final < 0x40 || final > 0x4f) return undefined;
    const index = final - 0x40;
    return { set: { drcs: index }, bytes: index === 0 ? 2 : 1 };
}

/** 既定のマクロ (0x60〜0x6F)。符号の集合を組み替えるだけ */
const MACROS: number[][] = [
    [0x1b, 0x24, 0x42, 0x1b, 0x29, 0x4a, 0x1b, 0x2a, 0x30, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x24, 0x42, 0x1b, 0x29, 0x31, 0x1b, 0x2a, 0x30, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x24, 0x42, 0x1b, 0x29, 0x20, 0x41, 0x1b, 0x2a, 0x30, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x28, 0x32, 0x1b, 0x29, 0x34, 0x1b, 0x2a, 0x35, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x28, 0x32, 0x1b, 0x29, 0x33, 0x1b, 0x2a, 0x35, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x28, 0x32, 0x1b, 0x29, 0x20, 0x41, 0x1b, 0x2a, 0x35, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [
        0x1b, 0x28, 0x20, 0x41, 0x1b, 0x29, 0x20, 0x42, 0x1b, 0x2a, 0x20, 0x43, 0x1b, 0x2b, 0x20, 0x70, 0x0f,
        0x1b, 0x7d,
    ],
    [
        0x1b, 0x28, 0x20, 0x44, 0x1b, 0x29, 0x20, 0x45, 0x1b, 0x2a, 0x20, 0x46, 0x1b, 0x2b, 0x20, 0x70, 0x0f,
        0x1b, 0x7d,
    ],
    [
        0x1b, 0x28, 0x20, 0x47, 0x1b, 0x29, 0x20, 0x48, 0x1b, 0x2a, 0x20, 0x49, 0x1b, 0x2b, 0x20, 0x70, 0x0f,
        0x1b, 0x7d,
    ],
    [
        0x1b, 0x28, 0x20, 0x4a, 0x1b, 0x29, 0x20, 0x4b, 0x1b, 0x2a, 0x20, 0x4c, 0x1b, 0x2b, 0x20, 0x70, 0x0f,
        0x1b, 0x7d,
    ],
    [
        0x1b, 0x28, 0x20, 0x4d, 0x1b, 0x29, 0x20, 0x4e, 0x1b, 0x2a, 0x20, 0x4f, 0x1b, 0x2b, 0x20, 0x70, 0x0f,
        0x1b, 0x7d,
    ],
    [0x1b, 0x24, 0x42, 0x1b, 0x29, 0x20, 0x42, 0x1b, 0x2a, 0x30, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x24, 0x42, 0x1b, 0x29, 0x20, 0x43, 0x1b, 0x2a, 0x30, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x24, 0x42, 0x1b, 0x29, 0x20, 0x44, 0x1b, 0x2a, 0x30, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x28, 0x31, 0x1b, 0x29, 0x30, 0x1b, 0x2a, 0x4a, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
    [0x1b, 0x28, 0x4a, 0x1b, 0x29, 0x32, 0x1b, 0x2a, 0x20, 0x41, 0x1b, 0x2b, 0x20, 0x70, 0x0f, 0x1b, 0x7d],
];

const eucjp = new TextDecoder('euc-jp');
/** 漢字の表 (区×94+点 → 字)。EUC-JP で読み、libaribcaption と違うところだけ差し替える */
const kanjiOverride = new Map<number, number>();
for (const [start, chars] of KANJI_DIFF) {
    let i = start;
    for (const char of chars) kanjiOverride.set(i++, char.codePointAt(0)!);
}
const kanjiCache = new Map<number, number>();
function kanji(index: number): number {
    const known = kanjiOverride.get(index) ?? kanjiCache.get(index);
    if (known !== undefined) return known;
    const text = eucjp.decode(Uint8Array.of(Math.floor(index / 94) + 0xa1, (index % 94) + 0xa1));
    const code = text.codePointAt(0) ?? 0xfffd;
    kanjiCache.set(index, code);
    return code;
}

/** 表の文字列から i 番目のコードポイント (サロゲートを跨ぐので配列にしておく) */
const points = (table: string) => [...table].map((c) => c.codePointAt(0)!);
const T = {
    hiragana: points(HIRAGANA),
    katakana: points(KATAKANA),
    kanaHalf: points(KANA_SYMBOLS_HALF),
    jisx0201: points(JISX0201),
    jisx0201Half: points(JISX0201_HALF),
    alnumFull: points(ALNUM_FULL),
    alnumHalf: points(ALNUM_HALF),
    kanjiHalf: points(KANJI_SYMBOLS_HALF),
    additional: points(ADDITIONAL),
};

/** 色。CLUT の組 (0〜7) と番号 (0〜15) */
function clut(palette: number, index: number): string {
    return `#${CLUT[palette * 16 + index] ?? CLUT[index]}`;
}

/** 半角の字 (libaribcaption の IsHalfwidthCharacter)。中くらいでも縮めずに描く */
function isHalfwidth(code: number): boolean {
    return (
        (code !== 0 && code <= 0xff) ||
        (code >= 0xff61 && code <= 0xff9f) ||
        (code >= 0xffe8 && code <= 0xffee)
    );
}

interface Drcs {
    width: number;
    height: number;
    depth: number;
    bits: number;
    pixels: Uint8Array;
    /** 置き換えられた字。無ければ絵のまま */
    replaced: number | null;
}

/** 解いた1字。libaribcaption の CaptionChar と同じもの */
interface Char {
    code: number;
    /** 置き換えられなかった外字 */
    drcs: number | null;
    x: number;
    y: number;
    charWidth: number;
    charHeight: number;
    hSpacing: number;
    vSpacing: number;
    hScale: number;
    vScale: number;
    fg: string;
    bg: string;
    stroke: string | null;
    underline: boolean;
    bold: boolean;
    italic: boolean;
    box: number;
    flash: boolean;
    ruby: boolean;
}

/** 解いた1枚。CS と TIME のあった印つき */
interface Caption {
    chars: Char[];
    clear: boolean;
    /** TIME で言われた待ち時間 (ms)。言われなければ null */
    wait: number | null;
    drcs: Map<number, Drcs>;
}

/**
 * 字幕の流れ1本ぶんの解き手。**状態を持つ** (書式・位置・色・外字は字幕文を跨いで続く) ので、
 * 流れごとに1つ作って、届いた順に食わせる。
 */
export class B24CaptionDecoder {
    private gx: Entry[] = [KANJI, ALNUM, HIRA, MACRO];
    private gl = 0;
    private gr = 2;
    private readonly drcsMaps: Map<number, Drcs>[] = Array.from({ length: 16 }, () => new Map());
    private prevGroup = -1;

    private swf = 7;
    private planeWidth = 960;
    private planeHeight = 540;
    private areaWidth = 960;
    private areaHeight = 540;
    private areaX = 0;
    private areaY = 0;
    private posInited = false;
    private posX = 0;
    private posY = 0;
    private charWidth = 36;
    private charHeight = 36;
    private hSpacing = 4;
    private vSpacing = 24;
    private hScale = 1;
    private vScale = 1;
    private underline = false;
    private bold = false;
    private italic = false;
    private stroke: string | null = null;
    private box = 0;
    private flash = false;
    private palette = 0;
    private fg = clut(0, 7);
    private bg = clut(0, 8);

    private caption: Caption = { chars: [], clear: false, wait: null, drcs: new Map() };

    constructor() {
        this.resetState();
    }

    /**
     * 字幕の PES の中身を1つ食わせる。
     *
     * @returns 出す1枚。出すものが無ければ (字幕管理データ・送り直し・待ちだけの字幕文) null
     */
    decode(data: Uint8Array): CaptionPage | null {
        if (data.length < 3) return null;
        // データ識別 (0x80 = 字幕) と私的ストリーム識別 (0xFF)
        if (data[0] !== 0x80 || data[1] !== 0xff) return null;
        const begin = 3 + (data[2]! & 0x0f);
        if (begin + 5 > data.length) return null;
        const groupId = data[begin]! >> 2;
        const size = (data[begin + 3]! << 8) | data[begin + 4]!;
        if (size === 0 || begin + 5 + size > data.length) return null;
        const body = data.subarray(begin + 5, begin + 5 + size);

        this.caption = { chars: [], clear: false, wait: null, drcs: new Map() };
        const id = groupId & 0x0f;
        const group = groupId >> 4;
        if (id === 0) {
            // 字幕管理データ。**同じ群は送り直し** (ARIB TR-B14 4.2.4)
            if (group === this.prevGroup) return null;
            this.prevGroup = group;
            this.management(body);
        } else {
            // 第1言語の字幕文だけ (ffmpeg も第1言語で解く)
            if (id !== 1) return null;
            this.statement(body);
        }
        return toPage(this.caption, [this.planeWidth, this.planeHeight]);
    }

    private resetGraphicSets(): void {
        this.gx = [KANJI, ALNUM, HIRA, MACRO];
        this.gl = 0;
        this.gr = 2;
    }

    /** 書式 (SWF) に合わせた面と字の大きさ。Profile A の表 */
    private resetWritingFormat(): void {
        const [w, h, hs, vs] =
            this.swf === 5
                ? [1920, 1080, 4, 24]
                : this.swf === 8
                  ? [960, 540, 12, 24]
                  : this.swf === 9
                    ? [720, 480, 4, 16]
                    : this.swf === 10
                      ? [720, 480, 8, 24]
                      : [960, 540, 4, 24];
        this.planeWidth = this.areaWidth = w;
        this.planeHeight = this.areaHeight = h;
        this.charWidth = 36;
        this.charHeight = 36;
        this.hSpacing = hs;
        this.vSpacing = vs;
    }

    private resetState(): void {
        this.resetGraphicSets();
        this.resetWritingFormat();
        this.areaX = 0;
        this.areaY = 0;
        this.posInited = false;
        this.posX = 0;
        this.posY = 0;
        this.hScale = 1;
        this.vScale = 1;
        this.underline = false;
        this.bold = false;
        this.italic = false;
        this.stroke = null;
        this.box = 0;
        this.flash = false;
        this.palette = 0;
        this.fg = clut(0, 7);
        this.bg = clut(0, 8);
    }

    private management(data: Uint8Array): void {
        if (data.length < 10) return;
        let at = 1;
        if (data[0]! >> 6 === 0b10) at += 5; // OTM
        const languages = data[at++]!;
        if (languages === 0 || languages > 2) return;
        for (let i = 0; i < languages; i++) {
            if (at + 6 > data.length) return;
            const tag = data[at]! >> 5;
            const dmf = data[at]! & 0x0f;
            at += 1;
            if (dmf === 0b1100 || dmf === 0b1101 || dmf === 0b1110) at += 1;
            at += 3; // ISO 639
            const format = data[at]! >> 4;
            at += 1;
            if (tag === 0) {
                this.swf = format - 1;
                this.resetGraphicSets();
                this.resetWritingFormat();
            }
        }
        if (at + 3 > data.length) return;
        const length = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
        at += 3;
        if (length > 0 && at + length <= data.length) this.dataUnits(data.subarray(at, at + length));
    }

    private statement(data: Uint8Array): void {
        if (data.length < 4) return;
        let at = 1;
        const tmd = data[0]! >> 6;
        if (tmd === 0b01 || tmd === 0b10) at += 5; // STM
        if (at + 4 > data.length) return;
        const length = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
        at += 3;
        if (length > 0 && at + length <= data.length) this.dataUnits(data.subarray(at, at + length));
    }

    private dataUnits(data: Uint8Array): void {
        let at = 0;
        while (at + 5 <= data.length) {
            if (data[at] !== 0x1f) return;
            const parameter = data[at + 1]!;
            const size = (data[at + 2]! << 16) | (data[at + 3]! << 8) | data[at + 4]!;
            if (size === 0 || at + 5 + size > data.length) return;
            const unit = data.subarray(at + 5, at + 5 + size);
            if (parameter === 0x20) this.body(unit);
            else if (parameter === 0x30) this.defineDrcs(unit, 1);
            else if (parameter === 0x31) this.defineDrcs(unit, 2);
            at += 5 + size;
        }
    }

    /** 本文。**読めないところで止める** (そこまでの字は出す。libaribcaption と同じ) */
    private body(data: Uint8Array): void {
        let at = 0;
        while (at < data.length) {
            const byte = data[at]!;
            const used =
                byte <= 0x20
                    ? this.c0(data, at)
                    : byte < 0x7f
                      ? this.graphic(data, at, this.gx[this.gl]!)
                      : byte <= 0xa0
                        ? this.c1(data, at)
                        : byte < 0xff
                          ? this.graphic(data, at, this.gx[this.gr]!)
                          : 0;
            if (used <= 0) return;
            at += used;
        }
    }

    private defineDrcs(data: Uint8Array, byteCount: 1 | 2): void {
        if (data.length === 0) return;
        let at = 1;
        const codes = data[0]!;
        for (let i = 0; i < codes; i++) {
            if (at + 3 > data.length) return;
            const code = (data[at]! << 8) | data[at + 1]!;
            const fonts = data[at + 2]!;
            at += 3;
            for (let j = 0; j < fonts; j++) {
                if (at + 4 > data.length) return;
                const mode = data[at]! & 0x0f;
                at += 1;
                if (mode === 0b0000 || mode === 0b0001) {
                    const depth = data[at]! + 2;
                    const width = data[at + 1]!;
                    const height = data[at + 2]!;
                    at += 3;
                    let bits = 0;
                    for (let n = depth - 1; n > 0; n >>= 1) bits++;
                    const size = Math.ceil((width * height * bits) / 8);
                    if (at + size > data.length) return;
                    const pixels = data.slice(at, at + size);
                    at += size;
                    const md5 = createHash('md5').update(pixels).digest('hex');
                    const drcs: Drcs = {
                        width,
                        height,
                        depth,
                        bits,
                        pixels,
                        replaced: DRCS_REPLACE.get(md5) ?? null,
                    };
                    if (byteCount === 1) {
                        const set = drcsSet(((code & 0x0f00) >> 8) + 0x40);
                        if (set !== undefined && typeof set.set === 'object') {
                            this.drcsMaps[set.set.drcs]!.set(code & 0x7f, drcs);
                        }
                    } else {
                        const key = code >= 0xec00 && code <= 0xf8ff ? code : code & 0x7f7f;
                        this.drcsMaps[0]!.set(key, drcs);
                    }
                } else {
                    // 幾何図形。読み飛ばす
                    if (at + 4 > data.length) return;
                    at += 4 + ((data[at + 2]! << 8) | data[at + 3]!);
                }
            }
        }
    }

    /** @returns 使ったバイト数。0 なら読めない */
    private c0(data: Uint8Array, at: number): number {
        const rest = data.length - at;
        switch (data[at]) {
            case 0x08: // APB
                this.moveRelative(-1, 0);
                return 1;
            case 0x09: // APF
                this.moveRelative(1, 0);
                return 1;
            case 0x0a: // APD
                this.moveRelative(0, 1);
                return 1;
            case 0x0b: // APU
                this.moveRelative(0, -1);
                return 1;
            case 0x0c: // CS
                this.resetState();
                this.caption.clear = true;
                return 1;
            case 0x0d: // APR
                this.newline();
                return 1;
            case 0x0e: // LS1
                this.gl = 1;
                return 1;
            case 0x0f: // LS0
                this.gl = 0;
                return 1;
            case 0x16: // PAPF
                if (rest < 2) return 0;
                this.moveRelative(data[at + 1]! & 0x3f, 0);
                return 2;
            case 0x19: // SS2
            case 0x1d: {
                // SS3
                if (rest < 2) return 0;
                const used = this.graphic(data, at + 1, this.gx[data[at] === 0x19 ? 2 : 3]!);
                return used <= 0 ? 0 : 1 + used;
            }
            case 0x1b: {
                if (rest < 2) return 0;
                const used = this.escape(data, at + 1);
                return used < 0 ? 0 : 1 + used;
            }
            case 0x1c: // APS
                if (rest < 3) return 0;
                this.setAbsolute(data[at + 2]! & 0x3f, data[at + 1]! & 0x3f);
                return 3;
            case 0x20: // SP
                this.push(this.msz() ? 0x20 : 0x3000);
                this.moveRelative(1, 0);
                return 1;
            default:
                return 1;
        }
    }

    private escape(data: Uint8Array, at: number): number {
        const rest = data.length - at;
        const byte = data[at]!;
        switch (byte) {
            case 0x6e: // LS2
                this.gl = 2;
                return 1;
            case 0x6f: // LS3
                this.gl = 3;
                return 1;
            case 0x7e: // LS1R
                this.gr = 1;
                return 1;
            case 0x7d: // LS2R
                this.gr = 2;
                return 1;
            case 0x7c: // LS3R
                this.gr = 3;
                return 1;
        }
        if (byte === 0x24) {
            if (rest < 2) return -1;
            const next = data[at + 1]!;
            if (next >= 0x28 && next <= 0x2b) {
                if (rest < 3) return -1;
                if (data[at + 2] === 0x20) {
                    if (rest < 4) return -1;
                    const set = drcsSet(data[at + 3]!);
                    if (set !== undefined) this.gx[next - 0x28] = set;
                    return 4;
                }
                const set = G_SETS.get(data[at + 2]!);
                if (set !== undefined) this.gx[next - 0x28] = set;
                return 3;
            }
            const set = G_SETS.get(next);
            if (set !== undefined) this.gx[0] = set;
            return 2;
        }
        if (byte >= 0x28 && byte <= 0x2b) {
            if (rest < 2) return -1;
            if (data[at + 1] === 0x20) {
                if (rest < 3) return -1;
                const set = drcsSet(data[at + 2]!);
                if (set !== undefined) this.gx[byte - 0x28] = set;
                return 3;
            }
            const set = G_SETS.get(data[at + 1]!);
            if (set !== undefined) this.gx[byte - 0x28] = set;
            return 2;
        }
        // 知らない ESC は、ESC 1バイトだけ読んだことにする (libaribcaption と同じ)
        return 0;
    }

    private c1(data: Uint8Array, at: number): number {
        const rest = data.length - at;
        const byte = data[at]!;
        if (byte >= 0x80 && byte <= 0x87) {
            // BKF〜WHF
            this.fg = clut(this.palette, byte - 0x80);
            return 1;
        }
        switch (byte) {
            case 0x90: {
                // COL
                if (rest < 2) return 0;
                const p = data[at + 1]!;
                if (p === 0x20) {
                    if (rest < 3) return 0;
                    this.palette = data[at + 2]! & 0x07;
                    return 3;
                }
                if (p >= 0x48 && p <= 0x7f) {
                    if ((p & 0xf0) === 0x40) this.fg = clut(this.palette, p & 0x0f);
                    else if ((p & 0xf0) === 0x50) this.bg = clut(this.palette, p & 0x0f);
                    return 2;
                }
                return 0;
            }
            case 0x93: // POL
            case 0x94: // WMM
                return 2;
            case 0x88: // SSZ
                this.hScale = 0.5;
                this.vScale = 0.5;
                return 1;
            case 0x89: // MSZ
                this.hScale = 0.5;
                this.vScale = 1;
                return 1;
            case 0x8a: // NSZ
                this.hScale = 1;
                this.vScale = 1;
                return 1;
            case 0x8b: // SZX
                if (rest < 2) return 0;
                if (data[at + 1] === 0x41) this.vScale = 2;
                else if (data[at + 1] === 0x44) this.hScale = 2;
                else if (data[at + 1] === 0x45) {
                    this.hScale = 2;
                    this.vScale = 2;
                }
                return 2;
            case 0x91: // FLC。0x40 正相・0x47 逆相で点滅、0x4F で止める
                if (rest < 2) return 0;
                this.flash = data[at + 1] === 0x40 || data[at + 1] === 0x47;
                return 2;
            case 0x92: // CDC
                if (rest < 2) return 0;
                if (data[at + 1] === 0x20) return rest < 3 ? 0 : 3;
                return 2;
            case 0x9d: // TIME
                if (rest < 3) return 0;
                if (data[at + 1] === 0x20) {
                    this.caption.wait = (this.caption.wait ?? 0) + (data[at + 2]! & 0x3f) * 100;
                    return 3;
                }
                return data[at + 1] === 0x28 ? 3 : 0;
            case 0x95: // MACRO (TR-B14 で使わない)
                return 0;
            case 0x98: // RPC (libaribcaption も繰り返さない)
                return rest < 2 ? 0 : 2;
            case 0x9a: // STL
                this.underline = true;
                return 1;
            case 0x99: // SPL
                this.underline = false;
                return 1;
            case 0x97: // HLC
                if (rest < 2) return 0;
                this.box = data[at + 1]! & 0x0f;
                return 2;
            case 0x9b: {
                const used = this.csi(data, at + 1);
                return used <= 0 ? 0 : 1 + used;
            }
            default:
                return 1;
        }
    }

    private csi(data: Uint8Array, at: number): number {
        const rest = data.length - at;
        let offset = 0;
        let p1 = 0;
        let p2 = 0;
        let count = 0;
        while (offset < rest) {
            const byte = data[at + offset]!;
            if (byte >= 0x30 && byte <= 0x39) {
                if (count <= 1) p2 = p2 * 10 + (byte & 0x0f);
            } else if (byte === 0x20) {
                if (count === 0) p1 = p2;
                count++;
                break;
            } else if (byte === 0x3b) {
                if (count === 0) {
                    p1 = p2;
                    p2 = 0;
                }
                count++;
            }
            offset++;
        }
        if (++offset >= rest) return 0;
        switch (data[at + offset]) {
            case 0x53: // SWF
                if (count === 1) this.swf = p1;
                this.resetWritingFormat();
                break;
            case 0x56: // SDF
                this.areaWidth = p1;
                this.areaHeight = p2;
                break;
            case 0x57: // SSM
                this.charWidth = p1;
                this.charHeight = p2;
                break;
            case 0x58: // SHS
                this.hSpacing = p1;
                break;
            case 0x59: // SVS
                this.vSpacing = p1;
                break;
            case 0x5f: // SDP
                this.areaX = p1;
                if (count >= 2) this.areaY = p2;
                if (!this.posInited) this.setAbsolute(0, 0);
                break;
            case 0x61: // ACPS
                this.posInited = true;
                this.posX = p1;
                this.posY = p2;
                break;
            case 0x63: // ORN
                if (p1 === 0) this.stroke = null;
                else if (p1 === 1 && count >= 2) {
                    const palette = Math.floor(p2 / 100);
                    const index = p2 % 100;
                    if (palette >= 8 || index >= 16) return 0;
                    this.stroke = clut(palette, index);
                }
                break;
            case 0x64: // MDF
                if (p1 === 0) {
                    this.bold = false;
                    this.italic = false;
                } else if (p1 === 1) this.bold = true;
                else if (p1 === 2) this.italic = true;
                else if (p1 === 3) {
                    this.bold = true;
                    this.italic = true;
                }
                break;
        }
        return offset + 1;
    }

    /** 中くらい (MSZ) か。半角へ寄せる見分けに使う */
    private msz(): boolean {
        return this.hScale * 2 === this.vScale;
    }

    private graphic(data: Uint8Array, at: number, entry: Entry): number {
        const ch = data[at]! & 0x7f;
        if (ch < 0x21 || ch >= 0x7f) return 0;
        let ch2 = 0;
        if (entry.bytes === 2) {
            if (at + 1 >= data.length) return 0;
            ch2 = data[at + 1]! & 0x7f;
            if (ch2 < 0x21 || ch2 >= 0x7f) return 0;
        }
        const set = entry.set;
        const index = ch - 0x21;
        if (set === 'hiragana' || set === 'katakana') {
            let code = (set === 'hiragana' ? T.hiragana : T.katakana)[index]!;
            if (ch >= 0x79 && this.msz()) code = T.kanaHalf[ch - 0x79]!;
            this.push(code);
            this.moveRelative(1, 0);
        } else if (set === 'jisx0201') {
            this.push((this.msz() ? T.jisx0201Half : T.jisx0201)[index]!);
            this.moveRelative(1, 0);
        } else if (set === 'kanji' || set === 'additional') {
            const ku = ch - 0x21;
            const ten = ch2 - 0x21;
            let code: number;
            if (ku < 84) {
                const i = ku * 94 + ten;
                code = kanji(i);
                if (this.msz()) {
                    if (ku < 2) code = T.kanjiHalf[i]!;
                    if (code === 0x3000 || (code >= 0xff01 && code <= 0xff5e)) code = (code & 0xff) + 0x20;
                }
            } else {
                code = T.additional[(ku - 84) * 94 + ten] ?? 0xfffd;
            }
            this.push(code);
            this.moveRelative(1, 0);
        } else if (set === 'alnum') {
            this.push((this.msz() ? T.alnumHalf : T.alnumFull)[index]!);
            this.moveRelative(1, 0);
        } else if (set === 'macro') {
            if (ch >= 0x60 && ch <= 0x6f) this.body(Uint8Array.from(MACROS[ch & 0x0f]!));
        } else if (typeof set === 'object') {
            const key = entry.bytes === 2 ? (ch << 8) | ch2 : ch;
            const drcs = this.drcsMaps[set.drcs]!.get(key);
            if (drcs === undefined) {
                // 定義されていない外字は、ゲタ (〓) で埋める
                this.push(0x3013);
            } else {
                const code = (set.drcs << 16) | key;
                this.caption.drcs.set(code, drcs);
                if (drcs.replaced !== null) this.push(drcs.replaced);
                else this.push(0x3013, code);
            }
            this.moveRelative(1, 0);
        }
        // モザイクは描かない (libaribcaption と同じ)
        return entry.bytes;
    }

    private push(code: number, drcs: number | null = null): void {
        this.caption.chars.push({
            code,
            drcs,
            x: this.posX,
            y: this.posY - this.sectionHeight(),
            charWidth: this.charWidth,
            charHeight: this.charHeight,
            hSpacing: this.hSpacing,
            vSpacing: this.vSpacing,
            hScale: this.hScale,
            vScale: this.vScale,
            fg: this.fg,
            bg: this.bg,
            stroke: this.stroke,
            underline: this.underline,
            bold: this.bold,
            italic: this.italic,
            box: this.box,
            flash: this.flash,
            ruby:
                (this.hScale === 0.5 && this.vScale === 0.5) ||
                (this.charWidth === 18 && this.charHeight === 18),
        });
    }

    private sectionWidth(): number {
        return Math.floor((this.charWidth + this.hSpacing) * this.hScale);
    }

    private sectionHeight(): number {
        return Math.floor((this.charHeight + this.vSpacing) * this.vScale);
    }

    private setAbsolute(x: number, y: number): void {
        this.posInited = true;
        this.posX = this.areaX + x * this.sectionWidth();
        this.posY = this.areaY + (y + 1) * this.sectionHeight();
    }

    private moveRelative(x: number, y: number): void {
        if (this.posX < 0 || this.posY < 0) this.setAbsolute(0, 0);
        this.posInited = true;
        while (x < 0) {
            this.posX -= this.sectionWidth();
            x++;
            if (this.posX < this.areaX) {
                this.posX = this.areaX + this.areaWidth - this.sectionWidth();
                y--;
            }
        }
        while (x > 0) {
            this.posX += this.sectionWidth();
            x--;
            if (this.posX >= this.areaX + this.areaWidth) {
                this.posX = this.areaX;
                y++;
            }
        }
        while (y < 0) {
            this.posY -= this.sectionHeight();
            y++;
            if (this.posY < this.areaY) this.posY = this.areaY + this.areaHeight;
        }
        while (y > 0) {
            this.posY += this.sectionHeight();
            y--;
            if (this.posY > this.areaY + this.areaHeight) this.posY = this.areaY + this.sectionHeight();
        }
    }

    private newline(): void {
        if (this.posX < 0 || this.posY < 0) this.setAbsolute(0, 0);
        this.posInited = true;
        this.posX = this.areaX;
        this.posY += this.sectionHeight();
    }
}

/**
 * 解いた1枚を、送る形にする。**同じ見た目で続いている字を1つの並びに束ねる。**
 *
 * libaribcaption の描き手 (region_renderer) が字ごとに計算している置き場所を、ここで
 * 面の単位のまま済ませておく。区画は `floor((字の幅 + 字間) × 倍率)`、字の枠は区画の中で
 * 字間の半分だけ右下へずらしたところ。
 *
 * @returns 出すものが無い (待ちだけの字幕文) なら null。CS だけなら「消す」1枚
 */
export function toPage(caption: Caption, plane: [number, number]): CaptionPage | null {
    if (caption.chars.length === 0 && !caption.clear) return null;
    const runs: CaptionRun[] = [];
    const drcs: Record<string, CaptionDrcs> = {};
    let last: { run: CaptionRun; count: number; key: string } | null = null;
    for (const char of caption.chars) {
        const w = Math.floor((char.charWidth + char.hSpacing) * char.hScale);
        const h = Math.floor((char.charHeight + char.vSpacing) * char.vScale);
        const size = char.charHeight * char.vScale;
        const glyphWidth = char.charWidth * char.hScale;
        // 中くらいの半角の字は縮めない (もともと半分の幅。libaribcaption の DrawChar と同じ)
        const halfAsked = Math.abs(glyphWidth / size - 0.5) < 0.05;
        const scaleX = halfAsked && isHalfwidth(char.code) ? 1 : glyphWidth / size;
        const run: CaptionRun = {
            x: char.x,
            y: char.y,
            w,
            h,
            fx: (char.hSpacing * char.hScale) / 2,
            fy: (char.vSpacing * char.vScale) / 2,
            size,
            scaleX,
            text: String.fromCodePoint(char.code),
            fg: char.fg,
            bg: char.bg,
        };
        if (char.drcs !== null) {
            const key = String(char.drcs);
            run.drcs = key;
            const found = caption.drcs.get(char.drcs);
            if (found !== undefined && drcs[key] === undefined) {
                drcs[key] = {
                    w: found.width,
                    h: found.height,
                    depth: found.depth,
                    bits: found.bits,
                    data: Buffer.from(found.pixels).toString('base64'),
                };
            }
        }
        if (char.stroke !== null) run.stroke = char.stroke;
        if (char.underline) run.underline = true;
        if (char.bold) run.bold = true;
        if (char.italic) run.italic = true;
        if (char.box !== 0) run.box = char.box;
        if (char.flash) run.flash = true;
        if (char.ruby) run.ruby = true;

        // 見た目が同じで、すぐ右に続いていれば束ねる。外字の絵は1字ずつ
        const { x: _x, y: _y, text: _t, ...looks } = run;
        const key = JSON.stringify(looks);
        if (
            last !== null &&
            run.drcs === undefined &&
            last.key === key &&
            last.run.y === run.y &&
            last.run.x + last.count * last.run.w === run.x
        ) {
            last.run.text += run.text;
            last.count++;
            continue;
        }
        runs.push(run);
        last = { run, count: 1, key };
    }
    const page: CaptionPage = {
        v: CAPTION_TEXT_VERSION,
        plane,
        duration: caption.wait,
        runs,
    };
    if (Object.keys(drcs).length > 0) page.drcs = drcs;
    return page;
}
