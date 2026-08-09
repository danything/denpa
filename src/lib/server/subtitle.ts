import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { SupWriter } from '../pgs';
import { cleanAss, cleanCues, parseAss } from '../ts/ass';
import { TrackList } from './captions';
import { config } from './config';
import { removeIfExists } from './fsx';
import { chunks, lines } from './stream';

/**
 * ARIB字幕を絵にして PGS (.sup) にする。**文字のままの写しも1本作る。**
 *
 * 放送に絵が流れてくるわけではない。乗っているのは文字と「どこに・どの大きさで・
 * 何色で・背景の箱つきで」という指定で、テレビはそれを見て毎回自分で描いている。
 * libaribcaption に同じように描かせたものが `-sub_type bitmap` で、
 * **それが「放送どおりの字幕の絵」**になる (外字もここでは絵として出る)。
 *
 * 絵を受け取る口は ffmpeg の sub2video。字幕をフィルタの入力にすると、
 * 1枚ごとに RGBA の映像フレームとして出てくる。時刻は showinfo に喋らせる。
 *
 * 入れる先を PGS にするのは、ffmpeg が作れるビットマップ字幕 (dvdsub/dvbsub/xsub)
 * ではどれも足りないため。dvdsub は1枚4色で、実測230色の字幕は文字・縁・箱で
 * 使い切ってしまう。PGS の符号器は ffmpeg に無いので denpa が書く (src/lib/pgs.ts)。
 *
 * ## 文字のままの写しも作る (`buildText`)
 *
 * 絵は放送どおりだが、**文字でないと困る相手がいる。** Kodi は動画の隣に置いた
 * 字幕を拾うので、そこに文字で置いておくと、入れ物の中の PGS と並べて選べる。
 * そこで同じ字幕を**文字でももう1本**取り出して `.ja.ass` として置く
 * ([ass.ts](../ts/ass.ts))。**入れ物の中は PGS のまま**で、文字は付き添い。
 *
 * **denpa の観る画面は絵のほうを使います** — ブラウザに PGS の復号器はないが、
 * denpa 自身が解けば済む (`api/recordings/<id>/captions.sup`)。
 *
 * 費用はほとんど無い。実機の30分番組で **2〜9秒** (エンコードは分単位)。
 * 取り出しを PGS と同じ ffmpeg に相乗りさせられないのは、`-sub_type` が
 * **復号のしかたの指定**だからで、絵と文字は別々に解かせるほかない。
 */

/** 最後の1枚をどれだけ出しておくか。ふつうは「消す」が来るので使わない */
const TAIL_SECONDS = 5;
/** 絵が1枚も無いのに延々と読み続けない。実時間の数十分の一で終わるはず */
const TIMEOUT = 30 * 60_000;

/** showinfo の1行から時刻と大きさを読む */
const PTS_TIME = /pts_time:\s*(-?[\d.]+)/;
const SIZE = /\ss:(\d+)x(\d+)/;

export interface PgsResult {
    path: string;
    captions: number;
    /**
     * 字幕トラックの名前。**放送が名乗っている言語まで入れる** (「字幕 (日本語)」)。
     *
     * ffmpeg が入口の見出しに書いたものから拾う (`TrackList`) — 番組表と同じ
     * 言い方になる。名乗っていなければ「字幕」だけ
     */
    label: string;
}

/**
 * 字幕を取り出す ffmpeg の引数。
 *
 * **時刻をそのまま (`-copyts`) 受け取る。** 付けないと ffmpeg は
 * **字幕1枚目を 0 秒**として数え直す。フィルタに入れるのが字幕1本だけなので、
 * 数え直す基準になる映像がこちら側に無いため。
 *
 * 一方エンコードは同じ TS を映像ごと通すので、**入れ物の始まり**を 0 とする。
 * 基準が食い違ったまま出来上がりへ詰めると、**字幕1枚目が出るまでの間**が
 * まるごと前へ寄る — 実機で、本編が始まる 10.4 秒前から字幕が出ていた
 * (最初の字幕は録画開始の 10.39 秒後。ズレはちょうどその値だった)。
 *
 * `-copyts` を付ければ放送の時刻がそのまま出るので、引く数はこちらで決められる。
 */
