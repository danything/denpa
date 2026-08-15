/**
 * GPU で焼く話の、**画面とサーバで共有する型と名前**。
 * 探し方・焼き方の本体は `server/hwenc.ts` (画面からは読み込めない)
 */

/** GPU で焼けるコーデック。**AV1 が先** — 主 (`library_path`) をそちらにする順序と同じ */
export const HW_CODECS = ['av1', 'h264'] as const;
export type HwCodec = (typeof HW_CODECS)[number];

/** GPU で焼く道。並びがそのまま試す順 (QSV が先。理由は server/hwenc.ts) */
export const HW_KINDS = ['qsv', 'vaapi'] as const;
export type HwKind = (typeof HW_KINDS)[number];

export const HW_KIND_LABEL: Record<HwKind, string> = { qsv: 'QSV', vaapi: 'VA-API' };
export const CODEC_LABEL: Record<HwCodec, string> = { av1: 'AV1', h264: 'H.264' };

/**
 * **口 (GPU) ごとに、GPU で焼いてよいコーデック** (設定 `hwAllow`)。口の path が鍵。
 * **載っていない口は全部よい** — GPU が見つかれば黙って使う (「自動でチェックが入る」)
 */
export type HwAllow = Record<string, Record<HwKind, HwCodec[]>>;

/** その口・道・コーデックが、設定で許されているか */
export function hwAllowed(allow: HwAllow, device: string, kind: HwKind, codec: HwCodec): boolean {
    const entry = allow[device];
    return entry === undefined || entry[kind].includes(codec);
}
