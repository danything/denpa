import { LANGUAGE } from "./arib";

/**
 * **字幕の文字の配置** (第1版)。サーバが放送の字幕 (ARIB STD-B24) をデコードして置き場所まで
 * 決め、受け側 (ブラウザ・テレビのアプリ) はこれを**描くだけ**にする。形式の取り決めは
 * [api.md](../../docs/api.md#字幕の文字の配置) に書いてある (ここと同じものを、Kotlin でも読む)。
 *
 * 座標はすべて**字幕の面の単位** (`plane`。ふつう 960x540)。受け側は映像の枠に
 * 合わせて縦横それぞれ伸ばす。色は `#rrggbbaa`。
 */

/** 形式の版。**互換の無い変え方をしたら上げる** (受け側は知らない版を描かない) */
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
  /** 置き換えられなかった外字の画像。`CaptionRun.drcs` で引く */
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
  /** 置き換えられなかった外字。`text` は「〓」で、この画像を字の枠いっぱいに描く */
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

/** 外字の画像。`data` は base64 で、左上から1画素 `bits` ビットずつ (上の桁から) 詰めたもの */
export interface CaptionDrcs {
  w: number;
  h: number;
  /** 階調の数 (2 なら白黒)。値 v の濃さは v / (depth - 1) */
  depth: number;
  bits: number;
  data: string;
  /**
   * 放送の元の画像の MD5。外字の置き換え表 (`b24-tables.ts` の `DRCS_REPLACE`) に足すときに使う。
   * `data` は送るためになめらかにした画像なので、その MD5 は表と合わない。描くのには使わない
   */
  md5?: string;
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
  /** 第1言語 */
  pages: { at: number; page: CaptionPage }[];
  /** 第1言語の名前。字幕管理データが読めなければ省く */
  language?: CaptionLanguage;
  /** 第2言語から後ろ。**載っているときだけ** (たいていの番組は第1言語だけ) */
  others?: CaptionLanguagePages[];
}

/**
 * 字幕の言語1つ。**ARIB の字幕は1本の中に最大8言語を持てる** (データグループの番号 1〜8。
 * 何番がどの言語かは字幕管理データに ISO 639 の3文字で書いてある)。日本の放送はほぼ日本語だけで、
 * 英語の字幕が付く番組がたまにある
 */
export interface CaptionLanguage {
  /** 第何言語か (1〜8。データグループの番号) */
  index: number;
  /** ISO 639-2 の3文字 (`jpn` / `eng`)。読めなければ空 */
  code: string;
  /** 読める名前 (日本語・英語)。知らない符号はそのまま */
  label: string;
}

/**
 * 録画の字幕のうち、第2言語から後ろ (`CaptionPages.others`)。**第1言語は今までどおり `pages`** —
 * 版 (`v`) を上げずに足したので、知らない受け側は第1言語だけを描く
 */
export interface CaptionLanguagePages extends CaptionLanguage {
  pages: { at: number; page: CaptionPage }[];
}

/** 第何言語かと ISO 639 の符号から、画面に出す名前を付ける */
export function captionLanguage(index: number, code: string): CaptionLanguage {
  return {
    index,
    code,
    label: LANGUAGE[code] ?? (code === "" ? `字幕${index}` : code),
  };
}

/** `?language=` を読む (1〜8)。省いた・読めないときは第1言語 */
export function parseCaptionLanguage(value: string | null): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 8 ? number : 1;
}