export function pgsArgs(input: string, canvasSize: string | undefined, fonts: string): string[] {
    return [
        '-hide_banner',
        '-nostats',
        '-y',
        // 時刻を数え直させない。何を引くかは呼ぶ側が決める (rebase)
        '-copyts',
        '-sub_type',
        'bitmap',
        ...(canvasSize === undefined ? [] : ['-canvas_size', canvasSize]),
        '-font',
        fonts,
        '-analyzeduration',
        '15000000',
        '-probesize',
        '30000000',
        '-i',
        input,
        // 字幕をフィルタに通すと1枚ずつ映像フレームになる (sub2video)。
        // 時刻と大きさは showinfo が標準エラーに書く
        '-filter_complex',
        '[0:s:0]showinfo[v]',
        '-map',
        '[v]',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
    ];
}

/**
 * 放送の時刻を、出来上がりの 0 秒から数えた時刻に直す。
 *
 * 引くのは**入れ物の始まり** (`probeVideo` の formatStart)。エンコードのほうも
 * ffmpeg が同じものを引くので、これで両者が同じ物差しに乗る。
 *
 * 読めなかったとき (NaN) は引かない。**そのときだけ以前と同じ**で、
 * 字幕は入るがズレる可能性がある — 何も入らないよりはましなため。
 * 頭より前の字幕は 0 に詰める (PGS の時刻は負を持てない)
 */
export function rebase(pts: number, startAt: number): number {
    if (!Number.isFinite(startAt)) return pts;
    return Math.max(0, pts - startAt);
}

/**
 * 字幕を絵で取り出して `.sup` を書く。字幕が無ければ null。
 *
 * 失敗しても録画とエンコードは止めない。**入る字幕はこれ1本だけ**なので、
 * null になった録画には字幕トラックが付かない。
 *
 * `startAt` は入れ物の始まり (PTS)。出来上がりと噛み合わせるために引く (rebase)。
 */
export async function buildPgs(
    input: string,
    canvasSize: string | undefined,
    fonts: string,
    startAt: number,
    signal?: AbortSignal,
): Promise<PgsResult | null> {
    const output = `${input}.sup`;
    const args = pgsArgs(input, canvasSize, fonts);

    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
        proc = Bun.spawn([config.ffmpeg, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    } catch {
        return null;
    }
    const kill = () => proc.kill();
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, TIMEOUT);

    const writer = new SupWriter();
    /** showinfo が喋った順に溜める。絵の来る順と同じ */
    const stamps: { at: number; width: number; height: number }[] = [];
    /*
     * **名前も同じ口から拾う。** 焼くほうは `0:s:0` を採るので、局を名指ししない
     * 一覧の1本目 (`TrackList(0)`) と同じものになる
     */
    const list = new TrackList(0);
    let read = 0;

    const readStderr = (async () => {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            list.feed(line);
            const time = line.match(PTS_TIME);
            const size = line.match(SIZE);
            if (time === null || size === null) continue;
            stamps.push({
                at: rebase(Number(time[1]), startAt),
                width: Number(size[1]),
                height: Number(size[2]),
            });
        }
    })();

    /*
     * 1枚ぶん溜まるたびに取り出す。**手元に置くのは1枚だけ**にする。
     * 終わりの時刻は次の枚が来て初めて決まるので前の1枚は持っておくが、
     * 全部溜めると 6MB × 枚数になり、長い番組で持ちきれない
     */
    const held: { frame: { data: Uint8Array; at: number } | null } = { frame: null };
    /*
     * 届いた切れ端はそのまま並べておき、1枚ぶん貯まったところで初めて繋ぐ。
     * 届くたびに繋ぎ直すと、1枚 6MB に対して切れ端が 64KB なので、
     * 1枚あたり数百MB ぶんの写し替えになる
     */
    const queue: Uint8Array[] = [];
    let queued = 0;
    let frame = 0;

    /** 先頭から size バイトだけ取り出す */
    const take = (size: number): Uint8Array => {
        const out = new Uint8Array(size);
        let at = 0;
        while (at < size) {
            const part = queue[0];
            const need = size - at;
            if (part.length <= need) {
                out.set(part, at);
                at += part.length;
                queue.shift();
                continue;
            }
            out.set(part.subarray(0, need), at);
            queue[0] = part.subarray(need);
            at += need;
        }
        queued -= size;
        return out;
    };

    const push = (chunk: Uint8Array) => {
        queue.push(chunk);
        queued += chunk.length;

        for (;;) {
            const stamp = stamps[frame];
            if (stamp === undefined) return;
            const size = stamp.width * stamp.height * 4;
            if (queued < size) return;

            const data = take(size);
            frame++;
            const previous = held.frame;
            if (previous !== null) {
                writer.add(
                    { width: stamp.width, height: stamp.height, data: previous.data },
                    previous.at,
                    stamp.at,
                );
            }
            held.frame = { data, at: stamp.at };
        }
    };

    try {
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            read += chunk.length;
            push(chunk);
        }
        await readStderr;
        await proc.exited;
        /*
         * 時刻が絵より遅れて届くことがある (別々の口から来るため)。
         * 最後にもう一度だけ突き合わせて、取りこぼした枚を拾う
         */
        push(new Uint8Array(0));
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
    }

    const last = stamps[frame - 1];
    const tail = held.frame;
    if (tail !== null && last !== undefined) {
        writer.add(
            { width: last.width, height: last.height, data: tail.data },
            tail.at,
            tail.at + TAIL_SECONDS,
        );
    }

    if (writer.captions === 0) {
        // 字幕の無い番組。読めた量だけ残しておくと、後から原因を追える
        if (read > 0) console.log(`[subtitle] 絵になる字幕がありませんでした (${input})`);
        return null;
    }

    try {
        writeFileSync(output, writer.bytes());
        statSync(output);
    } catch (error) {
        console.error(`[subtitle] .sup を書けませんでした: ${error}`);
        return null;
    }
    return { path: output, captions: writer.captions, label: list.tracks[0]?.label ?? '字幕' };
}

