/// <reference lib="webworker" />
/**
 * **生で送られてきた TS を解いて描く** worker (docs/stream.md §5.5)。
 *
 *     TS ─→ PES (ts/pes.ts) ┬→ 映像: WASM の MPEG-2 復号器 (wasm/mpeg2) → WebGL2 (render.ts)
 *                           └→ 音声: ADTS → AudioDecoder → 画面へ (鳴らすのは画面)
 *
 * **時計は画面が持つ** (鳴っている音。`playout.ts`)。ここは届いた時計に合わせて、番が
 * 来たコマを出すだけ。
 *
 * ## 貯めるのは解く前
 *
 * 貯め (0.2秒〜) のぶんを解いた絵で持つと、1080 の絵は1枚 3MB あるので 1秒で 90MB になる。
 * **圧縮のまま持っておき、番の少し前 (`AHEAD`) に解く。** 解くのは実測で1コマ 10ms 前後
 * なので、0.3 秒前に始めれば間に合う。解けた絵は復号器の中で順番待ちさせる
 * (`dec_peek` / `dec_pop`)。
 *
 * ## 頭は I フレームから
 *
 * MPEG-2 は I フレームからしか解き始められない。選局の直後や飛ばしたあとは、I が来る
 * まで捨てる (放送の GOP は 0.5 秒)。前の絵を参照するコマを先に渡すと、復号器は灰色の
 * 絵を出してしまう。
 */

import { AdtsSplitter, type Pes, PesDemuxer, unwrap } from '$lib/ts/pes';
import { DecodeBudget } from './budget';
import type { FromWorker, ToWorker } from './messages';
import { YuvRenderer } from './render';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** 90kHz */
const CLOCK = 90_000;
/** 番のこれだけ前から解く (90kHz)。解くのは1コマ 10ms 前後 */
const AHEAD = 0.3 * CLOCK;
/** 解けた絵を待たせる上限。**これ以上は先に解かない** (1枚 3MB) */
const DECODED_MOST = 8;
/** 圧縮のまま持っておく上限 (90kHz)。止めている間に溜め込まない */
const PENDING_MOST = 8 * CLOCK;
/** これだけ遅れたら、解きながら追いつくのをやめて I フレームまで飛ぶ (90kHz) */
const BEHIND_MOST = 0.5 * CLOCK;
/** 1コマの長さの目安 (90kHz)。29.97 コマ。実際の間隔が分かればそれを使う */
const FRAME = 3003;
/** 音の復号が続けて転んだら諦める回数 */
const AUDIO_ERRORS_MOST = 20;

interface Decoder {
    _dec_open(): number;
    _dec_push(data: number, length: number, pts: number): number;
    _dec_count(): number;
    _dec_peek(): number;
    _dec_peek_pts(): number;
    _dec_pts_at(index: number): number;
    _dec_pop(): void;
    _dec_last_ms(): number;
    _malloc(size: number): number;
    _free(pointer: number): void;
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
}

interface Pending {
    pts: number;
    dts: number;
    data: Uint8Array;
    intra: boolean;
}

let decoder: Decoder | null = null;
let renderer: YuvRenderer | null = null;
let input = { pointer: 0, size: 0 };

let demuxer = new PesDemuxer();
const adts = new AdtsSplitter();
let audioIndex = 0;
/** 圧縮のまま待たせている映像 (解く順) */
let pending: Pending[] = [];
/** I フレームを見たか。**見るまでは渡さない** */
let started = false;
/** PTS を伸ばす手元の物差し (`unwrap`)。選局し直すと捨てる */
let near: number | null = null;
let clock: { pts: number; at: number } | null = null;
/** いま出しているコマ */
let current: { pts: number; interlaced: boolean; topFirst: boolean } | null = null;
/** 最後に描いたもの。**同じなら描き直さない** */
let drawn = { pts: Number.NaN, field: Number.NaN };
let frameTicks = FRAME;
let lastFramePts: number | null = null;
let shownSinceReset = false;
let failed = false;

let audio: AudioDecoder | null = null;
let audioConfig = '';
let audioErrors = 0;

