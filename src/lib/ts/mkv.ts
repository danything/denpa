/**
 * Matroska から、コマとその時刻だけを取り出す。**字幕 (`S_ARIBSUB`) を運ぶコンテナとして使う。**
 *
 * ライブ視聴では ffmpeg 1 本で映像と字幕の両方を出す ([stream.md](../../../docs/stream.md#字幕))。
 * 映像は fMP4、字幕は**このコンテナ**で受ける。コンテナが要るのは、**時刻を字幕と一緒に
 * 運ばせるため。** 時刻を別の経路 (`showinfo`) で出させると、行とコマの数が合わずにずれて戻らない。
 *
 * Matroska を選んだのは、**必要なところだけなら小さいから**。NUT はコマの
 * ヘッダを組み立てるのに表を復元する必要があり、mp4 は ARIB の字幕を入れられない。
 * 読み方は `mkv-media.ts` の `MkvDemuxer` (端末に保存した録画を読むものと同じ)。ここは時刻をミリ秒に直すだけ
 */

import { MkvDemuxer } from "./mkv-media";

/** 取り出した 1 コマ */
export interface MkvFrame {
  /** そのコマの時刻 (ミリ秒)。**映像の mp4 と同じ物差し** (stream.md#時刻同期) */
  at: number;
  /** 中身そのまま。字幕なら字幕の PES の中身 (`S_ARIBSUB`) */
  data: Uint8Array;
}

/**
 * 繋がったバイト列から、コマを 1 つずつ取り出す。**足りないところで止めて、続きを待つ**
 */
export class MkvSplitter {
  private readonly demuxer = new MkvDemuxer();
  /** トラックの中身の種類 (書いてある順。録画の字幕が `S_ARIBSUB` かを見る) */
  readonly codecs: string[] = [];

  feed(chunk: Uint8Array): MkvFrame[] {
    const { tracks, blocks } = this.demuxer.feed(chunk);
    if (tracks !== null) this.codecs.push(...tracks.map((t) => t.codecId));
    const scale = this.demuxer.scale;
    return blocks.map((block) => ({
      at: (block.at * scale) / 1_000_000,
      data: block.data,
    }));
  }
}
