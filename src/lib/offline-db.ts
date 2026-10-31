/**
 * オフライン視聴の置き場 (IndexedDB)。**ページとサービスワーカーの両方から使う**ので、
 * Svelte に依存しないただの層にしてある ([docs/offline.md](../../docs/offline.md))。
 *
 * - `videos` … 落とした録画。動画の blob と、観るのに要る付き添い
 *   (字幕・チャプター・データ放送・ポスター) を1行にまとめて持つ
 * - `outbox` … オンラインに戻ったときにサーバへ伝えること (いまは削除だけ)
 * - `resume` … オフライン中に進んだ視聴位置。復帰時にまとめて送る
 */

import { encodedCodec } from "./encoded-codec";
import { CODEC_LABEL } from "./hw";
import {
  ENCODED_ORDER,
  type EncodedSource,
  type PlayAxis,
} from "./ts/playback";

/** 落とすファイルの名指し (`?source=`)。主・H.265 (`hevc_path`)・H.264 (`alt_path`) */
export type OfflineSource = EncodedSource;

/**
 * **どれを落とすか。** エンコード済みのファイルのうち、AV1 → H.265 → H.264 の順で `playable` (この端末で
 * 観られるか) が通る最初のもの (観る画面と同じ順。`ts/playback.ts` の `ENCODED_ORDER`)。コーデックは
 * 置き場の名前で見分ける (`encodedCodec`。H.264 だけでエンコードした録画は主がもう `… [H264].mkv`)。
 * どれも観られなければ投げる (保存できても観られないため)
 */
export async function offlineSource(
  rec: {
    library_path: string | null;
    hevc_path: string | null;
    alt_path: string | null;
  },
  playable: (codec: (typeof ENCODED_ORDER)[number]) => Promise<boolean>,
): Promise<OfflineSource> {
  const files = (
    [
      ["encoded", rec.library_path],
      ["hevc", rec.hevc_path],
      ["alt", rec.alt_path],
    ] as const
  ).flatMap(([source, path]) => {
    const codec = path === null ? "mpeg2" : encodedCodec(path);
    return codec === "mpeg2" ? [] : [{ source, codec }];
  });
  files.sort(
    (a, b) => ENCODED_ORDER.indexOf(a.codec) - ENCODED_ORDER.indexOf(b.codec),
  );
  for (const file of files) {
    if (await playable(file.codec)) return file.source;
  }
  throw new Error(
    files.length === 0
      ? "エンコード済みのファイルがありません"
      : `この端末では再生できません (${files.map((file) => CODEC_LABEL[file.codec]).join("・")} をデコードできません)`,
  );
}

const DB = "denpa-offline";
const VERSION = 1;

/** 落とした録画1本。付き添いは取れなかったら無いまま (観るときに諦める) */
export interface OfflineVideo {
  id: number;
  name: string;
  /** 局名。/offline の一覧に出す */
  serviceName: string;
  startAt: number;
  /** 実際に録れた長さ (ms)。無ければ null */
  durationMs: number | null;
  /** どれを落としたか (`saveOffline`)。主が端末でデコードできなければ hevc (H.265) か alt (H.264) */
  source: OfflineSource;
  /**
   * 何回目の試みか (でたらめな文字列)。**やり直しと前回の残骸を見分ける印。**
   * 前回の失敗を中止してからやり直すとき、その中止の通知が遅れて届いても、
   * 印が違えば新しい控えを消さない (`service-worker/index.ts` の drop)
   */
  attempt?: string;
  /**
   * `downloading` は Background Fetch がまだ運んでいる最中。
   * `failed` は**消さずに残す** — 失敗した瞬間の通知 (トースト) は一瞬で、
   * 控えごと消すと「無かったことになった」ように見える。行に残して、やり直す
   * 入口にする
   */
  state: "downloading" | "ready" | "failed";
  downloadedAt: number;
  /** 動画の実体。downloading の間は無い */
  video?: Blob;
  /**
   * 字幕 (`captions.json`)。以前は画像字幕 (PGS) を `captions` に持っていたが、もう読まない
   * (前に保存した控えに残っていても、使わないだけで害は無い)
   */
  captionText?: unknown;
  poster?: Blob;
  chapters?: unknown;
  databroadcast?: unknown;
}

interface OutboxItem {
  id: number;
  op: "delete";
  /** 何を消すのか、処理の記録に名前で残す */
  name: string;
  queuedAt: number;
}

