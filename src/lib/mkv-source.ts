/**
 * **端末に保存した録画 (Matroska の Blob) を、canvas に描く器へ流す口** (互換モード。`canvas-player.ts` の `request`)。
 *
 * サーバの `/stream` の代わりに、Blob を切り出して流す:
 *
 * - 開くときに頭 (最初の Cluster まで: Info・Tracks) と、飛ぶ位置の表 (Cues。SeekHead が在りかを言う) を読む
 * - `from` 秒から観るときは、表で `from` より手前のいちばん近い Cluster を引き、**頭 + その Cluster から尻まで**
 *   を1本の流れにする。読む側 (`raw/mkv.ts`) は位置を確かめないので、繋いだまま読める。手前のコマは
 *   描かない (`floor`。サーバから流すときと同じ)
 * - 表が無ければ頭から流す (飛んだ先まではデコードして捨てるので遅いが、観られる)
 *
 * 読むのは頭と表の数 MB だけ。中身は流しながら読む (`Blob.stream`。端末のメモリへ丸ごとは載せない)
 */

import {
    cueBefore,
    elementSize,
    type MkvCue,
    type MkvTrack,
    readCues,
    readMkvHead,
} from '#lib/ts/mkv-media.js';

/** 頭を読む量 (バイト)。足りなければ倍にして読み直す (Tags・Chapters が大きい録画) */
const HEAD_FIRST = 1024 * 1024;
const HEAD_MOST = 32 * 1024 * 1024;

export interface MkvSource {
    /** 尺 (秒)。書いていなければ null */
    duration: number | null;
    /** 映像の形 (`h264` / `av1`)。読めなければ null */
    codec: 'h264' | 'av1' | null;
    /** 音声の軌道 (並び順)。`request` の `audio` はこの何本目か */
    audios: MkvTrack[];
    /** `from` 秒から流す (`canvas-player.ts` の `request`) */
    request(from: number): Response;
}

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** 開く。**Matroska として読めなければ null** (互換モードで描けない。呼ぶ側がほかの道を選ぶ) */
export async function openMkv(blob: Blob): Promise<MkvSource | null> {
    let size = HEAD_FIRST;
    let head = readMkvHead(await bytes(blob, 0, size));
    while (head === null && size < Math.min(HEAD_MOST, blob.size)) {
        size *= 2;
        head = readMkvHead(await bytes(blob, 0, size));
    }
    if (head === null) return null;
    const { segment, firstCluster, scale } = head;
    const video = head.tracks.find((t) => t.kind === 'video') ?? null;
    const codec = video?.codec?.startsWith('avc1') ? 'h264' : video?.codec?.startsWith('av01') ? 'av1' : null;

    let cues: MkvCue[] = [];
    if (head.cues !== null && video !== null) {
        // 頭 (大きさ) を読んでから、要素ごと読む
        const lead = await bytes(blob, head.cues, head.cues + 16);
        const length = elementSize(lead);
        if (length !== null)
            cues = readCues(await bytes(blob, head.cues, head.cues + length), scale, video.number);
    }
    const top = blob.slice(0, firstCluster);
    return {
        duration: head.duration,
        codec,
        audios: head.tracks.filter((t) => t.kind === 'audio'),
        request(from: number): Response {
            const cue = cueBefore(cues, from);
            const start = cue === null ? firstCluster : segment + cue.position;
            return new Response(new Blob([top, blob.slice(start)]).stream());
        },
    };
}
