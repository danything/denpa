import { existsSync } from "node:fs";
import { join } from "node:path";

import { pad } from "#lib/format.js";
import { HW_CODECS, type HwCodec } from "#lib/hw.js";
import type { EncodedSource } from "#lib/ts/playback.js";
import type { Recording } from "#lib/types.js";

import { config } from "./config";
import { parseTitle, sanitizeFileName } from "./title";

export interface LibraryNameInput {
  id: number;
  series: string;
  subtitle: string;
  start_at: number;
  /** いま置いてある場所。再エンコードのとき、自分自身を「衝突」と読まないために要る */
  library_path?: string | null;
  /** H.265 の置き場所 (主でないとき)。これも「自分自身」なので衝突と読まない */
  hevc_path?: string | null;
  /** H.264 の置き場所 (主でないとき)。これも「自分自身」なので衝突と読まない */
  alt_path?: string | null;
}

/**
 * **シリーズのフォルダ名。** エンコードしたものはこの名前のフォルダに並ぶ (下の `libraryRelPath`)。
 *
 * 録画一覧の「まとめて表示」も同じ名前でまとめる。画面だけ別の見分け方をすると、
 * ディスクでは 1 つのフォルダなのに一覧では 2 つに割れる (またはその逆) ことが起きる。
 * シリーズ名を持たない行 (録り逃し・古い取り込み) は番組名から切り出す
 * (録るときと同じ `parseTitle`)。**ここだけはディスクと違う。** エンコードするときは空のまま
 * `untitled/` に入るが、一覧で無関係な番組が 1 つにまとまっても探しにくいだけなので
 */
export function seriesFolder(series: string, name: string): string {
  return sanitizeFileName(series === "" ? parseTitle(name).series : series);
}

/**
 * 保存先での相対パスを組む。`シリーズ名/シリーズ名 - YYYY-MM-DD - HHMM 副題{ext}`。
 *
 * シリーズ名のフォルダにまとめるのは**ディスク上で見やすくするため**。
 * 隣にはサムネイル (`-poster.jpg`) を録画ごとに置く (metadata.ts)。
 *
 * 日時はプロセスの TZ (compose・Helm・インストーラが Asia/Tokyo を渡す) のローカル時刻。放送日で並ぶのが期待値なので UTC にはしない。
 */
function libraryRelPath(rec: LibraryNameInput, ext: string): string {
  const d = new Date(rec.start_at);
  const series = sanitizeFileName(rec.series);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;

  // 同一シリーズが同じ分に 2 本並ぶことはまず無い (万一衝突したら libraryPath が録画 ID で分ける)
  const subtitle =
    rec.subtitle === "" ? "" : ` ${sanitizeFileName(rec.subtitle)}`;
  const base = `${series} - ${date} - ${time}${subtitle}`;

  return join(series, `${base}${ext}`);
}

/**
 * 絶対パスで返すもの。**別の録画のファイルと衝突したら**録画 ID を足して避ける。
 *
 * **自分がいま置いてあるファイルは衝突ではない** (数えると、再エンコードするたびに素の名前と
 * `[録画ID]` 付きが入れ替わる)。
 */
export function libraryPath(rec: LibraryNameInput, ext: string): string {
  const rel = libraryRelPath(rec, ext);
  const abs = join(config.encodedDir, rel);
  // 自分がいま置いてあるもの (主と、主でない H.265・H.264) は衝突ではない
  if (
    !existsSync(abs) ||
    abs === rec.library_path ||
    abs === rec.hevc_path ||
    abs === rec.alt_path
  )
    return abs;
  return join(config.encodedDir, libraryRelPath(rec, ` [${rec.id}]${ext}`));
}

/**
 * コーデックごとの置き場所。
 *
 * どれも Matroska (`.mkv`)。mp4 は放送の字幕 (ARIB 字幕。Matroska なら `S_ARIBSUB`) を持てない
 * ため、全部 mkv で揃える。**H.265・H.264 のほうは名前に印を付ける** (`[H265]`・`[H264]`)。
 * 同じフォルダに最大 3 本並ぶので、名前が違わないと衝突する。
 */
