/**
 * **字幕の文字の配置** (第1版)。サーバが放送の字幕 (ARIB STD-B24) を解いて置き場所まで
 * 決め、受け側 (ブラウザ・テレビのアプリ) はこれを**描くだけ**にする。形の取り決めは
 * [api.md](../../docs/api.md#字幕の文字の配置) に書いてある (ここと同じものを、Kotlin でも読む)。
 *
 * 座標はすべて**字幕の面の単位** (`plane`。ふつう 960x540)。受け側は映像の絵の枠に
 * 合わせて縦横それぞれ伸ばす。色は `#rrggbbaa`。
 */

/** 形の版。**互換の無い変え方をしたら上げる** (受け側は知らない版を描かない) */
export const CAPTION_TEXT_VERSION = 1;

/** 縁取り (ORN) の太さ。面の単位で、字の輪郭の外側へ。libaribcaption の既定 (ffmpeg の `outline_width`) と同じ */
export const STROKE_WIDTH = 1.5;

/** 点滅 (FLC) の間 (ms)。出ている時間と消えている時間 */
export const FLASH_MS = 500;

/** 字幕1枚。**前の1枚を丸ごと置き換える** (`runs` が空なら消す) */
export interface CaptionPage {
    v: typeof CAPTION_TEXT_VERSION;
    /** 字幕の面の大きさ [幅, 高さ] */
    plane: [number, number];
    /** 出しておく長さ (ms)。null なら次の1枚まで */
    duration: number | null;
    /** 字の並び。描く順 */
    runs: CaptionRun[];
    /** 置き換えられなかった外字の絵。`CaptionRun.drcs` で引く */
    drcs?: Record<string, CaptionDrcs>;
}

/**
 * 同じ見た目で横に並ぶ字。`text` の1字 (コードポイント) ごとに、幅 `w` の区画を
 * `x` から右へ1つずつ使う。
 */
export interface CaptionRun {
    /** 1字目の区画の左上 */
    x: number;
    y: number;
    /** 区画1つの幅・高さ。背景 (`bg`) はこの広さを塗る */
    w: number;
    h: number;
    /** 区画の左上から、字の枠の左上まで */
    fx: number;
    fy: number;
    /** 字の大きさ (em)。字の枠の高さでもある */
    size: number;
    /**
     * 横の縮め方。字の枠の幅は `size * scaleX`。中くらい (MSZ) の全角は 0.5 で縮めて描き、
     * 半角の字 (英数・半角カナ) は 1 のまま (もともと半分の幅なので)
     */
    scaleX: number;
    text: string;
    /** 置き換えられなかった外字。`text` は「〓」で、この絵を字の枠いっぱいに描く */
    drcs?: string;
    /** 字の色 */
    fg: string;
    /** 背景の色 (区画) */
    bg: string;
    /** 縁取りの色 (ORN)。無ければ縁取らない */
    stroke?: string;
    underline?: true;
    bold?: true;
    italic?: true;
    /** 囲み (HLC)。1 下・2 右・4 上・8 左の和。線は字の色で、太さは面の 1 単位 */
    box?: number;
    /** 点滅 (FLC) */
    flash?: true;
    /** ルビらしい小さな字 (libaribcaption と同じ見分け方) */
    ruby?: true;
}

/** 外字の絵。`data` は base64 で、左上から1画素 `bits` ビットずつ (上の桁から) 詰めたもの */
export interface CaptionDrcs {
    w: number;
    h: number;
    /** 階調の数 (2 なら白黒)。値 v の濃さは v / (depth - 1) */
    depth: number;
    bits: number;
    data: string;
}

/** 空白として字を描かない (背景だけ塗る) 字。libaribcaption の IsSpaceCharacter と同じ */
export function isSpace(code: number): boolean {
    return (
        code === 0x09 ||
        code === 0x20 ||
        code === 0xa0 ||
        code === 0x1680 ||
        code === 0x3000 ||
        code === 0x202f ||
        code === 0x205f ||
        (code >= 0x2000 && code <= 0x200a)
    );
}

/** 録画1本ぶんの字幕 (`GET /api/recordings/<id>/captions.json`)。`at` は動画の頭からの秒 */
export interface CaptionPages {
    v: typeof CAPTION_TEXT_VERSION;
    pages: { at: number; page: CaptionPage }[];
}