const budget = new DecodeBudget();
let dropped = 0;
let shown = 0;
let statsAt = 0;

function post(message: FromWorker, transfer: Transferable[] = []): void {
    scope.postMessage(message, transfer);
}

function fail(reason: string): void {
    if (failed) return;
    failed = true;
    post({ type: 'fail', reason });
}

/** 伸ばした PTS にする (`pes.unwrap`)。映像と音声で同じ物差しを使う */
function extend(pts: number): number {
    const value = near === null ? pts : unwrap(pts, near);
    near = value;
    return value;
}

/** ES の中の最初の絵が I か (picture_start_code の後ろの picture_coding_type) */
function isIntra(data: Uint8Array): boolean {
    for (let i = 0; i + 5 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && data[i + 3] === 0) {
            return ((data[i + 5]! >> 3) & 0x07) === 1;
        }
    }
    return false;
}

function now(): number | null {
    if (clock === null) return null;
    return clock.pts + (performance.timeOrigin + performance.now() - clock.at) * (CLOCK / 1000);
}

function onVideo(pes: Pes): void {
    const intra = isIntra(pes.data);
    if (!started) {
        if (!intra) return;
        started = true;
    }
    const last = pending.at(-1);
    const pts = pes.pts === null ? (last?.pts ?? 0) + frameTicks : extend(pes.pts);
    const dts = pes.dts === null ? pts : extend(pes.dts);
    pending.push({ pts, dts, data: pes.data, intra });
    // 溜め込みすぎ (止めている・裏に回っている)。いちばん新しい I から持ち直す
    if (pending.length > 1 && pending.at(-1)!.dts - pending[0]!.dts > PENDING_MOST) {
        skipTo(Number.POSITIVE_INFINITY);
    }
}

/**
 * `target` より手前でいちばん新しい I フレームまで飛ぶ。**復号器も開き直す** —
 * 飛ばしたコマを参照する絵を出させないため
 */
function skipTo(target: number): void {
    let found = -1;
    for (let i = 0; i < pending.length; i++) {
        if (pending[i]!.dts > target) break;
        if (pending[i]!.intra) found = i;
    }
    if (found <= 0) return;
    pending = pending.slice(found);
    decoder?._dec_open();
}

function onAudio(pes: Pes): void {
    for (const frame of adts.feed(pes.data, pes.pts === null ? null : extend(pes.pts))) {
        const config = `${frame.sampleRate}/${frame.channels}`;
        if (audio === null || audio.state === 'closed' || config !== audioConfig) {
            if (audio !== null && audio.state !== 'closed') audio.close();
            audio = openAudio(frame.sampleRate, frame.channels);
            audioConfig = config;
        }
        if (audio === null) return;
        audio.decode(
            new EncodedAudioChunk({
                type: 'key',
                timestamp: (frame.pts * 1_000_000) / CLOCK,
                duration: (frame.duration * 1_000_000) / CLOCK,
                data: frame.data,
            }),
        );
    }
}

/**
 * 音の復号器を開く。**ADTS のまま渡す** (description を付けなければ ADTS として読む決まり)。
 * 転んだら (壊れたコマ) 次のコマで開き直す。続けて転ぶなら諦める
 */
function openAudio(sampleRate: number, channels: number): AudioDecoder | null {
    try {
        const decoder = new AudioDecoder({
            output: (data) => {
                audioErrors = 0;
                const planes: Float32Array[] = [];
                for (let i = 0; i < data.numberOfChannels; i++) {
                    const plane = new Float32Array(data.numberOfFrames);
                    data.copyTo(plane, { planeIndex: i, format: 'f32-planar' });
                    planes.push(plane);
                }
                post(
                    {
                        type: 'audio',
                        pts: Math.round((data.timestamp * CLOCK) / 1_000_000),
                        duration: (data.numberOfFrames / data.sampleRate) * CLOCK,
                        sampleRate: data.sampleRate,
                        planes,
                    },
                    planes.map((plane) => plane.buffer),
                );
                data.close();
            },
            error: () => {
                if (++audioErrors > AUDIO_ERRORS_MOST) fail('音声を解けませんでした');
            },
        });
        decoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels });
        return decoder;
    } catch {
        fail('音声を解けませんでした');
        return null;
    }
}

