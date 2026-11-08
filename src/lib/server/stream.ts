import { createServer, type Socket } from "node:net";
import { constants, setPriority } from "node:os";

/** ffmpeg の 4 本目の出口 (`sideOutput`) */
export interface SideOutput {
  /** ffmpeg に書かせる先 (`pipe:3` か名前付きパイプの名前) */
  readonly url: string;
  /** Bun.spawn の stdio の 4 本目 (Windows では無し) */
  readonly stdio: readonly "pipe"[];
  /** 起こした ffmpeg から受ける中身。ffmpeg が終われば終わる。1 回だけ呼ぶ */
  read(proc: {
    stdio: unknown[];
    exited: Promise<number>;
  }): ReadableStream<Uint8Array>;
}

let sides = 0;

/**
 * **ffmpeg の 4 本目の出口** (録画のエンコードの進み具合・ライブの字幕)。ffmpeg を起こす直前に作り、
 * 起こしたら間に `await` を挟まずに `read` を呼ぶ (Windows では、呼ばれないまま次の周回に入ると、起こせなかったとみなして閉じる)。
 *
 * Linux・Mac は stdio の 4 本目のパイプを開けて `pipe:3` に書かせる。**Windows の bun は 4 本目のパイプを
 * 開けても読めない** (`Bun.file(fd)` は EMFILE、`fs.read` は EBADF。tests/native-smoke.ts で確かめた)。
 * 読まずにいると、パイプが詰まったところで ffmpeg が止まる。そこで Windows では名前付きパイプを開けて待ち、
 * ffmpeg にはその名前を出口として渡す (ffmpeg は名前付きパイプをファイルと同じく開いて書く)。
 * 待ち受けはこの呼び出しの中で始まり、ffmpeg が出口を開くのは入力を読み始めたあとなので、起こすより先に開いている
 *
 * **ffmpeg には `-y` を付ける。** 付けないと ffmpeg は出口が既にあるかを `access` で確かめ、Windows ではそれが
 * 名前付きパイプへの 1 本目の接続になる。受けるのは 1 本だけなので、本物の書き込みが開けずに
 * 「Error opening output file」で降りる (ライブの字幕で起きた)
 */
export function sideOutput(): SideOutput {
  if (process.platform !== "win32") {
    return {
      url: "pipe:3",
      stdio: ["pipe"],
      read: (proc) => Bun.file(proc.stdio[3] as number).stream(),
    };
  }
  const url = `\\\\.\\pipe\\denpa-${process.pid}-${++sides}`;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let socket: Socket | null = null;
  let connected = false;
  let done = false;
  // 読む側がやめた (cancel) ときもソケットを閉じる。開いたままだと、ffmpeg が終わるまで書いたものを受けては捨て続ける
  const finish = () => {
    if (done) return;
    done = true;
    server.close();
    socket?.destroy();
    try {
      controller?.close();
    } catch {
      // 読む側が先にやめた
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    // 読む側が追いつかなければ受けるのを止め (下の pause)、読まれたら再開する。溜めすぎない
    pull() {
      socket?.resume();
    },
    cancel: finish,
  });
  const server = createServer((accepted) => {
    // 受けるのは 1 本だけ
    connected = true;
    socket = accepted;
    server.close();
    accepted.on("data", (chunk: Buffer) => {
      if (done || controller === null) return;
      controller.enqueue(new Uint8Array(chunk));
      if ((controller.desiredSize ?? 1) <= 0) accepted.pause();
    });
    accepted.on("close", finish);
    accepted.on("error", finish);
  });
  server.on("error", finish);
  server.listen(url);
  /*
   * **ffmpeg を起こせなかったら閉じる。** 起こしたら同じ流れのまま `read` を呼ぶ決まり (上) なので、
   * 次の周回までに呼ばれていなければ、起こすところで投げている (`Bun.spawn` が ffmpeg を見つけられないなど)。
   * 閉じないと、名前付きパイプが待ち受けたまま残る
   */
  let reading = false;
  setImmediate(() => {
    if (!reading) finish();
  });
  return {
    url,
    stdio: [],
    read: (proc) => {
      reading = true;
      // 出口を開かないまま終わった (起こせなかった・入力が読めなかった) ときも終える
      void proc.exited.then(() => {
        if (!connected) finish();
      });
      return stream;
    },
  };
}