/**
 * 字幕を文字で取り出す ffmpeg の引数。
 *
 * **`-copyts` と `-output_ts_offset` を組にして使う。** 絵のほう (`pgsArgs`) と
 * 同じ理由で放送の時刻をそのまま受け取るが、こちらは引くのも ffmpeg にやらせる —
 * ASS の時刻は**10時間で頭打ち**になっていて、放送の絶対時刻 (実機で 46141 秒 =
 * 12時間49分) をそのまま書かせると全部 `9:59:59.99` に潰れるため。
 *
 * `-fix_sub_duration` は終わりの時刻を入れさせるもの。ARIB字幕は「消す」が
 * 別の指示で来るので、付けないと**全部が 9:59:59.99 まで出しっぱなし**になる。
 * ASS の1行1行は互いに独立で、後から来た「消す」では消えない
 */
export function textArgs(input: string, output: string, startAt: number): string[] {
    return [
        '-hide_banner',
        '-nostats',
        '-y',
        '-copyts',
        // 終わりの時刻は「次が来るまで」。付けないと出しっぱなしになる
        '-fix_sub_duration',
        // 文字として解かせる。絵 (bitmap) とは別の解き方なので、同じ ffmpeg には相乗りできない
        '-sub_type',
        'ass',
        '-analyzeduration',
        '15000000',
        '-probesize',
        '30000000',
        '-i',
        input,
        '-map',
        '0:s:0',
        // 焼き上がりの 0 秒に合わせる。絵のほうが引くのと同じ値 (`rebase`)
        '-output_ts_offset',
        String(-startAt),
        '-c:s',
        'ass',
        output,
    ];
}

export interface TextResult {
    /** 整えた ASS そのもの。置き場所は焼き上がりが決まってから決まる */
    content: string;
    captions: number;
}

/**
 * 字幕を文字で取り出す。字幕が無ければ null。
 *
 * **絵のほうと同じ `startAt` を渡すこと。** 同じ録画に絵と文字の2本が付くので、
 * 片方だけずれると見比べたときに食い違う。
 *
 * 落ちても録画とエンコードは止めない。文字の付き添いが1本減るだけで、
 * 入れ物の中の PGS には影響しない
 */
export async function buildText(
    input: string,
    startAt: number,
    signal?: AbortSignal,
): Promise<TextResult | null> {
    const output = `${input}.ass`;
    const base = Number.isFinite(startAt) ? startAt : 0;

    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
    try {
        proc = Bun.spawn([config.ffmpeg, ...textArgs(input, output, base)], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'pipe',
        });
    } catch {
        return null;
    }
    const kill = () => proc.kill();
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, TIMEOUT);

    try {
        // 読み捨てても、溜まって止まらないように流し切る
        await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
        await proc.exited;
        const raw = readFileSync(output, 'utf8');
        const ass = parseAss(raw);
        const content = cleanAss(ass);
        if (content === null) {
            // 字幕の無い番組。「消す」だけが並んで来る (実機: 18枚すべてが空)
            return null;
        }
        return { content, captions: cleanCues(ass.cues).length };
    } catch (error) {
        console.error(`[subtitle] 字幕を文字で取り出せませんでした: ${error}`);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        removeIfExists(output);
    }
}