interface ResumeItem {
  id: number;
  /** 再生位置 (秒)。サーバの `POST …/resume` と同じ形式 */
  at: number;
  length: number;
  /** `at` の物差し (`POST …/resume` の `source`)。無ければサーバの既定 (観る画面と同じ決め方) */
  axis?: PlayAxis;
  updatedAt: number;
}

/**
 * Background Fetch の登録ID。`rec-<録画ID>-<どちらを落とすか>-<試みの印>`。
 *
 * **試みの印を含める。** 同じIDが生きている間は再登録できない
 * (`There already is a registration for the given id`) — 前回の失敗の残骸が
 * ブラウザに残っていると、やり直しがそのまま断られていた。試みごとに
 * 変えれば必ず登録でき、残骸は登録前に中止する (offline.svelte.ts)
 */
export function fetchId(
  id: number,
  source: OfflineSource,
  attempt: string,
): string {
  return `rec-${id}-${source}-${attempt}`;
}

/** その録画の登録IDか。残骸を探して中止するときの当たり判定 */
export function fetchIdPrefix(id: number): string {
  return `rec-${id}-`;
}

/** 登録IDを読み戻す。Background Fetch の成否イベントは ID しか持っていない */
export function parseFetchId(
  value: string,
): { id: number; source: OfflineSource; attempt: string } | null {
  // 印の無い古い形式 (rec-42-encoded) も読める。付ける前に預けたぶんが残っていることがある
  const m = /^rec-(\d+)-(encoded|hevc|alt)(?:-([a-z0-9]+))?$/.exec(value);
  if (m === null) return null;
  return {
    id: Number(m[1]),
    source: m[2] as OfflineSource,
    attempt: m[3] ?? "",
  };
}

/**
 * 落とすものの一覧。動画 + 観るのに要る付き添い。
 *
 * **頭 (前段の接頭辞。server/paths.ts) は呼ぶ側 (offline.svelte.ts) が付ける。** ここは
 * Service Worker からも読まれ、パスの形で付き添いを見分ける (`kindOf`) ので、ルートからのパスのまま持つ
 */
export function downloadRequests(id: number, source: OfflineSource): string[] {
  return [
    `/api/recordings/${id}/file?source=${source}`,
    `/api/recordings/${id}/captions.json`,
    `/api/recordings/${id}/chapters`,
    `/api/recordings/${id}/databroadcast`,
    `/api/recordings/${id}/poster`,
  ];
}

/** URL がどの付き添いか。Background Fetch の結果を仕分けるのに使う */
export function kindOf(
  url: string,
): "video" | "captionText" | "chapters" | "databroadcast" | "poster" | null {
  const path = new URL(url, "http://x").pathname;
  if (path.endsWith("/file")) return "video";
  if (path.endsWith("/captions.json")) return "captionText";
  if (path.endsWith("/chapters")) return "chapters";
  if (path.endsWith("/databroadcast")) return "databroadcast";
  if (path.endsWith("/poster")) return "poster";
  return null;
}

/**
 * 落としたものを控えの正しい置き場に仕舞う。**SW の受け取りとページ主導の
 * フォールバックで同じ仕分け** (どちらか片方だけ直すと形が食い違う)。
 * 動画だけは読み方を差し替えられる (ページ主導は進み具合を数えながら読む)
 */
export async function storeResponse(
  held: OfflineVideo,
  url: string,
  response: Response,
  readVideo: (response: Response) => Promise<Blob> = (r) => r.blob(),
): Promise<void> {
  const kind = kindOf(url);
  if (kind === null) return;
  if (kind === "video") held.video = await readVideo(response);
  else if (kind === "poster") held.poster = await response.blob();
  else held[kind] = await response.json().catch(() => undefined);
}

type Store = "videos" | "outbox" | "resume";
const STORES: Store[] = ["videos", "outbox", "resume"];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES)
        if (!req.result.objectStoreNames.contains(name))
          req.result.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 1つの置き場の読み書き。どの置き場も `id` で引く */
function table<T>(store: Store) {
  return {
    get: (id: number) => tx<T | undefined>(store, "readonly", (s) => s.get(id)),
    all: () => tx<T[]>(store, "readonly", (s) => s.getAll()),
    put: (value: T) => tx(store, "readwrite", (s) => s.put(value)),
    remove: (id: number) => tx(store, "readwrite", (s) => s.delete(id)),
  };
}

export const videos = table<OfflineVideo>("videos");
export const outbox = table<OutboxItem>("outbox");
export const resumeQueue = table<ResumeItem>("resume");