/**
 * ReadableStream を 1 チャンクずつ読む。
 *
 * Bun の ReadableStream は実際には for-await できるが、TypeScript の DOM 型定義には
 * Symbol.asyncIterator が無く型エラーになる。reader を明示的に回すことで型を通しつつ、
 * abort 時に read() が reject する挙動もそのまま使える。
 *
 * **途中で抜けたら (`break`・`return`・投げた) 読み元を cancel する。** 手放すだけだと、読み元は
 * 誰も読まないまま動き続ける。追っかけの `chase.followFile` は、録画が終わるまでファイルを読み足し続けていた。
 * 抜けたあとも同じストリームを読み続ける所は無い。ライブの TS を起こし直しても使い回す `live.ts` の流し込みは、
 * `for await` にせず `next()` で読むので抜けない。cancel は待たない (読み元の後始末で、抜けるのを遅らせない)
 */
export async function* chunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let ended = false;
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        // 読み元が失敗で終わった。cancel するものは無い
        ended = true;
        throw error;
      }
      if (next.done) {
        ended = true;
        return;
      }
      if (next.value !== undefined) yield next.value;
    }
  } finally {
    if (!ended) reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** ストリームを最後まで読んで文字列にする */
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of chunks(stream))
    out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/**
 * 流れてくるバイト列を行に割って返す。
 * ffmpeg の `-progress` の出力のように、終わるのを待たずに読みたいとき用。
 */
export async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks(stream)) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    // 最後の 1 つは途中かもしれないので持ち越す
    buffer = parts.pop() ?? "";
    for (const part of parts) yield part.trim();
  }
  if (buffer.trim() !== "") yield buffer.trim();
}

/** 優先度を下げられなかったことは 1 度だけ知らせる (コンテナで権限が無いなど) */
let lowerFailed = false;

/**
 * **子プロセスを OS のいちばん低い優先度 (nice 19) にする。** 録ったあとのエンコードと、
 * その中で録画をデコードする CM 検出 (`cm-scan.scan`・ロゴの学習) に使う。
 *
 * 非力な機材 (Raspberry Pi 5 など) では、録画のエンコードがライブの変換 (libx264 ultrafast) と
 * CPU を取り合い、ライブのコマが落ちていた。録画のエンコードは急がないので、ライブに譲る。
 * 他に何も動いていなければ空いた CPU をそのまま使うので、速さは変わらない。GPU でエンコードするときも
 * 同じ処理を通るが、下がるのは CPU の順番だけなので困らない。
 *
 * - Linux と Mac では `setpriority`。起こした直後に下げるので、ffmpeg が後から作るスレッドも引き継ぐ
 * - Windows では libuv が 19 を IDLE_PRIORITY_CLASS に当てる
 *
 * 下げられなくても止めない (いつもの優先度で走るだけ)
 */
export function lowerPriority(
  pid: number,
  set: (pid: number, priority: number) => void = setPriority,
): void {
  try {
    set(pid, constants.priority.PRIORITY_LOW);
  } catch (error) {
    // もう終わっていた (ESRCH) なら下げる相手がいないだけ。権限不足の通知を取っておく
    if ((error as { code?: unknown }).code === "ESRCH" || lowerFailed) return;
    lowerFailed = true;
    console.warn(
      `[encode] 優先度を下げられませんでした。いつもの優先度で続けます: ${String(error)}`,
    );
  }
}

/** `onStderrLine` のとき返す標準エラーの行数 */
const STDERR_TAIL = 20;

interface RunResult {
  /** 終了コード。起こせなかったときは 127、時間切れや中止で殺したときは殺された後のコード */
  code: number;
  /** 標準出力の中身 (`stdout: true` のときだけ。無ければ空) */
  stdout: Uint8Array;
  /** 標準エラーの文字 (`stderr: true` のときだけ。無ければ空) */
  stderr: string;
}

/**
 * 外の道具を 1 回動かして、終わるまで待つ。
 *
 * ffmpeg / ffprobe を呼ぶところで、起こす・出力を読み切る・中止 (AbortSignal) や時間切れで殺す・待つ、
 * という同じ処理をあちこちで書いていた。ここに寄せて、**読み切る前に `exited` を待たない**
 * (パイプが詰まって固まる) などの決まりごとを 1 か所で守る。
 *
 * - `signal` … 押されたら殺す (エンコードの中止など)
 * - `timeoutMs` … これを過ぎたら殺す (壊れたファイルで待ち続けない)
 * - 起こせなかった (道具が入っていない) ときは投げずに `code: 127` で返す
 */
