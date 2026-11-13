import { extname } from "node:path";

import type { Range } from "../ts/cm-decide";
import { config } from "./config";
import { removeIfExists } from "./fsx";
import { recordingInput } from "./recording-io";
import { run } from "./stream";
import { TS_PROBE } from "./ts-probe";
import { HLG_TO_SDR } from "./uhd";

/**
 * 動画の隣に置くサイドカー。番組情報そのものは DB が持ち、denpa の画面が出す。
 */

/** サイドカーの接尾辞 (サムネイル・データ放送・字幕の順)。名前を作る `sidecarPaths` も、片付けと孤児探し (files.ts) もこの一覧で見る */
export const SIDECAR_SUFFIXES = [
  "-poster.jpg",
  ".bml.jsonl",
  ".captions.json",
] as const;

/**
 * サイドカーの置き場。`foo.mkv` に対して `foo-poster.jpg`。
 *
 * サムネイル (`-poster.jpg`) は denpa の画面 (`/api/recordings/<id>/poster`) が配る画像。
 *
 * **TS の局の字幕は置かない。** コンテナの中に入っていて、取り出すのは実測で 0.1〜1 秒
 * (`api/recordings/<id>/captions.json`。一度取り出したものはメモリに覚えておく)。
 * 4K の局の字幕 (TTML) は Matroska に入れられないので、文字の配置にして置く (`….captions.json`。`encoder.writeCaptions`)
 */
export function sidecarPaths(videoPath: string): {
  thumbnail: string;
  dataBroadcast: string;
  captions: string;
} {
  const base = sidecarBase(videoPath);
  return {
    thumbnail: `${base}${SIDECAR_SUFFIXES[0]}`,
    // 録画のデータ放送 (再生位置つきの変化ログ)。d ボタンで出す (server/recorded-bml.ts)
    dataBroadcast: `${base}${SIDECAR_SUFFIXES[1]}`,
    captions: `${base}${SIDECAR_SUFFIXES[2]}`,
  };
}

/** サイドカーの名前の土台 (動画の拡張子を落としたもの) */
function sidecarBase(videoPath: string): string {
  return videoPath.slice(0, videoPath.length - extname(videoPath).length);
}

/**
 * 位置から数えて何コマの中から代表を選ぶか。元の TS (29.97 コマ/秒) で約 15 秒ぶん。
 * CM 明けの黒コマ・フェードインをまたげる長さにしてある。
 */
const THUMBNAIL_CANDIDATES = 450;

/** サムネイルを取る位置 (読む入力の時刻) と、そこから読んでよい長さ */
interface ThumbnailPlace {
  at: number;
  limit?: number;
}

/**
 * サムネイルの ffmpeg 引数。
 *
 * **位置のコマをそのまま使わず、そこから `thumbnail` フィルタで代表を選ぶ。**
 * 位置決めだけだった頃は、CM 明けに当たると黒コマや
 * フェードインのコマを選ぶことがあった。`thumbnail` は候補の中で平均ヒストグラムに
 * いちばん近いコマを返すので、黒コマ (平均から遠い) は自然に外れて、
 * 少し後ろの本編のコマに落ち着く。
 *
 * **`limit` があれば、そこで読むのをやめる** (入力の `-t`)。本編の区間の終わりまでにして、
 * 候補に CM のコマを混ぜない。候補が 450 に届かなくても、読めたぶんの中から選ぶ。
 *
 * **片方のフィールドだけ使う** (`field=top`。元の TS は 1080i なので、そのままだと縞が出る)。
 * どうせ縦 270 まで縮めるので 540 行あれば足り、インタレ解除 (bwdif) より軽い (実測で約 0.7 秒差)。
 * 縦が半分になるぶん画素の縦横比を半分にし、**縦横比を直して縮める** (地上波 HD は 1440x1080 の SAR 4:3)。
 * jpg の SAR は画面が使わない。
 * 縮めてから選ぶのは、`thumbnail` が候補を全部持つため (1080p のままだと候補 450 コマで 1.4GB ほど使う)。
 * 選ぶ基準 (ヒストグラム) は縮めても変わらない。
 *
 * **4K の局 (`hlg`) は、縮めたあとで HLG を SDR に直す** (`uhd.HLG_TO_SDR`)。直さないと色の薄い画像になる
 */
