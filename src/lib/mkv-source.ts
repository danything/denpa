/**
 * **端末に保存した録画 (Matroska の Blob) を、canvas に描くプレイヤーへ流す入口** (互換モード。`canvas-player.ts` の `request`)。
 *
 * サーバの `/stream` の代わりに、Blob を切り出して流す。
 *
 * - 開くときに先頭 (最初の Cluster まで: Info・Tracks) と、飛ぶ位置の表 (Cues。位置は SeekHead に書いてある) を読む
 * - `from` 秒から観るときは、表で `from` より手前のいちばん近い Cluster を引き、**先頭 + その Cluster から末尾まで**
 *   を 1 本のストリームにする。読む側 (`raw/mkv.ts`) は位置を確かめないので、繋いだまま読める。手前のコマは
 *   描かない (`floor`。サーバから流すときと同じ)
 * - 表が無ければ先頭から流す (飛んだ先まではデコードして捨てるので遅いが、観られる)
 *
 * 読むのは先頭と表の数 MB だけ。中身は流しながら読む (`Blob.stream`。端末のメモリへ丸ごとは載せない)
 */

import {
  cueBefore,
  loadCues,
  loadMkvHead,
  type MkvTrack,
  type ReadAt,
} from "#lib/ts/mkv-media.js";

export interface MkvSource {
  /** 尺 (秒)。書いていなければ null */
  duration: number | null;
  /** 映像の形式 (`h264` / `av1`)。読めなければ null */
  codec: "h264" | "av1" | null;
  /** 音声のトラック (並び順)。`request` の `audio` はこの何本目か */
  audios: MkvTrack[];
  /** `from` 秒から流す (`canvas-player.ts` の `request`) */
  request(from: number): Response;
}

/** 開く。**Matroska として読めなければ null** (互換モードで描けない。呼ぶ側がほかの方式を選ぶ) */
export async function openMkv(blob: Blob): Promise<MkvSource | null> {
  const read: ReadAt = async (offset, length) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  const head = await loadMkvHead(read, blob.size);
  if (head === null) return null;
  const { segment, firstCluster } = head;
  const video = head.tracks.find((t) => t.kind === "video") ?? null;
  const codec = video?.codec?.startsWith("avc1")
    ? "h264"
    : video?.codec?.startsWith("av01")
      ? "av1"
      : null;

  const cues = video === null ? [] : await loadCues(read, head, video.number);
  const top = blob.slice(0, firstCluster);
  return {
    duration: head.duration,
    codec,
    audios: head.tracks.filter((t) => t.kind === "audio"),
    request(from: number): Response {
      const cue = cueBefore(cues, from);
      const start = cue === null ? firstCluster : segment + cue.position;
      return new Response(new Blob([top, blob.slice(start)]).stream());
    },
  };
}