export function encodedPath(rec: LibraryNameInput, codec: HwCodec): string {
  return libraryPath(rec, CODEC_SUFFIX[codec]);
}

/**
 * **エンコードしたもの全部** (無いものは除く)。並びは主 (`library_path`) → H.265 → H.264 で、
 * 小さい順 (`HW_CODECS`) と同じ。削除・照合・大きさ・移すときに、列を 1 つずつ書き並べずにこれで回す
 */
export function encodedPaths(rec: {
  library_path: string | null;
  hevc_path: string | null;
  alt_path: string | null;
}): string[] {
  return [rec.library_path, rec.hevc_path, rec.alt_path].filter(
    (path): path is string => path !== null,
  );
}

/** エンコード済みがあるかを決めるのに要る列 */
export type EncodedColumns = Pick<
  Recording,
  "library_path" | "hevc_path" | "alt_path"
>;

/**
 * **置き場に在るエンコード済み (Matroska)。エンコード済みがあるかは、どこもこれで決める**
 * (観る画面の出し方 `playback.playbackPlan`、物差し `rulerOf`、字幕 `captionArgs`、チャプター、アプリ向けの一覧の `files`、
 * CM 検出のやり直し `encoder.runCmJob`)。並びは `encodedPaths` と同じ。
 *
 * 名前だけでなく、ファイルが在るかまで見る。外から消されたもの (`files.reconcile` が行を直す前) を名前だけで
 * 在るとすると、`playbackPlan` は元の TS で流すのに、続きの位置・字幕・チャプターはエンコードしたものの物差しで出して食い違う。
 * 見るのは列ごとに stat 1 回で、控えは持たない。アプリ向けの一覧 (`GET api/recordings`) は全部の行で呼ぶ。
 * エンコード済みが 2 本ずつの録画 5000 件で stat は 1 万回、ローカルのディスクで 40 ms ほど (一覧の全体は 160 ms ほど)
 */
export function encodedFiles(
  recording: EncodedColumns,
): { source: EncodedSource; path: string }[] {
  return (
    [
      ["encoded", recording.library_path],
      ["hevc", recording.hevc_path],
      ["alt", recording.alt_path],
    ] as const
  ).flatMap(([source, path]) =>
    path?.endsWith(".mkv") === true && existsSync(path)
      ? [{ source, path }]
      : [],
  );
}

/** 物差しになるエンコード済み (`encodedFiles` の先頭。`playback` の `PlayAxis`)。無ければ null */
export function encodedFile(recording: EncodedColumns): string | null {
  return encodedFiles(recording)[0]?.path ?? null;
}

/** コーデックごとの名前の終わり (`encodedPath`)。AV1 は印を付けない */
const CODEC_SUFFIX: Record<HwCodec, string> = {
  av1: ".mkv",
  hevc: " [H265].mkv",
  h264: " [H264].mkv",
};

/**
 * この録画が取りうる保存先の候補すべて。
 *
 * コーデック (素 = AV1 / `[H265]` / `[H264]`) と、衝突回避の `[録画ID]` の有無で 6 通り。
 * 再エンコードする前に、DB の `library_path`/`hevc_path`/`alt_path` が指していない**はぐれファイル**まで
 * 含めて片付けるために使う (残っていると `libraryPath` がそれを「衝突」と読む)。
 */
export function libraryFamily(rec: LibraryNameInput): string[] {
  const exts = HW_CODECS.flatMap((codec) => [
    CODEC_SUFFIX[codec],
    ` [${rec.id}]${CODEC_SUFFIX[codec]}`,
  ]);
  return exts.map((ext) => join(config.encodedDir, libraryRelPath(rec, ext)));
}

/** 元の録画の置き場 (TS の局は `.m2ts`、4K の局は `.mmts`)。保存先と違い人が見るものではないので平置きでよい */
export function recordedPath(rec: LibraryNameInput, ext: string): string {
  const d = new Date(rec.start_at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return join(
    config.rawDir,
    `${sanitizeFileName(rec.series)}-${stamp}-${rec.id}${ext}`,
  );
}