export function buildThumbnailArgs(
  videoPath: string,
  thumbnail: string,
  place: ThumbnailPlace,
  before: readonly string[] = [],
  hlg = false,
): string[] {
  const limit =
    place.limit !== undefined && place.limit > 0
      ? ["-t", String(place.limit)]
      : [];
  return [
    "-y",
    "-ss",
    String(Math.max(0, place.at)),
    ...limit,
    ...before,
    ...recordingInput(videoPath),
    "-frames:v",
    "1",
    "-vf",
    [
      "field=top",
      "setsar=sar/2",
      `scale=${config.thumbnailWidth}:trunc(ow/dar/2)*2`,
      "setsar=1",
      ...(hlg ? HLG_TO_SDR : []),
      `thumbnail=${THUMBNAIL_CANDIDATES}`,
    ].join(","),
    thumbnail,
  ];
}

/**
 * サムネイルをどこから取るか。**`cm` の時刻は全部、コンテナ (元の TS) の先頭からの秒** (CM 検出と同じ物差し)。
 *
 * エンコードしたもの (AV1) をデコードし直さず、元の TS (MPEG-2/H.264) から取る。AV1 のソフトウェアデコードは
 * 数百コマでも重い。選ぶコマはエンコードしたものから取っていた頃と同じ。
 *
 * - **CM がある** (`content` = 本編の最初の区間) … 区間の先頭から測る。区間が短ければその真ん中
 * - **CM 無し** … エンコードしたものの先頭 (`skip` 秒捨てた所) から `thumbnailPosition` 秒 (短ければ尺の 1/3)
 *
 * 区間が分かるときは、その終わりまでしか読まない (候補に CM を混ぜない)。
 * エンコードしたものと元の TS の数ミリ秒のずれ (muxer) は見ない。`thumbnail` が約 15 秒の中から選ぶので効かない
 */
export function thumbnailPlace(
  durationSec: number,
  cm: { skip: number; content: Range | null } = { skip: 0, content: null },
): ThumbnailPlace {
  const head =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.min(config.thumbnailPosition, durationSec / 3)
      : config.thumbnailPosition;
  const content = cm.content;
  if (
    content !== null &&
    Number.isFinite(content.start) &&
    Number.isFinite(content.end)
  ) {
    const segment = Math.max(0, content.end - content.start);
    const offset = Math.min(config.thumbnailPosition, segment / 2);
    return { at: content.start + offset, limit: segment - offset };
  }
  return { at: Math.max(0, cm.skip) + head };
}

/**
 * サムネイルを 1 枚切り出して `videoPath` の隣に置く。
 * 冒頭はたいてい提供表示や CM なので少し進めた位置から取る。番組が短いときは
 * 尺の 1/3 の位置にずらす (指定位置が尺を超えると ffmpeg が何も出力しないため)。
 *
 * `from` を渡せば、画像はそちら (元の TS) の `place` から取る (`thumbnailPlace`)。
 * 渡さなければ `videoPath` そのものの先頭から (エンコードしない録画・取り込み)。
 * 位置ぴったりのコマではなく、そこからの代表を選ぶ (buildThumbnailArgs)。
 */
export async function writeThumbnail(
  videoPath: string,
  durationSec: number,
  from?: { source: string; place: ThumbnailPlace; hlg?: boolean },
): Promise<void> {
  const { thumbnail } = sidecarPaths(videoPath);
  const args =
    from === undefined
      ? buildThumbnailArgs(videoPath, thumbnail, thumbnailPlace(durationSec))
      : buildThumbnailArgs(
          from.source,
          thumbnail,
          from.place,
          TS_PROBE,
          from.hlg === true,
        );
  await run([config.ffmpeg, ...args]);
}

/** 動画と一緒に、隣のサイドカーを全部消す。取り残すと片付かないゴミになる */
export function removeSidecars(videoPath: string | null): void {
  if (videoPath === null || videoPath === "") return;
  const base = sidecarBase(videoPath);
  for (const suffix of SIDECAR_SUFFIXES) removeIfExists(`${base}${suffix}`);
}