/** 1 PES ぶんを復号器へ。**WASM のメモリへ写してから渡す** */
function decode(item: Pending): void {
    if (decoder === null) return;
    if (item.data.length > input.size) {
        if (input.pointer !== 0) decoder._free(input.pointer);
        input = { pointer: decoder._malloc(item.data.length), size: item.data.length };
    }
    decoder.HEAPU8.set(item.data, input.pointer);
    decoder._dec_push(input.pointer, item.data.length, item.pts);
    budget.record(decoder._dec_last_ms());
}

/** いちばん古い解けた絵をテクスチャへ上げて、`current` にする */
function take(): void {
    if (decoder === null || renderer === null) return;
    const info = decoder._dec_peek() >> 2;
    if (info === 0) return;
    const heap = decoder.HEAP32;
    const bytes = decoder.HEAPU8;
    const width = heap[info]!;
    const height = heap[info + 1]!;
    const strides: [number, number, number] = [heap[info + 2]!, heap[info + 3]!, heap[info + 4]!];
    const chromaRows = (height + 1) >> 1;
    const plane = (i: number, rows: number) =>
        bytes.subarray(heap[info + 5 + i]!, heap[info + 5 + i]! + strides[i]! * rows);
    const flags = heap[info + 8]!;
    const sarNum = heap[info + 9]!;
    const sarDen = heap[info + 10]!;
    // 縦横比が分からなければ 16:9 とみなす (日本の HD 放送はどれもそう)
    const displayWidth =
        sarNum > 0 && sarDen > 0 ? Math.round((width * sarNum) / sarDen) : Math.round((height * 16) / 9);
    renderer.upload(
        {
            width,
            height,
            strides,
            data: [plane(0, height), plane(1, chromaRows), plane(2, chromaRows)],
            colorspace: heap[info + 11]!,
        },
        displayWidth,
    );
    const pts = decoder._dec_peek_pts();
    if (lastFramePts !== null) {
        const gap = pts - lastFramePts;
        // 1コマの長さを実際の間隔から知る (59.94p の局・3:2 のフィルム)
        if (gap > 0 && gap < 3 * FRAME) frameTicks = gap;
    }
    lastFramePts = pts;
    current = { pts, interlaced: (flags & 1) !== 0, topFirst: (flags & 2) !== 0 };
    decoder._dec_pop();
}

function draw(field: number): void {
    if (renderer === null || current === null) return;
    if (drawn.pts === current.pts && drawn.field === field) return;
    renderer.draw(field);
    drawn = { pts: current.pts, field };
    shown++;
    if (!shownSinceReset) {
        shownSinceReset = true;
        post({ type: 'shown' });
    }
}

