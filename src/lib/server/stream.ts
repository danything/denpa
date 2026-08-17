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
 * ffmpeg / ffprobe / CM検出の道具を呼ぶところで同じ形を 9 箇所書いていた —
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
    options: { signal?: AbortSignal; timeoutMs?: number; stdout?: boolean; stderr?: boolean } = {},
): Promise<RunResult> {
    let proc: Bun.Subprocess<'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'>;
    try {
        proc = Bun.spawn(argv, {
            stdin: 'ignore',
            stdout: options.stdout === true ? 'pipe' : 'ignore',
            stderr: options.stderr === true ? 'pipe' : 'ignore',
        });
    } catch (error) {
        return { code: 127, stdout: new Uint8Array(), stderr: String(error) };
    }
    const kill = () => proc.kill();
    options.signal?.addEventListener('abort', kill, { once: true });
    const timer = options.timeoutMs === undefined ? null : setTimeout(kill, options.timeoutMs);
    try {
        const [stdout, stderr] = await Promise.all([
            options.stdout === true
                ? new Response(proc.stdout as ReadableStream<Uint8Array>).bytes()
                : Promise.resolve(new Uint8Array()),
            options.stderr === true ? text(proc.stderr as ReadableStream<Uint8Array>) : Promise.resolve(''),
        ]);
        const code = await proc.exited;
        return { code, stdout, stderr };
    } finally {
        if (timer !== null) clearTimeout(timer);
        options.signal?.removeEventListener('abort', kill);
    }
}
