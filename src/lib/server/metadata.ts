import { existsSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pad } from '../format';
import type { Recording } from '../types';
import { config } from './config';
import { removeIfExists } from './fsx';

/**
 * メタデータ(NFO)とサムネイルを、動画の隣にサイドカーとして置く。
 *
 * 日本の放送番組は TheTVDB / TMDB に載っていないものがほとんどで、
 * インターネット取得に任せるとタイトルだけの一覧になってしまう。番組名・概要・
 * 放送日・放送局は EPG から取れているので、こちらから書いて渡す。
 *
 * **1録画 = 1本の「映画」として書く (`<movie>`)。** 想定プレイヤーの Nova は
 * ローカルの `<movie>` NFO をオンライン照合なしでそのまま出し、`<episodedetails>`
 * と違って**録画ごとのポスター (`-poster.jpg`) も読む**。TVエピソード扱いだと
 * 話数の付かない日本の番組は全話 S00E00 送りになり、録画ごとのサムネも出せなかった。
 * インターネットのメタデータ取得は切っておくと、ここで書いた内容が上書きされない。
 */

function xml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * `<plot>` に入れる本文。**概要 (短形式) に続けて、詳細 (拡張形式) を段落で足す。**
 *
 * 概要だけだと一文で終わり、Nova では番組詳細が一行しか出なかった。拡張形式は
 * `{見出し:本文}` の JSON (出演者・番組内容など) なので、見出しごとに段落にして繋ぐ。
 */
function plot(recording: Recording): string {
    const paragraphs: string[] = [];
    if (recording.description !== '') paragraphs.push(recording.description);

    if (recording.extended !== null && recording.extended !== '') {
        try {
            const sections = JSON.parse(recording.extended) as Record<string, string>;
            for (const [heading, body] of Object.entries(sections)) {
                const text = heading === '' ? body : `${heading}\n${body}`;
                if (text.trim() !== '') paragraphs.push(text);
            }
        } catch {
            // 壊れていれば概要だけで諦める
        }
    }
    return paragraphs.join('\n\n');
}

/**
 * サイドカーの置き場。`foo.mkv` に対して `foo.nfo` / `foo-poster.jpg`。
 *
 * **サムネは `-poster.jpg`。** Nova は動画と同名の `{名前}-poster.jpg`
 * (または `{名前}.jpg`) を映画のポスターとして読む。以前の `-thumb.jpg` は
 * どの命名にも当てはまらず拾われなかった。
 *
 * **字幕は置きません。** 入れ物の中に入っていて、抜くのは実測で0.1〜1秒
 * (`api/recordings/<id>/captions.sup`)。置くと動画1本ぶん場所を積む上に、
 * 焼き直しのたびに揃え直すことになる。
 *
 * `subtitle` が残っているのは**片付けるため**。文字の写しを `.ja.ass` として
 * 置いていた頃のものが、焼き直しても消えずに残るのを防ぐ (`subtitle.ts`)
 */
export function sidecarPaths(videoPath: string): {
    nfo: string;
    thumbnail: string;
    subtitle: string;
    dataBroadcast: string;
} {
    const base = videoPath.slice(0, videoPath.length - extname(videoPath).length);
    return {
        nfo: `${base}.nfo`,
        thumbnail: `${base}-poster.jpg`,
        subtitle: `${base}.ja.ass`,
        // 録画のデータ放送 (再生位置つきの変化ログ)。d ボタンで出す (server/recorded-bml.ts)
        dataBroadcast: `${base}.bml.jsonl`,
    };
}

/**
 * 録画1本ぶんの映画NFO (`<movie>`)。
 *
 * タイトルは**カードだけで番組が分かるように**組む — 副題があれば
 * `シリーズ名 副題`、無ければシリーズ名 (映画・単発はこれで完結する)。番組名
 * (`name`) は「第6話…[字]」のような放送側の飾りが混じるので使わない。
 * plot は概要 (description) に詳細 (extended) を続けたもの。放送日は
 * `<premiered>`、年は `<year>` に入れる。
 *
 * `posterName` を渡すと `<thumb>` にポスターのファイル名を書く。**WebDAV 経由の
 * Nova は、名前規約 (`{名前}-poster.jpg`) だけではポスターを紐付けられず、NFO に
 * `<thumb>` が要る**。同じフォルダに置くので相対のファイル名でよい。
 */
export function movieNfo(recording: Recording, posterName?: string): string {
    const start = new Date(recording.start_at);
    const premiered = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const title = recording.subtitle === '' ? recording.series : `${recording.series} ${recording.subtitle}`;

    const lines = [
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
        '<movie>',
        `  <title>${xml(title)}</title>`,
        `  <plot>${xml(plot(recording))}</plot>`,
        `  <premiered>${premiered}</premiered>`,
        `  <year>${start.getFullYear()}</year>`,
        `  <studio>${xml(recording.service_name)}</studio>`,
        // 再スキャンで別物として作り直されないよう、こちらのIDを持たせる
        `  <uniqueid type="denpa" default="true">${recording.id}</uniqueid>`,
    ];
    if (posterName !== undefined) lines.push(`  <thumb>${xml(posterName)}</thumb>`);
    lines.push('</movie>', '');
    return lines.join('\n');
}

/**
 * サムネイルを1枚切り出す。
 * 頭はたいてい提供表示やCMなので少し進めた位置から取る。番組が短いときは
 * 尺の1/3の位置にずらす(指定位置が尺を超えると ffmpeg が何も出力しないため)。
 *
 * **CM検出が効いていれば `content` (本編の最初の区間) を渡す。** 頭からの固定秒数だと、
 * 冒頭がCMや提供表示のままの番組 (チャプター付けのみで切っていない録画) でCMの絵を
 * 掴んでしまう。本編区間の頭から測り直し、区間が短ければその真ん中に寄せる。
 */
export async function writeThumbnail(
    videoPath: string,
    durationSec: number,
    content?: { start: number; end: number },
): Promise<boolean> {
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

    const proc = Bun.spawn(
        [
            config.ffmpeg,
            '-y',
            '-ss',
            String(Math.max(0, at)),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-vf',
            `scale=${config.thumbnailWidth}:-1`,
            thumbnail,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
    );
    const code = await proc.exited;
    return code === 0 && existsSync(thumbnail);
}

/** NFO を書く。動画を置いた直後に呼ぶ */
export function writeNfo(recording: Recording, videoPath: string): void {
    if (!config.writeNfo) return;
    const { nfo, thumbnail } = sidecarPaths(videoPath);
    writeFileSync(nfo, movieNfo(recording, basename(thumbnail)));
}

/** 動画と一緒に、隣の付き添いを全部消す。取り残すと中身の無い録画がプレイヤーに残る */
export function removeSidecars(videoPath: string | null): void {
    if (videoPath === null || videoPath === '') return;
    const { nfo, thumbnail, subtitle, dataBroadcast } = sidecarPaths(videoPath);
    removeIfExists(nfo);
    removeIfExists(thumbnail);
    removeIfExists(subtitle);
    removeIfExists(dataBroadcast);
}