/** 刻むたびに: 番の近いものを解き、番が来たコマを出す */
function tick(): void {
    if (decoder === null || failed) return;
    schedule();
    const at = now();

    if (at === null) {
        // 止まっている (貯めている)。**新しい局の1枚目だけは出して待つ** — 前の局の絵のまま
        // 新しい局の音を待たせると、見えているものと聞こえるものが食い違う
        if (!shownSinceReset) {
            while (decoder._dec_count() === 0 && pending.length > 0) decode(pending.shift() as Pending);
            if (decoder._dec_count() > 0) {
                take();
                draw(current?.interlaced === true ? (current.topFirst ? 0 : 1) : -1);
            }
        }
        return;
    }

    // 大きく遅れている (裏から戻った・止めていた)。解きながら追うより I まで飛ぶ
    const head = pending[0];
    if (head !== undefined && head.dts < at - BEHIND_MOST) skipTo(at);

    /*
     * **1回に解くのは1枚まで** (遅れているときだけ3枚まで)。1枚 10〜20ms かかるので、
     * まとめて解くとその間コマを出せず、番を過ぎて捨てるコマが増える
     */
    for (let i = 0; i < 3 && pending.length > 0 && decoder._dec_count() < DECODED_MOST; i++) {
        const next = pending[0]!;
        if (next.dts > at + AHEAD || (i > 0 && next.dts > at)) break;
        decode(pending.shift() as Pending);
    }

    // 次の絵がもう番を迎えているなら、手前の絵は上げずに捨てる
    while (decoder._dec_count() >= 2 && decoder._dec_pts_at(1) <= at) {
        decoder._dec_pop();
        dropped++;
    }
    if (decoder._dec_count() >= 1 && decoder._dec_pts_at(0) <= at) take();

    if (current !== null) {
        const second = current.interlaced && at >= current.pts + frameTicks / 2;
        const field = !current.interlaced ? -1 : current.topFirst !== second ? 0 : 1;
        draw(field);
    }

    // 絵が時計からどれだけ遅れているか。**解けた絵が無いまま番を過ぎている**ぶん
    const late =
        current === null || decoder._dec_count() > 0
            ? 0
            : Math.max(0, (at - current.pts - frameTicks) / CLOCK);
    const wall = performance.now();
    if (budget.tick(wall, (frameTicks / CLOCK) * 1000, late)) {
        fail('この端末では MPEG-2 を解くのが間に合わないので、焼いたものに戻しました');
    }
    if (wall - statsAt >= 1000) {
        statsAt = wall;
        post({ type: 'stats', dropped, p95: budget.p95, shown });
    }
}

let scheduled = false;
function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    const next = () => {
        scheduled = false;
        tick();
    };
    /*
     * **rAF ではなく細かい時計で刻む。** worker の rAF は描いたものが画面に出る速さに
     * 引っ張られ、実機の録画 (1080i) をヘッドレスで流すと毎秒 6 回しか来なかった — 1回に
     * 何枚も解くことになり、コマを出す番を逃し続ける。4ms ごとに1枚ずつ解いて、番が来た
     * コマを出す (描いたものはその回の終わりに画面へ渡る)
     */
    setTimeout(next, 4);
}

function reset(): void {
    demuxer = new PesDemuxer();
    demuxer.audioIndex = audioIndex;
    adts.reset();
    pending = [];
    started = false;
    near = null;
    clock = null;
    current = null;
    drawn = { pts: Number.NaN, field: Number.NaN };
    lastFramePts = null;
    shownSinceReset = false;
    budget.reset();
    decoder?._dec_open();
    if (audio !== null && audio.state !== 'closed') audio.reset();
    audioConfig = '';
}

async function init(canvas: OffscreenCanvas, base: string): Promise<void> {
    try {
        renderer = new YuvRenderer(canvas);
    } catch (error) {
        fail(`描けません (${error instanceof Error ? error.message : String(error)})`);
        return;
    }
    try {
        const url = new URL(`${base}/decoder.mjs`, scope.location.origin).href;
        const module = (await import(/* @vite-ignore */ url)) as {
            default: (options: object) => Promise<Decoder>;
        };
        decoder = await module.default({
            locateFile: (name: string) => new URL(`${base}/${name}`, scope.location.origin).href,
        });
        if (decoder._dec_open() !== 0) throw new Error('開けません');
    } catch {
        fail('この denpa には MPEG-2 の復号器が入っていません');
        return;
    }
    schedule();
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
    const message = event.data;
    switch (message.type) {
        case 'init':
            void init(message.canvas, message.decoder);
            break;
        case 'data': {
            if (failed) return;
            const { pes, changed } = demuxer.feed(new Uint8Array(message.buffer, message.offset));
            if (changed) demuxer.selectAudio(audioIndex);
            for (const item of pes) {
                if (item.kind === 'video') onVideo(item);
                else onAudio(item);
            }
            break;
        }
        case 'clock':
            clock = message.pts === null ? null : { pts: message.pts, at: message.at };
            break;
        case 'reset':
            reset();
            break;
        case 'audio':
            audioIndex = message.index;
            demuxer.selectAudio(message.index);
            adts.reset();
            break;
    }
};
