import { extname } from 'node:path';
import type { Range } from '../ts/cm-decide';
import { config } from './config';
import { removeIfExists } from './fsx';
import { run } from './stream';
import { TS_PROBE } from './ts-probe';

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
 * 位置から数えて何コマの中から代表を選ぶか。生TS (29.97コマ/秒) で約15秒ぶん。
 * CM明けの黒コマ・フェードインをまたげる長さにしてある。
 */
const THUMBNAIL_CANDIDATES = 450;

/** サムネを取る位置 (読む入力の時刻) と、そこから読んでよい長さ */
export interface ThumbnailPlace {
    at: number;
    limit?: number;
}

/**
 * サムネイルの ffmpeg 引数。
 *
 * **位置のコマをそのまま使わず、そこから `thumbnail` フィルタで代表を選ぶ。**
 * 位置決めだけだった頃は、CM明けやCMを切った繋ぎ目に当たると黒コマや
 * フェードインを掴むことがあった。`thumbnail` は候補の中で平均ヒストグラムに
 * いちばん近いコマを返すので、黒コマ (平均から遠い) は自然に外れて、
 * 少し後ろの本編の絵に落ち着く。
 *
 * **`limit` があれば、そこで読むのをやめる** (入力の `-t`)。本編の区間の終わりまでにして、
 * 候補にCMのコマを混ぜない。候補が450に届かなくても、読めたぶんの中から選ぶ。
 *
 * **片方のフィールドだけ使う** (`field=top`。生TSは 1080i なので、そのままだと縞が出る)。
 * どうせ縦270まで縮めるので540行あれば足り、インタレ解除 (bwdif) より軽い (実測で約0.7秒差)。
 * 縦が半分になるぶん画素の縦横比を半分にし、**縦横比を直して縮める** (地上波HDは 1440x1080 の SAR 4:3)。
 * jpg の SAR は画面が見ない。
 * 縮めてから選ぶのは、`thumbnail` が候補を全部持つため (1080p のままだと候補450コマで1.4GBほど食う)。
 * 選ぶ基準 (ヒストグラム) は縮めても変わらない。
 */
export function buildThumbnailArgs(
    videoPath: string,
    thumbnail: string,
    place: ThumbnailPlace,
    before: readonly string[] = [],
): string[] {
    const limit = place.limit !== undefined && place.limit > 0 ? ['-t', String(place.limit)] : [];
    return [
        '-y',
        '-ss',
        String(Math.max(0, place.at)),
        ...limit,
        ...before,
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        `field=top,setsar=sar/2,scale=${config.thumbnailWidth}:trunc(ow/dar/2)*2,setsar=1,thumbnail=${THUMBNAIL_CANDIDATES}`,
        thumbnail,
    ];
}

/**
 * サムネをどこから取るか。**`cm` の時刻は全部、入れ物 (生TS) の頭からの秒** (CM 検出と同じ物差し)。
 *
 * 焼いたもの (AV1) を復号し直さず、生TS (MPEG-2/H.264) から取る — AV1 のソフトウェア復号は
 * 数百コマでも重い。選ぶ絵は焼いたものから取っていた頃と同じ:
 *
 * - **CM を切った** (`kept`) … 焼いたものの頭から `thumbnailPosition` 秒 (短ければ尺の1/3) の所。
 *   残した区間をつないで数え、生TSの時刻に戻す
 * - **CM を残した** (`content` = 本編の最初の区間) … 区間の頭から測る。区間が短ければその真ん中
 * - **CM 無し** … 焼いたものの頭 (`skip` 秒捨てた所) から `thumbnailPosition` 秒 (短ければ尺の1/3)
 *
 * 区間が分かるときは、その終わりまでしか読まない (候補にCMを混ぜない)。
 * 焼いたものと生TSの数ミリ秒のずれ (muxer) は見ない。`thumbnail` が約15秒の中から選ぶので効かない
 */
export function thumbnailPlace(
    durationSec: number,
    cm: { skip: number; kept: Range[] | null; content: Range | null } = {
        skip: 0,
        kept: null,
        content: null,
    },
): ThumbnailPlace {
    const head =
        Number.isFinite(durationSec) && durationSec > 0
            ? Math.min(config.thumbnailPosition, durationSec / 3)
            : config.thumbnailPosition;
    const kept = cm.kept?.filter((r) => r.end > r.start) ?? [];
    if (kept.length > 0) {
        let rest = head;
        for (const range of kept) {
            const length = range.end - range.start;
            if (rest < length) return { at: range.start + rest, limit: length - rest };
            rest -= length;
        }
        // 残した区間を全部足しても届かない (ほとんど切った)。最後の区間の真ん中から
        const last = kept.at(-1)!;
        const length = last.end - last.start;
        return { at: last.start + length / 2, limit: length / 2 };
    }
    const content = cm.content;
    if (content !== null && Number.isFinite(content.start) && Number.isFinite(content.end)) {
        const segment = Math.max(0, content.end - content.start);
        const offset = Math.min(config.thumbnailPosition, segment / 2);
        return { at: content.start + offset, limit: segment - offset };
    }
    return { at: Math.max(0, cm.skip) + head };
}

/**
 * サムネイルを1枚切り出して `videoPath` の隣に置く。
 * 頭はたいてい提供表示やCMなので少し進めた位置から取る。番組が短いときは
 * 尺の1/3の位置にずらす(指定位置が尺を超えると ffmpeg が何も出力しないため)。
 *
 * `from` を渡せば、絵はそちら (生TS) の `place` から取る (`thumbnailPlace`)。
 * 渡さなければ `videoPath` そのものの頭から (エンコードしない録画・取り込み)。
 * 位置ぴったりのコマではなく、そこからの代表を選ぶ (buildThumbnailArgs)。
 */
export async function writeThumbnail(
    videoPath: string,
    durationSec: number,
    from?: { source: string; place: ThumbnailPlace },
): Promise<void> {
    const { thumbnail } = sidecarPaths(videoPath);
    const args =
        from === undefined
            ? buildThumbnailArgs(videoPath, thumbnail, thumbnailPlace(durationSec))
            : buildThumbnailArgs(from.source, thumbnail, from.place, TS_PROBE);
    await run([config.ffmpeg, ...args]);
}

/** 動画と一緒に、隣の付き添いを全部消す。取り残すと片付かないゴミになる */
export function removeSidecars(videoPath: string | null): void {
    if (videoPath === null || videoPath === '') return;
    const base = sidecarBase(videoPath);
    for (const suffix of SIDECAR_SUFFIXES) removeIfExists(`${base}${suffix}`);
}
