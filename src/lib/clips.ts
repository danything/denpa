/**
 * **切り抜き** の取り決め (画面とサーバで同じもの)。撮って送るのはプレイヤー (`components/player/snapshot.ts`)、
 * 受けて AVIF にして置くのはサーバ (`server/clips.ts`)、並べるのは `/clips`
 */

/** どこで撮ったか */
export type ClipPlace = "live" | "chase" | "watch";

/**
 * 送れる本文の大きさの上限 (バイト)。**サーバの本文の上限 (`BODY_SIZE_LIMIT`。既定 512K) に合わせる** —
 * それより大きい本文は SvelteKit に届く前に断られる。映像と字幕・コメントの重ねを一緒に送るときは、合わせてこれに収める
 * (画面は収まるまで映像の画質を下げる)
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
  /** 置き場で使っている大きさ (画像・一覧用・元の画像の合計) */
  bytes: number;
  /**
   * あとから出し入れできる重ね。**撮ったときに出していたものだけ**キーがあり、値はいま重ねているか。
   * 分けて送られなかったもの (字幕を焼き込んだ古い切り抜きなど) は空
   */
  layers: ClipLayers;
}

/** 切り抜きに重ねられるもの (`comments` は実況のコメント)。重ねる順は映像 → コメント → 字幕 (観ている画面と同じ) */
export const CLIP_LAYERS = ["comments", "captions"] as const;
export type ClipLayer = (typeof CLIP_LAYERS)[number];
export type ClipLayers = Partial<Record<ClipLayer, boolean>>;

/**
 * 画像の版。重ねを出し入れすると同じ URL の中身が替わるので、画面は `?v=` に付けて端末のキャッシュを分ける。
 * 重ねを持たないものは空 (中身は替わらない)
 */
export function clipVersion(layers: ClipLayers): string {
  if (CLIP_LAYERS.every((layer) => layers[layer] === undefined)) return "";
  return CLIP_LAYERS.map((layer) =>
    layers[layer] === undefined ? "-" : layers[layer] ? "1" : "0",
  ).join("");
}

/** 画像の URL の問い合わせ (`?v=`)。重ねを持たないものは空 */
export function clipVersionQuery(clip: Pick<Clip, "layers">): string {
  const version = clipVersion(clip.layers);
  return version === "" ? "" : `?v=${version}`;
}

/**
 * `PATCH /api/clips/<id>` の本文を読む。`{ "captions": false }` のように、変えたいものだけ真偽で。
 * 知らない名前・真偽でない値・空なら null
 */
export function parseLayerPatch(body: unknown): ClipLayers | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const patch: ClipLayers = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(CLIP_LAYERS as readonly string[]).includes(key)) return null;
    if (typeof value !== "boolean") return null;
    patch[key as ClipLayer] = value;
  }
  return Object.keys(patch).length === 0 ? null : patch;
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
