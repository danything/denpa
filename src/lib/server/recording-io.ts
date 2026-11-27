/**
 * **録画のファイルの中身を読み書きする入口。** 元の TS とエンコードしたもの (置き場の `.mkv`) の中身に触るのは、
 * なるべくここを通す。
 *
 * ふだんの録画は素のファイルを読み書きするだけで、中で何もしていない (取り込んだ TS は下の「取り込んだ TS」)。
 * 入口を 1 か所に寄せておくのは、あとで**録画を暗号化して置く**ときに、ここだけ直せば済むようにするため。
 *
 * - `recordingInput` … ffmpeg に録画を読ませる引数 (`-i` とそのパス)
 * - `recordingProbeInput` … ffprobe に録画を読ませる引数
 * - `recordingStream` … 先頭から・途中から読む (再生・配信・ffmpeg の標準入力へ流す)
 * - `recordingFile` … 大きさと中身を同じファイルから取る (Range の答え。`serve.serveFile`)
 * - `readRecording` … 決まった位置から決まった長さだけ読む (先頭と末尾を探る)
 * - `openRecording` / `openRecordingSync` … 開いたまま位置を指定して何度も読む (伸びている録画の追い読み・先頭を探る)
 * - `recordingSize` … 中身の大きさ (追っかけのバイト比例のシーク)
 * - `appendRecording` … 録画を書き足す (`recorder.ts`)
 *
 * パスを決めるのは `library.ts` (`recordedPath`・`encodedPath`・`libraryPath`)。
 *
 * ## 取り込んだ TS
 *
 * ほかのソフトで録って取り込んだ TS (`ts-import.ts`) は、ほかのソフトも書けるフォルダに置いたまま読む。
 * 取り込んだあとにそのパスがシンボリックリンクや別のものに置き換わっても、取り込んだフォルダの外を読まないように、
 * **取り込んだパス ({@link guardImported}) は、開いてから開いたものがそのパスのファイルかを確かめ、同じハンドルから大きさを取って読む。**
 * ふだんの録画の置き場 (`RAW_DIR`・保存先) は denpa だけが書く前提なので、確かめない (docs/migrate.md「取り込んだ TS を読むとき」)。
 *
 * - 開くときはリンクを辿らない (`O_NOFOLLOW`)。FIFO で止まらないよう `O_NONBLOCK` も付ける
 * - 開いたものが普通のファイルで、Linux では `/proc/self/fd/<fd>` が指すパスが取り込んだパス (取り込んだときの `realpath`) と同じか。
 *   途中のフォルダがリンクに替わっていても、カーネルが開いた実体のパスを返すので見分けられ、確かめてから読むまでの間に差し替えられる隙も無い
 * - `/proc` の無い OS (Mac・Windows) は、開いたものと、名前で引き直した `realpath`・`stat` (dev と ino) が同じかを見る。
 *   開いてから名前で引き直すまでの間に差し替えられる隙が残る
 * - 合わなければ読まない (`recordingSize` は null、`recordingFile` は理由、`recordingStream` はエラーになるストリーム、ほかは例外)。ログに 1 回出す
 * - ffmpeg・ffprobe はパスを自分で開く。`recordingInput`・`recordingProbeInput` は引数を作るときに確かめるだけで、
 *   確かめてから ffmpeg が開くまでの間に差し替えられる隙が残る
 *
 * ## まだここを通らない所
 *
 * 暗号化するときは、次も一緒に考える。多くは、denpa の外 (ffmpeg・エージェント) が直にファイルを開くか、
 * 中身ではなくファイルそのもの (大きさ・更新時刻・置き場所) を扱う所。
 *
 * - ffmpeg が直に書き出す所 … エンコード (`encoder.buildArgs` の出力)、チャプターを書き直す (`cm.chapterArgs`) の出力。
 *   ffmpeg が出力のパスを開く
 * - ほかのモジュールを読まない所 … コマ数を測る引数 (`fps.fpsArgs`)。`scripts/fps-smoke.ts` がイメージの中へ
 *   このファイルだけを持ち込んで動かすので、`recordingInput` を使わずに `-i` を直に書いている。
 *   取り込んだ TS の確かめは、呼ぶ側 (`encoder.measureWindow`) が {@link verifyRecording} でする
 * - エージェントが直に読み書きする所 … スクランブルの復号 (`scramble.descramble`)。パスだけ渡し、元の TS を
 *   エージェントが読んで復号したものを書く
 * - ファイルそのものを扱う所 … 移動・削除 (`fsx.ts`・`files.ts`)、移行 (`migrate.ts`)、残量の勘定 (`fsx.fileSize`・
 *   `disk.ts`)、変わったかの見分け (大きさと更新時刻。`playback.probeTs`・`chase.finishedTsSec`・`file-memo.ts`・
 *   `serve.fileEtag`)、エンコードの進み具合 (`/proc` で ffmpeg が読んだ位置を見る。`encoder.ts` の `inputBytes`)。
 *   暗号化すると大きさが中身とずれるので、中身の位置に使っている所 (`probeTs`・`finishedTsSec` の末尾を読む位置) は
 *   暗号化するときに `recordingSize` へ寄せる予定
 */

