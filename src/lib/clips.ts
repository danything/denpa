/**
 * **切り抜き** の取り決め (画面とサーバで同じもの)。撮って送るのはプレイヤー (`components/player/snapshot.ts`)、
 * 受けて AVIF にして置くのはサーバ (`server/clips.ts`)、並べるのは `/clips`
 */

/** どこで撮ったか */
export type ClipPlace = "live" | "chase" | "watch";

/**
 * 送れる画像の大きさの上限 (バイト)。**サーバの本文の上限 (`BODY_SIZE_LIMIT`。既定 512K) に合わせる** —
 * それより大きい本文は SvelteKit に届く前に断られる。画面はこれに収まるまで画質を下げて送る
 */
export const CLIP_BYTES_MOST = 512 * 1024;

/** 1ページの件数 (`GET /api/clips`) */
export const CLIP_PAGE = 60;

/** 切り抜き1枚 (`GET /api/clips` の1行・`POST /api/clips` の返事) */
export interface Clip {
  id: number;
  /** 撮った時刻 (unix ms) */
  takenAt: number;
  place: ClipPlace;
  /** 撮った録画。録画が無い (ライブで録っていなかった)・消した録画なら null */
  recordingId: number | null;
  /** 局の内部ID */
  serviceId: number;
  serviceName: string;
  programName: string;
  /** 番組の開始時刻 (unix ms)。番組を引けなければ null */
  programStartAt: number | null;
  eventId: number | null;
  /** 番組の始めからの位置 (ms)。番組を引けなければ null */
  offsetMs: number | null;
  /** 出していた字幕の文字。出していなければ空 */
  captions: string;
  width: number;
  height: number;
  /** 置き場で使っている大きさ (画像と一覧用の合計) */
  bytes: number;
}

/** 絞り込みの「ライブか録画か」 */
export type ClipKind = "live" | "recorded";

/** 探す条件 (`GET /api/clips` の URL と同じ名前) */
export interface ClipQuery {
  /** 言葉。空白で区切った語をすべて含むもの (番組名・局名・字幕) */
  q?: string;
  service?: number;
  /** 撮った日 (`YYYY-MM-DD`。サーバの時計の日付) */
  day?: string;
  recording?: number;
  kind?: ClipKind;
  /** この ID より古いもの (次のページ) */
  before?: number;
}

/** URL の問い合わせから条件を読む。読めない値は無いのと同じ */
export function parseClipQuery(params: URLSearchParams): ClipQuery {
  const query: ClipQuery = {};
  const q = params.get("q")?.trim();
  if (q) query.q = q;
  const id = (name: string): number | undefined => {
    const n = Number(params.get(name));
    return params.has(name) && Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const service = id("service");
  if (service !== undefined) query.service = service;
  const recording = id("recording");
  if (recording !== undefined) query.recording = recording;
  const before = id("before");
  if (before !== undefined) query.before = before;
  const day = params.get("day");
  if (day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day)) query.day = day;
  const kind = params.get("kind");
  if (kind === "live" || kind === "recorded") query.kind = kind;
  return query;
}

/** 条件を URL の問い合わせにする (`parseClipQuery` の逆)。`before` は入れない */
export function clipSearch(query: ClipQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.service !== undefined) params.set("service", String(query.service));
  if (query.day !== undefined) params.set("day", query.day);
  if (query.recording !== undefined)
    params.set("recording", String(query.recording));
  if (query.kind !== undefined) params.set("kind", query.kind);
  return params;
}
