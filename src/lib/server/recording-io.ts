/**
 * **録画のファイルの中身を読み書きする入口。** 元の TS とエンコードしたもの (置き場の `.mkv`) の中身に触るのは、
 * なるべくここを通す。
 *
 * いまは素のファイルを読み書きするだけで、中で何もしていない (振る舞いは呼ぶ側で直に開いていた頃と同じ)。
 * 入口を 1 か所に寄せておくのは、あとで**録画を暗号化して置く**ときに、ここだけ直せば済むようにするため。
 *
 * - `recordingInput` … ffmpeg に録画を読ませる引数 (`-i` とそのパス)
 * - `recordingProbeInput` … ffprobe に録画を読ませる引数
 * - `recordingStream` … 先頭から・途中から読む (再生・配信・ffmpeg の標準入力へ流す)
 * - `readRecording` … 決まった位置から決まった長さだけ読む (先頭と末尾を探る)
 * - `openRecording` / `openRecordingSync` … 開いたまま位置を指定して何度も読む (伸びている録画の追い読み・先頭を探る)
 * - `recordingSize` … 中身の大きさ (Range の答え・追っかけのバイト比例のシーク)
 * - `appendRecording` … 録画を書き足す (`recorder.ts`)
 *
 * パスを決めるのは `library.ts` (`recordedPath`・`encodedPath`・`libraryPath`)。
 *
 * ## まだここを通らない所
 *
 * 暗号化するときは、次も一緒に考える。多くは、denpa の外 (ffmpeg・エージェント) が直にファイルを開くか、
 * 中身ではなくファイルそのもの (大きさ・更新時刻・置き場所) を扱う所。
 *
 * - ffmpeg が直に書き出す所 … エンコード (`encoder.buildArgs` の出口)、CM を切る (`cm-cut.cutArgs`)・
 *   チャプターを書き直す (`cm-cut.chapterArgs`) の出口。ffmpeg が出口のパスを開く
 * - ffmpeg が一覧から開く所 … CM を切るときの concat の一覧 (`cm-cut.cutList`)。一覧に並んだ録画を ffmpeg が開く
 * - ほかのモジュールを読まない所 … コマ数を測る引数 (`fps.fpsArgs`)。`scripts/fps-smoke.ts` がイメージの中へ
 *   このファイルだけを持ち込んで動かすので、`recordingInput` を使わずに `-i` を直に書いている
 * - エージェントが直に読み書きする所 … スクランブルの復号 (`scramble.descramble`)。パスだけ渡し、元の TS を
 *   エージェントが読んで復号したものを書く
 * - ファイルそのものを扱う所 … 移動・削除 (`fsx.ts`・`files.ts`)、移行 (`migrate.ts`)、残量の勘定 (`chase.fileSize`・
 *   `disk.ts`)、変わったかの見分け (大きさと更新時刻。`playback.probeTs`・`chase.finishedTsSec`・`file-memo.ts`・
 *   `serve.fileEtag`)、エンコードの進み具合 (`/proc` で ffmpeg が読んだ位置を見る。`encoder.ts` の `inputBytes`)。
 *   暗号化すると大きさが中身とずれるので、中身の位置に使っている所 (`probeTs`・`finishedTsSec` の末尾を読む位置) は
 *   暗号化するときに `recordingSize` へ寄せる予定
 */

import {
  closeSync,
  createWriteStream,
  openSync,
  readSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

/**
 * **ffmpeg に録画を読ませる引数。** `"-i", path` の代わりに広げて使う。入力の手前に置くオプション
 * (`-ss`・`-copyts` など) は呼ぶ側がこの前に並べる。読み方を変えるとき (復号など) に要る入力の
 * オプションは、ここが `-i` の前に足す
 */
export function recordingInput(path: string): string[] {
  return ["-i", path];
}

/** **ffprobe に録画を読ませる引数。** ffprobe は入力を最後の位置引数で受け取るので、パスだけを返す (`recordingInput` と同じ考え) */
export function recordingProbeInput(path: string): string[] {
  return [path];
}

/**
 * **録画を `start` バイト目から `end` バイト目の手前まで読む。** 省けば先頭から・末尾まで。
 * 読み始めたときの末尾までで終わる (伸びている録画を追って読むのは `chase.followFile`)
 */
export function recordingStream(
  path: string,
  start?: number,
  end?: number,
): ReadableStream<Uint8Array> {
  const file = Bun.file(path);
  return (
    start === undefined && end === undefined ? file : file.slice(start, end)
  ).stream();
}

/** 録画の `offset` バイト目から `length` バイトを読む。末尾に掛かれば、そこまでの短いものが返る */
export async function readRecording(
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  return new Uint8Array(
    await Bun.file(path)
      .slice(offset, offset + length)
      .arrayBuffer(),
  );
}

/** 位置を指定して読む開き方 (`openRecording`)。`read` の `position` が null なら続きから */
export type RecordingHandle = Pick<FileHandle, "read" | "close">;

/** 録画を開く。位置を指定して読み、使い終えたら `close` する。伸びている録画も、読んだ時点の末尾まで読める */
export function openRecording(path: string): Promise<RecordingHandle> {
  return open(path, "r");
}

/** 同期で読む開き方 (`openRecordingSync`) */
export interface RecordingSyncHandle {
  /** `position` から `length` バイトを `buffer` の `offset` へ読む。読めたバイト数を返す */
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  close(): void;
}

/** 録画を同期で開く。その場で答えを決めないといけない所 (追っかけの読み始め・スクランブルの判定) 用 */
export function openRecordingSync(path: string): RecordingSyncHandle {
  const fd = openSync(path, "r");
  return {
    read: (buffer, offset, length, position) =>
      readSync(fd, buffer, offset, length, position),
    close: () => closeSync(fd),
  };
}

/** 録画の中身の大きさ (バイト)。無ければ null (消された・まだ書き始めていない) */
export function recordingSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * **録画に書き足す。** 追記で開く。再起動をまたいで録画を再開したときに、それまでの分を消さないため
 * (MPEG-TS は 188 バイトのパケットの並びなので、そのまま繋げても読める)
 */
export function appendRecording(path: string): WriteStream {
  return createWriteStream(path, { flags: "a" });
}
