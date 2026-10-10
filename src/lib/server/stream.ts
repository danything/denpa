/**
 * ReadableStream を1チャンクずつ読む。
 *
 * Bun の ReadableStream は実際には for-await できるが、TypeScript の DOM 型定義には
 * Symbol.asyncIterator が無く型エラーになる。reader を明示的に回すことで型を通しつつ、
 * abort 時に read() が reject する挙動もそのまま使える。
 */
export async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value !== undefined) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/** ストリームを最後まで読んで文字列にする */
export async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let out = '';
    for await (const chunk of chunks(stream)) out += decoder.decode(chunk, { stream: true });
    return out + decoder.decode();
}

/**
 * 流れてくるバイト列を行に割って返す。
 * ffmpeg の `-progress pipe:1` のように、終わるのを待たずに読みたいとき用。
 */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of chunks(stream)) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split('\n');
        // 最後の1つは途中かもしれないので持ち越す
        buffer = parts.pop() ?? '';
        for (const part of parts) yield part.trim();
    }
    if (buffer.trim() !== '') yield buffer.trim();
}

/** `onStderrLine` のとき返す標準エラーの行数 */
const STDERR_TAIL = 20;

export interface RunResult {
    /** 終了コード。起こせなかったときは 127、時間切れや中止で殺したときは殺された後のコード */
    code: number;
    /** 標準出力の中身 (`stdout: true` のときだけ。無ければ空) */
    stdout: Uint8Array;
    /** 標準エラーの文字 (`stderr: true` のときだけ。無ければ空) */
    stderr: string;
}

/**
 * 外の道具を1回動かして、終わるまで待つ。
 *
 * ffmpeg / ffprobe / CM検出の道具を呼ぶところで同じ形をあちこちで書いていた —
 * 起こす・出力を読み切る・中止 (AbortSignal) や時間切れで殺す・待つ。
 * ここに寄せて、**読み切る前に `exited` を待たない** (パイプが詰まって固まる) など
 * の決まりごとを1箇所で守る。
 *
 * - `signal` … 押されたら殺す (エンコードの中止など)
 * - `timeoutMs` … これを過ぎたら殺す (壊れたファイルで居座らせない)
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
         * 標準出力を溜めずに、来たそばから渡す。録画1本ぶんの生の絵のように
         * 溜めると収まらないもの向け (`stdout` より優先。そのとき `stdout` は空で返る)
         */
        onStdout?: (chunk: Uint8Array) => void;
        /**
         * 標準エラーを溜めずに1行ずつ渡す。コマごとに1行出させるもの (CM検出の `scdet`) 向け。
         * `stderr` より優先し、返る `stderr` は末尾の数行だけ (落ちた理由を読むため)
         */
        onStderrLine?: (line: string) => void;
    } = {},
): Promise<RunResult> {
    /*
     * **もう押されている合図は、起こす前に見る。** `abort` の聞き耳は押された
     * *瞬間*にしか鳴らないので、押された後に起こした道具には届かず、最後まで
     * 走り切っていた — 中止を押したあとに CM検出が無音検出へ落ち、字幕まで
     * 絵にしてから畳んでいたのはこれ。殺されたときと同じ顔 (143 = SIGTERM) で返す
     */
    if (options.signal?.aborted === true) {
        return { code: 143, stdout: new Uint8Array(), stderr: '中止されました' };
    }
    let proc: Bun.Subprocess<'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'>;
    try {
        proc = Bun.spawn(argv, {
            stdin: 'ignore',
            stdout: options.stdout === true || options.onStdout !== undefined ? 'pipe' : 'ignore',
            stderr: options.stderr === true || options.onStderrLine !== undefined ? 'pipe' : 'ignore',
        });
    } catch (error) {
        return { code: 127, stdout: new Uint8Array(), stderr: String(error) };
    }
    const kill = () => proc.kill();
    options.signal?.addEventListener('abort', kill, { once: true });
    const timer = options.timeoutMs === undefined ? null : setTimeout(kill, options.timeoutMs);
    try {
        const { onStdout, onStderrLine } = options;
        const readStderr = async (): Promise<string> => {
            if (onStderrLine === undefined) {
                return options.stderr === true ? text(proc.stderr as ReadableStream<Uint8Array>) : '';
            }
            const tail: string[] = [];
            try {
                for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
                    onStderrLine(line);
                    tail.push(line);
                    if (tail.length > STDERR_TAIL) tail.shift();
                }
            } catch (error) {
                kill();
                throw error;
            }
            return tail.join('\n');
        };
        const [stdout, stderr] = await Promise.all([
            onStdout !== undefined
                ? (async () => {
                      try {
                          for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>))
                              onStdout(chunk);
                      } catch (error) {
                          // 受け手が投げたら誰も読まなくなる。詰まって居座らないよう止めてから投げ直す
                          kill();
                          throw error;
                      }
                      return new Uint8Array();
                  })()
                : options.stdout === true
                  ? /*
                     * **`.bytes()` は使わない。** Bun 1.3.14 は 1MB を境に返すものが
                     * 変わる — それ未満は Uint8Array、それ以上は **ArrayBuffer**
                     * (`.length` が `undefined` になる)。型は Uint8Array のままなので
                     * 型検査では気付けず、`String(out.length)` が "undefined" になって
                     * `Content-Length: undefined` を送り、**本文が丸ごと落ちていた**
                     * (6.4MB の字幕を持つ録画で字幕が出ない)。
                     * `arrayBuffer()` は版によらず ArrayBuffer なので、自分で包む
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
        options.signal?.removeEventListener('abort', kill);
    }
}

/**
 * **ffmpeg の出口をそのまま応答の本文にする** (音声だけ・詰め替え。`stdout` に流させる)。
 *
 * - 読まれたぶんしか取りに行かない (`pull`)。相手が読まなければ出口が詰まり、ffmpeg も止まる
 * - 閉じられたら (`cancel`) ffmpeg を殺す
 * - **途中で落ちたら、ログに残して本文もエラーで終える。** 200 のまま静かに閉じると、
 *   受け手は最後まで届いたと思い、どこで何が起きたのかも残らなかった (レビュー指摘)
 *
 * `-loglevel error` で起こすこと。出るのは失敗の理由だけで、それをログへ回す
 *
 * @param what ログの頭 (`[audio] 音声だけの取り出し …`)
 */
export function ffmpegBody(argv: string[], what: string): ReadableStream<Uint8Array> {
    const ffmpeg = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stderr = new Response(ffmpeg.stderr).text().catch(() => '');
    let canceled = false;
    const reader = ffmpeg.stdout.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (!done) {
                controller.enqueue(value);
                return;
            }
            const code = await ffmpeg.exited;
            // 受け手が閉じたあとは、もう閉じてある (二度閉じると投げる)
            if (canceled) return;
            if (code === 0) {
                controller.close();
                return;
            }
            const why = (await stderr).trim().split('\n').slice(-3).join(' / ');
            console.warn(`${what}が止まりました (${code}): ${why}`);
            controller.error(new Error(`ffmpeg exited with ${code}`));
        },
        cancel() {
            canceled = true;
            ffmpeg.kill();
        },
    });
}