export async function run(
  argv: string[],
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    stdout?: boolean;
    stderr?: boolean;
    /**
     * 標準出力を溜めずに、来たそばから渡す。録画 1 本ぶんの未圧縮のフレームのように
     * 溜めると収まらないもの向け (`stdout` より優先。そのとき `stdout` は空で返る)
     */
    onStdout?: (chunk: Uint8Array) => void;
    /**
     * 標準エラーを溜めずに 1 行ずつ渡す。コマごとに行が出るもの (コマ数の実測の `signalstats`・`-progress`) 向け。
     * `stderr` より優先し、返る `stderr` は末尾の数行だけ (落ちた理由を読むため)
     */
    onStderrLine?: (line: string) => void;
    /** 起こしたらいちばん低い優先度にする (`lowerPriority`。録ったあとの重い処理だけ) */
    lowPriority?: boolean;
  } = {},
): Promise<RunResult> {
  /*
   * **もう押されている合図は、起こす前に見る。** `abort` のリスナーは押された
   * *瞬間*にしか呼ばれないので、押された後に起こした道具には届かず、最後まで
   * 走り切っていた。中止を押したあとに CM 検出が無音検出へ落ち、字幕まで
   * 画像にしてから畳んでいたのはこれ。殺されたときと同じコード (143 = SIGTERM) で返す
   */
  if (options.signal?.aborted === true) {
    return { code: 143, stdout: new Uint8Array(), stderr: "中止されました" };
  }
  let proc: Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe" | "ignore">;
  try {
    proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout:
        options.stdout === true || options.onStdout !== undefined
          ? "pipe"
          : "ignore",
      stderr:
        options.stderr === true || options.onStderrLine !== undefined
          ? "pipe"
          : "ignore",
    });
  } catch (error) {
    return { code: 127, stdout: new Uint8Array(), stderr: String(error) };
  }
  if (options.lowPriority === true) lowerPriority(proc.pid);
  const kill = () => proc.kill();
  options.signal?.addEventListener("abort", kill, { once: true });
  const timer =
    options.timeoutMs === undefined
      ? null
      : setTimeout(kill, options.timeoutMs);
  try {
    const { onStdout, onStderrLine } = options;
    const readStderr = async (): Promise<string> => {
      if (onStderrLine === undefined) {
        return options.stderr === true
          ? text(proc.stderr as ReadableStream<Uint8Array>)
          : "";
      }
      const tail: string[] = [];
      try {
        for await (const line of lines(
          proc.stderr as ReadableStream<Uint8Array>,
        )) {
          onStderrLine(line);
          tail.push(line);
          if (tail.length > STDERR_TAIL) tail.shift();
        }
      } catch (error) {
        kill();
        throw error;
      }
      return tail.join("\n");
    };
    const [stdout, stderr] = await Promise.all([
      onStdout !== undefined
        ? (async () => {
            try {
              for await (const chunk of chunks(
                proc.stdout as ReadableStream<Uint8Array>,
              ))
                onStdout(chunk);
            } catch (error) {
              // 受け手が投げたら誰も読まなくなる。子プロセスが詰まって残らないよう止めてから投げ直す
              kill();
              throw error;
            }
            return new Uint8Array();
          })()
        : options.stdout === true
          ? /*
             * **`.bytes()` は使わない。** Bun 1.3.14 は 1MB を境に返すものが
             * 変わる。それ未満は Uint8Array、それ以上は **ArrayBuffer**
             * (`.length` が `undefined` になる)。型は Uint8Array のままなので
             * 型検査では気付けず、`String(out.length)` が "undefined" になって
             * `Content-Length: undefined` を送り、**本文が丸ごと落ちていた**
             * (6.4MB の字幕を持つ録画で字幕が出ない)。
             * `arrayBuffer()` はバージョンによらず ArrayBuffer なので、自分で包む
             */
            new Response(proc.stdout as ReadableStream<Uint8Array>)
              .arrayBuffer()
              .then((buffer) => new Uint8Array(buffer))
          : Promise.resolve(new Uint8Array()),
      readStderr(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
}

/** 子プロセスの標準入力を閉じる。もう閉じていてもいい */
export function endInput(proc: { stdin: unknown }): void {
  try {
    (proc.stdin as import("bun").FileSink).end();
  } catch {
    // もう閉じている
  }
}
