import { readFileSync } from "node:fs";

import { joinBytes } from "@danything/arib/bytes";
import type { CaptionPages } from "@danything/arib/caption-text";

import type { Recording } from "#lib/types.js";

import { NO_SUBTITLE, pagesFromMkv } from "./captions";
import { config } from "./config";
import { mmtsCaptions, type MmtsFile } from "./mmts";
import { captionArgs, uhdCaptionSource } from "./playback";
import { run } from "./stream";

/**
 * **録画の字幕を文字の配置 (`CaptionPages`) にする。** 観る画面に配るもの (`api/recordings/<id>/captions.json`) と、
 * 字幕で探すためのインデックスを作る仕事が、どちらもここを通る。控えは持たない (配るほうが `fileMemo` で控える)。
 *
 * 読むものは 1 本の録画につき 1 つで、`captionSource` が決める。
 *
 * - エンコード済み (`.mkv`) があれば、ffmpeg が字幕のストリームだけを写し (`-c:s copy`)、denpa がデコードする (`pagesFromMkv`)。
 *   時刻はエンコード済みの先頭からの秒
 * - 無ければ元の TS から同じように抜く (`playback.captionArgs`)。時刻は元の TS の先頭からの秒
 * - 4K の局 (TTML) は ffmpeg を通さない (`playback.uhdCaptionSource`)。エンコード済みの隣の `….captions.json` か、元の `.mmts` を denpa が読む
 */

/** 字幕を持たないときの理由 (画面と 404 の本文) */
export const MISSING = "字幕がありません";

/** 待ち時間の上限。壊れたファイルで ffmpeg を待ち続けない。元の TS は大きいぶん長く待つ */
const TIMEOUT = 30_000;
const TIMEOUT_TS = 300_000;

/** 溜める量の上限。字幕のストリームだけなら 1 時間で数百 KB。壊れたファイルで膨らんでもここで止める */
const LIMIT = 32 * 1024 * 1024;

/**
 * 字幕を何から読むか。`path` は読むファイル、`encoded` は時刻がエンコード済みの物差しか (false なら元の録画の物差し)。
 * 読めるものが無い (元の録画もエンコード済みも無い・録画中の `.mmts`) なら `none`
 */
export type CaptionSource =
  | { kind: "ffmpeg"; argv: string[]; path: string; encoded: boolean }
  | { kind: "sidecar"; path: string; encoded: true }
  | {
      kind: "mmts";
      mmts: MmtsFile;
      serviceId: number;
      path: string;
      encoded: false;
    }
  | { kind: "none" };

/**
 * 取り出した結果。
 *
 * - `pages` … 字幕 (1 枚も無ければ `missing`)
 * - `missing` … 字幕を持たない (ストリームが無い・中身が空・画像の字幕)。何度読んでも同じ
 * - `failed` … 時間切れ・上限を超えた・ffmpeg を起こせなかった・そのほかの失敗。読み直せば読めるかもしれない
 */
export type CaptionResult =
  | { kind: "pages"; pages: CaptionPages }
  | { kind: "missing" }
  | { kind: "failed"; reason: string };

export async function captionSource(
  recording: Recording,
): Promise<CaptionSource> {
  const uhd = await uhdCaptionSource(recording);
  if (uhd !== null) {
    if ("missing" in uhd) return { kind: "none" };
    if ("sidecar" in uhd)
      return { kind: "sidecar", path: uhd.sidecar, encoded: true };
    return {
      kind: "mmts",
      mmts: uhd.mmts,
      serviceId: uhd.serviceId,
      path: uhd.mmts.path,
      encoded: false,
    };
  }
  const args = await captionArgs(recording);
  return args === null ? { kind: "none" } : { kind: "ffmpeg", ...args };
}

interface ExtractOptions {
  /** 止める合図 (ffmpeg を止める) */
  signal?: AbortSignal | undefined;
  /** ffmpeg をいちばん低い優先度で動かす (後から埋める仕事) */
  lowPriority?: boolean;
}

/** `source` から字幕を取り出す */
export async function extractCaptions(
  source: Exclude<CaptionSource, { kind: "none" }>,
  options: ExtractOptions = {},
): Promise<CaptionResult> {
  switch (source.kind) {
    case "sidecar":
      return sidecarPages(source.path);
    case "mmts": {
      const pages = await mmtsCaptions(source.mmts, source.serviceId);
      return pages.pages.length === 0
        ? { kind: "missing" }
        : { kind: "pages", pages };
    }
    case "ffmpeg":
      return ffmpegPages(source.argv, !source.encoded, options);
  }
}

/** 4K の局の隣に置いた文字の配置 (`encoder.writeCaptions`)。読めなければ失敗 (ファイルが無いのは置き場に繋がっていないときも) */
function sidecarPages(path: string): CaptionResult {
  try {
    const pages = JSON.parse(readFileSync(path, "utf8")) as CaptionPages;
    return Array.isArray(pages.pages) && pages.pages.length > 0
      ? { kind: "pages", pages }
      : { kind: "missing" };
  } catch (error) {
    return {
      kind: "failed",
      reason: `字幕のファイルを読めませんでした: ${error}`,
    };
  }
}

/**
 * ffmpeg に字幕だけを抜かせてデコードする。**字幕のストリームが無い (`NO_SUBTITLE`) のは失敗ではなく、字幕なし。**
 * 字幕を持たない番組のほうが多い (ffmpeg は「そのストリームは無い」で、動画を読む前に終わる)
 */
async function ffmpegPages(
  argv: string[],
  ts: boolean,
  options: ExtractOptions,
): Promise<CaptionResult> {
  const parts: Uint8Array[] = [];
  let size = 0;
  let over = false;
  const { code, stderr } = await run([config.ffmpeg, ...argv], {
    timeoutMs: ts ? TIMEOUT_TS : TIMEOUT,
    signal: options.signal,
    lowPriority: options.lowPriority === true,
    stderr: true,
    onStdout: (chunk) => {
      if (size + chunk.length > LIMIT) {
        over = true;
        return;
      }
      parts.push(chunk);
      size += chunk.length;
    },
  });
  // 上限で切れた。壊れたファイルの途中までを返さない
  if (over) return { kind: "failed", reason: "字幕が大きすぎます" };
  if (code !== 0) {
    if (NO_SUBTITLE.test(stderr)) return { kind: "missing" };
    const line = stderr.trim().split("\n").at(-1) ?? "";
    return {
      kind: "failed",
      reason: `ffmpeg が終了コード ${code} で終わりました${line === "" ? "" : `: ${line}`}`,
    };
  }
  const out = joinBytes(parts);
  if (out.length === 0) return { kind: "missing" };
  const pages = pagesFromMkv(out);
  // 画像の字幕 (PGS) は読まない (null)。字幕の無い録画と同じにする
  return pages === null ? { kind: "missing" } : { kind: "pages", pages };
}
