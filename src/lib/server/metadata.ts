import { extname } from 'node:path';
import { config } from './config';
import { removeIfExists } from './fsx';
import { run } from './stream';

/**
 * 動画の隣に置くサイドカー。番組情報そのものはDBが持ち、denpa の画面が出す。
 */

/**
 * サイドカーの置き場。`foo.mkv` に対して `foo-poster.jpg`。
 *
 * サムネ (`-poster.jpg`) は denpa の画面 (`/api/recordings/<id>/poster`) が配る絵。
 *
 * **字幕は置きません。** 入れ物の中に入っていて、抜くのは実測で0.1〜1秒
 * (`api/recordings/<id>/captions.json`)。
 */
export function sidecarPaths(videoPath: string): { thumbnail: string; dataBroadcast: string } {
    const base = sidecarBase(videoPath);
    return {
        thumbnail: `${base}-poster.jpg`,
        // 録画のデータ放送 (再生位置つきの変化ログ)。d ボタンで出す (server/recorded-bml.ts)
        dataBroadcast: `${base}.bml.jsonl`,
    };
}

/** 付き添いの名前の土台 (動画の拡張子を落としたもの) */
function sidecarBase(videoPath: string): string {
    return videoPath.slice(0, videoPath.length - extname(videoPath).length);
}

/** 付き添いの接尾辞。片付けと拾い上げ (files.ts の孤児探し) はこの一覧で見る。増やすときはここだけ */
export const SIDECAR_SUFFIXES = ['-poster.jpg', '.bml.jsonl'] as const;

/**
 * 位置から数えて何コマの中から代表を選ぶか。60コマ/秒の録画で約7.5秒ぶん。
 * CM明けの黒コマ・フェードインをまたげる長さにしてある。
 */
const THUMBNAIL_CANDIDATES = 450;

/**
 * サムネイルの ffmpeg 引数。
 *
 * **位置のコマをそのまま使わず、そこから `thumbnail` フィルタで代表を選ぶ。**
 * 位置決めだけだった頃は、CM明けやCMを切った繋ぎ目に当たると黒コマや
 * フェードインを掴むことがあった。`thumbnail` は候補の中で平均ヒストグラムに
 * いちばん近いコマを返すので、黒コマ (平均から遠い) は自然に外れて、
 * 少し後ろの本編の絵に落ち着く。
 *
 * **縮小してから選ぶ。** `thumbnail` は候補を全部持つので、1080p のまま渡すと
 * 候補450コマで1.4GBほど食う。先に縮めれば数十MBで済み、選ぶ基準 (ヒストグラム) は
 * 縮めても変わらない。
 */
export function buildThumbnailArgs(videoPath: string, thumbnail: string, at: number): string[] {
    return [
        '-y',
        '-ss',
        String(Math.max(0, at)),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${config.thumbnailWidth}:-1,thumbnail=${THUMBNAIL_CANDIDATES}`,
        thumbnail,
    ];
}

/**
 * サムネイルを1枚切り出す。
 * 頭はたいてい提供表示やCMなので少し進めた位置から取る。番組が短いときは
 * 尺の1/3の位置にずらす(指定位置が尺を超えると ffmpeg が何も出力しないため)。
 *
 * **CM検出が効いていれば `content` (本編の最初の区間) を渡す。** 頭からの固定秒数だと、
 * 冒頭がCMや提供表示のままの番組 (チャプター付けのみで切っていない録画) でCMの絵を
 * 掴んでしまう。本編区間の頭から測り直し、区間が短ければその真ん中に寄せる。
 * 位置ぴったりのコマではなく、そこからの代表を選ぶ (buildThumbnailArgs)。
 */
export async function writeThumbnail(
    videoPath: string,
    durationSec: number,
    content?: { start: number; end: number },
): Promise<void> {
    const { thumbnail } = sidecarPaths(videoPath);
    let at: number;
    if (content !== undefined && Number.isFinite(content.start)) {
        const segment = Math.max(0, content.end - content.start);
        at = content.start + Math.min(config.thumbnailPosition, segment / 2);
    } else {
        at =
            Number.isFinite(durationSec) && durationSec > 0
                ? Math.min(config.thumbnailPosition, durationSec / 3)
                : config.thumbnailPosition;
    }

    await run([config.ffmpeg, ...buildThumbnailArgs(videoPath, thumbnail, at)]);
}

/** 動画と一緒に、隣の付き添いを全部消す。取り残すと片付かないゴミになる */
export function removeSidecars(videoPath: string | null): void {
    if (videoPath === null || videoPath === '') return;
    const base = sidecarBase(videoPath);
    for (const suffix of SIDECAR_SUFFIXES) removeIfExists(`${base}${suffix}`);
}
