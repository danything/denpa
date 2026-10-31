/**
 * オフライン視聴の置き場 (IndexedDB)。**ページとサービスワーカーの両方から使う**ので、
 * Svelte に依存しないただの層にしてある ([docs/offline.md](../../docs/offline.md))。
 *
 * - `videos` … 落とした録画。動画の blob と、観るのに要る付き添い
 *   (字幕・チャプター・データ放送・ポスター) を1行にまとめて持つ
 * - `parts` … ページで受け取った動画の塊 (`OfflineVideo.parts`)。読むときに `videos` が
 *   1本の `video` につないで出すので、観る側は塊を知らなくてよい
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
): Promise<EncodedSource> {
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
/** 2 で `parts` を足した (前に保存したものは `video` のまま読める) */
const VERSION = 2;

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
  source: EncodedSource;
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
   * 動画を塊で持っているときの塊の数 (`parts` の置き場)。**ページで受け取ったもの**
   * (Background Fetch の無い iPhone の Safari) はこちら — 全部をメモリに抱えると落とされる
   * (`stream-parts.ts`)。読むときは `videos.get` / `all` が `video` につないで出す
   */
  parts?: number;
  /** 塊で持っているときの動画の形式 (`Content-Type`)。つないだ `video` に付ける */
  videoType?: string;
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
  source: EncodedSource,
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
): { id: number; source: EncodedSource; attempt: string } | null {
  // 印の無い古い形式 (rec-42-encoded) も読める。付ける前に預けたぶんが残っていることがある
  const m = /^rec-(\d+)-(encoded|hevc|alt)(?:-([a-z0-9]+))?$/.exec(value);
  if (m === null) return null;
  return {
    id: Number(m[1]),
    source: m[2] as EncodedSource,
    attempt: m[3] ?? "",
  };
}

/**
 * 落とすものの一覧。動画 + 観るのに要る付き添い。
 *
 * **頭 (前段の接頭辞。server/paths.ts) は呼ぶ側 (offline.svelte.ts) が付ける。** ここは
 * Service Worker からも読まれ、パスの形で付き添いを見分ける (`kindOf`) ので、ルートからのパスのまま持つ
 */
export function downloadRequests(id: number, source: EncodedSource): string[] {
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
 * フォールバックで同じ仕分け** (どちらか片方だけ直すと形式が食い違う)。
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

type Store = "videos" | "outbox" | "resume" | "parts";
const STORES: Exclude<Store, "parts">[] = ["videos", "outbox", "resume"];

/** 動画の塊1つ。`[id, index]` で引く (同じ録画の塊は index の順に並ぶ) */
interface VideoPart {
  id: number;
  index: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES)
        if (!req.result.objectStoreNames.contains(name))
          req.result.createObjectStore(name, { keyPath: "id" });
      if (!req.result.objectStoreNames.contains("parts"))
        req.result.createObjectStore("parts", { keyPath: ["id", "index"] });
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

/** その録画の塊ぜんぶ (`[id, 0]` から `[id, 最大]` まで) */
function partRange(id: number): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

/** 動画の塊を1つ書く。ページで受け取るとき、溜まった順に呼ぶ */
export async function putPart(
  id: number,
  index: number,
  blob: Blob,
): Promise<void> {
  await tx("parts", "readwrite", (s) => s.put({ id, index, blob }));
}

/** その録画の塊を全部消す。やり直す前と、控えを消すとき */
export async function clearParts(id: number): Promise<void> {
  await tx("parts", "readwrite", (s) => s.delete(partRange(id)));
}

/**
 * 塊で持っている動画を1本の `video` につなぐ。**中身は写さない** — 置き場から出した
 * Blob はファイルを指しているだけなので、つないでもメモリには載らない。
 * 塊が欠けていたら (書いている途中で落とされた) `video` 無しで返す
 */
async function joinParts(held: OfflineVideo): Promise<OfflineVideo> {
  if (held.parts === undefined) return held;
  const parts = await tx<VideoPart[]>("parts", "readonly", (s) =>
    s.getAll(partRange(held.id)),
  );
  if (parts.length !== held.parts) {
    const { video: _, ...rest } = held;
    return rest;
  }
  return {
    ...held,
    video: new Blob(
      parts.map((p) => p.blob),
      { type: held.videoType ?? "" },
    ),
  };
}

const videoRows = table<OfflineVideo>("videos");

/**
 * 落とした録画。**塊で持っているものも、読むときは `video` がつながった形で出す**
 * (観る画面・/offline・SW は塊を知らない)。書くときはつないだ `video` を行に戻さない
 * (塊と二重に持つことになる)。消すときは塊も消す
 */
export const videos = {
  get: async (id: number) => {
    const held = await videoRows.get(id);
    return held === undefined ? undefined : await joinParts(held);
  },
  all: async () => Promise.all((await videoRows.all()).map(joinParts)),
  put: (value: OfflineVideo) => {
    if (value.parts === undefined) return videoRows.put(value);
    const { video: _, ...rest } = value;
    return videoRows.put(rest);
  },
  remove: async (id: number) => {
    await videoRows.remove(id);
    await clearParts(id);
  },
};
export const outbox = table<OutboxItem>("outbox");
export const resumeQueue = table<ResumeItem>("resume");
