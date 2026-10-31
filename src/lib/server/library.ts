import { existsSync } from "node:fs";
import { join } from "node:path";

import { pad } from "#lib/format.js";
import { HW_CODECS, type HwCodec } from "#lib/hw.js";

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
 * ディスクでは1つのフォルダなのに一覧では2つに割れる (またはその逆) ことが起きる。
 * シリーズ名を持たない行 (録り逃し・古い取り込み) は番組名から切り出す
 * (録るときと同じ `parseTitle`)。**ここだけはディスクと違う** — エンコードするときは空のまま
 * `untitled/` に入るが、一覧で無関係な番組が1つにまとまっても探しにくいだけなので
 */
export function seriesFolder(series: string, name: string): string {
  return sanitizeFileName(series === "" ? parseTitle(name).series : series);
}

/**
 * 保存先での相対パスを組む。`シリーズ名/シリーズ名 - YYYY-MM-DD - HHMM 副題{ext}`。
 *
 * シリーズ名のフォルダにまとめるのは**ディスク上で見やすくするため**。
 * 隣にはサムネ (`-poster.jpg`) を録画ごとに置く (metadata.ts)。
 *
 * 日時はコンテナの TZ (Asia/Tokyo) のローカル時刻。放送日で並ぶのが期待値なので UTC にはしない。
 */
function libraryRelPath(rec: LibraryNameInput, ext: string): string {
  const d = new Date(rec.start_at);
  const series = sanitizeFileName(rec.series);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;

  // 同一シリーズが同じ分に2本並ぶことはまず無い (万一衝突したら libraryPath が録画IDで分ける)
  const subtitle =
    rec.subtitle === "" ? "" : ` ${sanitizeFileName(rec.subtitle)}`;
  const base = `${series} - ${date} - ${time}${subtitle}`;

  return join(series, `${base}${ext}`);
}

/**
 * 絶対パスで返すもの。**別の録画のファイルと衝突したら**録画IDを足して避ける。
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
 * どれも Matroska (`.mkv`) — mp4 は放送の字幕 (ARIB 字幕。Matroska なら `S_ARIBSUB`) を持てない
 * ため、全部 mkv で揃える。**H.265・H.264 のほうは名前に印を付ける** (`[H265]`・`[H264]`)。
 * 同じフォルダに最大3本並ぶので、名前が違わないと衝突する。
 */
export function encodedPath(rec: LibraryNameInput, codec: HwCodec): string {
  return libraryPath(rec, CODEC_SUFFIX[codec]);
}

/**
 * **エンコードしたもの全部** (無いものは除く)。並びは主 (`library_path`) → H.265 → H.264 で、
 * 小さくなる順 (`HW_CODECS`) と同じ。削除・照合・大きさ・移すときに、列を1つずつ書き並べずにこれで回す
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

/** コーデックごとの名前の終わり (`encodedPath`)。AV1 は印を付けない */
const CODEC_SUFFIX: Record<HwCodec, string> = {
  av1: ".mkv",
  hevc: " [H265].mkv",
  h264: " [H264].mkv",
};

/**
 * この録画が取りうる保存先の候補すべて。
 *
 * コーデック (素 = AV1 / `[H265]` / `[H264]`) と、衝突回避の `[録画ID]` の有無で6通り。
 * 再エンコードする前に、DBの `library_path`/`hevc_path`/`alt_path` が指していない**はぐれファイル**まで
 * 含めて片付けるために使う (残っていると `libraryPath` がそれを「衝突」と読む)。
 */
export function libraryFamily(rec: LibraryNameInput): string[] {
  const exts = HW_CODECS.flatMap((codec) => [
    CODEC_SUFFIX[codec],
    ` [${rec.id}]${CODEC_SUFFIX[codec]}`,
  ]);
  return exts.map((ext) => join(config.encodedDir, libraryRelPath(rec, ext)));
}

/** 元のTSの置き場。保存先と違い人が見るものではないので平置きでよい */
export function recordedPath(rec: LibraryNameInput, ext = ".m2ts"): string {
  const d = new Date(rec.start_at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return join(
    config.rawDir,
    `${sanitizeFileName(rec.series)}-${stamp}-${rec.id}${ext}`,
  );
}