import {
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  fstatSync,
  openSync,
  read,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

/** 取り込んだ TS のパス。読むたびに、開いたものがこのパスのファイルかを確かめる (冒頭の「取り込んだ TS」) */
const imported = new Set<string>();

/**
 * **取り込んだ TS のパスを足す。** 起動したとき (`runtime.start` が DB の `imported_ts` を全部) と、
 * 取り込んだとき (`ts-import.importFile`) に呼ぶ。パスは取り込んだときの `realpath`
 */
export function guardImported(paths: Iterable<string>): void {
  for (const path of paths) imported.add(path);
}

/** 開いたものが取り込んだパスのファイルではなかった */
export class ReplacedFileError extends Error {
  constructor(path: string) {
    super(`リンクや別のファイルに置き換わっているため読みません: ${path}`);
    this.name = "ReplacedFileError";
  }
}

/** リンクを辿らず (`O_NOFOLLOW`)、FIFO を開いて止まらないように (`O_NONBLOCK`) 読む。Windows にはどちらも無い */
const GUARDED_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
/** 開いた fd の実体のパスを `/proc/self/fd` から引けるか (Linux) */
const PROC_FD = process.platform === "linux" && existsSync("/proc/self/fd");
/** 断ったことをログに出したパス。Range で何度も来るので 1 回だけ出す */
const warned = new Set<string>();

/** 開いた `fd` が `path` のファイルそのものか。違えば例外 (閉じるのは呼ぶ側) */
function assertSame(fd: number, path: string): void {
  const opened = fstatSync(fd, { bigint: true });
  if (
    opened.isFile() &&
    (PROC_FD ? procPath(fd) === path : sameByName(opened, path))
  )
    return;
  throw refuse(path);
}

/** 断る理由。ログには 1 回だけ出す */
function refuse(path: string): ReplacedFileError {
  const error = new ReplacedFileError(path);
  if (!warned.has(path)) {
    warned.add(path);
    console.warn(`[recording] ${error.message}`);
  }
  return error;
}

/** 最後の名前がリンクで開けなかった (`O_NOFOLLOW`。Linux・Mac は ELOOP) なら、断る理由に替える */
function linkRefused(error: unknown, path: string): unknown {
  return (error as { code?: unknown }).code === "ELOOP" ? refuse(path) : error;
}

/** 開いた fd の実体のパス (Linux)。引けなければ null */
function procPath(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/** `/proc` の無い OS。名前で引き直した実体が、開いたものと同じか (引き直すまでの間の差し替えは見分けられない) */
function sameByName(
  opened: { dev: bigint; ino: bigint },
  path: string,
): boolean {
  try {
    if (realpathSync(path) !== path) return false;
    const named = statSync(path, { bigint: true });
    return named.dev === opened.dev && named.ino === opened.ino;
  } catch {
    return false;
  }
}

/** 同期で開いて確かめる。確かめられなければ閉じて例外 */
function openGuardedSync(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, GUARDED_FLAGS);
  } catch (error) {
    throw linkRefused(error, path);
  }
  try {
    assertSame(fd, path);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * **TS を、開いたものがそのパスのファイルかを確かめて開く** (冒頭の「取り込んだ TS」)。取り込んだ TS の読み取りと、
 * 取り込む前に TS を読む所 (`ts-import-read.readTsFacts`) が使う
 */
export async function openExactRecording(path: string): Promise<FileHandle> {
  const handle = await open(path, GUARDED_FLAGS).catch((error: unknown) => {
    throw linkRefused(error, path);
  });
  try {
    assertSame(handle.fd, path);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * **取り込んだ TS なら、いまそのパスにあるのが取り込んだファイルかを確かめる。** 違えば例外。取り込んだ TS でなければ何もしない。
 * パスを自分で開く ffmpeg・ffprobe へ渡す前に使う (確かめてから ffmpeg が開くまでの隙は残る)
 */
export function verifyRecording(path: string): void {
  if (imported.has(path)) closeSync(openGuardedSync(path));
}

/** 確かめた fd から流すとき、一度に読む大きさ */
const STREAM_CHUNK = 256 * 1024;

/** 開いた `fd` の `start` から `end` の手前までを流す。読み終えたか、読む側がやめたら閉じる */
function fdStream(
  fd: number,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let at = start;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const want = Math.min(STREAM_CHUNK, end - at);
        let got = 0;
        if (want > 0) {
          const buffer = new Uint8Array(want);
          try {
            got = await new Promise<number>((resolve, reject) =>
              read(fd, buffer, 0, want, at, (error, bytes) =>
                error === null ? resolve(bytes) : reject(error),
              ),
            );
          } catch (error) {
            close();
            throw error;
          }
          if (got > 0) {
            at += got;
            controller.enqueue(got === want ? buffer : buffer.subarray(0, got));
            return;
          }
        }
        close();
        controller.close();
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

/** すぐエラーになるストリーム (取り込んだ TS を確かめられなかったとき) */
function failedStream(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
}

/**
 * **ffmpeg に録画を読ませる引数。** `"-i", path` の代わりに広げて使う。入力の手前に置くオプション
 * (`-ss`・`-copyts` など) は呼ぶ側がこの前に並べる。読み方を変えるとき (復号など) に要る入力の
 * オプションは、ここが `-i` の前に足す。取り込んだ TS は、ここで確かめる ({@link verifyRecording}。違えば例外)
 */
export function recordingInput(path: string): string[] {
  verifyRecording(path);
  return ["-i", path];
}

/** **ffprobe に録画を読ませる引数。** ffprobe は入力を最後の位置引数で受け取るので、パスだけを返す (`recordingInput` と同じ考え) */
export function recordingProbeInput(path: string): string[] {
  verifyRecording(path);
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
  if (!imported.has(path)) return plainStream(path, start, end);
  const file = recordingFile(path);
  return file instanceof Error ? failedStream(file) : file.stream(start, end);
}

/** 名前で引いて読む (ふだんの録画) */
function plainStream(
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
  if (imported.has(path)) {
    const handle = await openExactRecording(path);
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
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
  return imported.has(path) ? openExactRecording(path) : open(path, "r");
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
  const fd = imported.has(path) ? openGuardedSync(path) : openSync(path, "r");
  return {
    read: (buffer, offset, length, position) =>
      readSync(fd, buffer, offset, length, position),
    close: () => closeSync(fd),
  };
}

/** 録画の中身の大きさ (バイト)。無ければ null (消された・まだ書き始めていない・取り込んだ TS を確かめられない) */
export function recordingSize(path: string): number | null {
  const file = recordingFile(path);
  if (file instanceof Error) return null;
  file.close();
  return file.size;
}

/** 開いた録画 (`recordingFile`)。大きさと中身は同じファイルから取る */
export interface OpenedRecording {
  /** 開いたときの大きさ (バイト) */
  readonly size: number;
  /** `start` から `end` の手前までを流す (省けば先頭から・開いたときの末尾まで)。1 回だけ呼ぶ。呼べば `close` は要らない */
  stream(start?: number, end?: number): ReadableStream<Uint8Array>;
  /** `stream` を呼ばずにやめるとき */
  close(): void;
}

/**
 * **録画を開いて、大きさと中身を同じファイルから取る** (`serve.serveFile` の Range)。無いか、取り込んだ TS を確かめられなければ、
 * その理由 (Error) を返す。取り込んだ TS は確かめた fd から大きさを取って流す。ほかは今までどおり名前で引く
 */
export function recordingFile(path: string): OpenedRecording | Error {
  if (!imported.has(path)) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch (error) {
      return error as Error;
    }
    return {
      size,
      stream: (start, end) => plainStream(path, start, end),
      close: () => {},
    };
  }
  let fd: number;
  try {
    fd = openGuardedSync(path);
  } catch (error) {
    return error as Error;
  }
  const size = fstatSync(fd).size;
  let used = false;
  return {
    size,
    stream: (start = 0, end = size) => {
      used = true;
      return fdStream(fd, start, Math.min(end, size));
    },
    close: () => {
      if (used) return;
      used = true;
      closeSync(fd);
    },
  };
}

/**
 * **録画に書き足す。** 追記で開く。再起動をまたいで録画を再開したときに、それまでの分を消さないため
 * (MPEG-TS は 188 バイトのパケットの並びなので、そのまま繋げても読める)
 */
export function appendRecording(path: string): WriteStream {
  return createWriteStream(path, { flags: "a" });
}
