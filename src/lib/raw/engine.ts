/**
 * **生で送られてきた TS を見せる**、画面の側の半分 (docs/stream.md §5.5)。
 *
 * 解いて描くのは worker (`worker.ts`)。ここが持つのは、Web Audio でしか触れない
 * **音を鳴らすことと、時計** (`playout.ts`)。時計はいま鳴っている音の PTS で、
 * それを worker へ流して絵を合わせさせる。
 *
 * `live-player.svelte.ts` からは、MSE の代わりにこれを使う — 器 (`<video>`) の代わりに
 * canvas を1枚、映像の入れ物の中に差し込む。字幕・データ放送・操作列は焼く道と同じもの
 * がそのまま重なる。
 */

import type { AudioSide } from '$lib/arib';
import { unwrap } from '$lib/ts/pes';
import type { FromWorker, ToWorker } from './messages';
import { type Chunk, Playout, type Scheduled } from './playout';

/** 90kHz */
const CLOCK = 90_000;
/** 刻み (ms)。音の予約と時計の配り直しをここで回す */
const TICK = 20;
/** 絵は出ているのに音が来ないまま、これだけたったら諦める (ms) */
const NO_AUDIO = 5_000;
/** 復号器の置き場 (`routes/api/live/mpeg2`) */
const DECODER = '/api/live/mpeg2';

interface AudioChunk extends Chunk {
    sampleRate: number;
    planes: Float32Array[];
}

export interface RawEvents {
    /** 選局し直してから最初の絵が出た */
    shown(): void;
    /** 貯めを使い切って止まった (焼く道の `waiting` にあたる) */
    stalled(): void;
    /** **使えなくなった。焼いたものに戻す** (理由は画面に出す) */
    gaveUp(reason: string): void;
}

export class RawEngine {
    readonly canvas: HTMLCanvasElement;
    private readonly worker: Worker;
    private readonly context: AudioContext;
    private readonly gain: GainNode;
    private readonly playout: Playout<AudioChunk>;
    private readonly nodes = new Set<AudioBufferSourceNode>();
    private readonly timer: ReturnType<typeof setInterval>;
    /** 壁時計を時計にしているか。**音を鳴らせない間 (自動再生を断られた) はこちら** */
    private wall: boolean;
    /** 選局し直してから音が来たか。来ないまま絵だけ出ているなら諦める (`NO_AUDIO`) */
    private heardAt = 0;
    private shownAt = 0;
    /** 解けた音のコマ数 (選局からの通しではなく、器を作ってからの通し) */
    private heard = 0;
    private gone = false;
    /** デュアルモノのどちらを両耳へ配るか (`AudioTrack.side`) */
    private side: AudioSide = 'both';
    /** 最後に知った PTS。字幕や時計の知らせを伸ばすのに使う (`unwrap`) */
    private near: number | null = null;
    /** 描かれずに捨てたコマ (worker が数える) */
    dropped = 0;
    /** 1コマを解く時間の 95 パーセンタイル (ms) */
    decodeMs = 0;

    /**
     * @param host 映像の入れ物。canvas はここに入る (**データ放送が入れ物ごと動かす**ので中に置く)
     * @param before この前に差し込む (字幕の canvas より下に来るように)
     */
    constructor(
        host: HTMLElement,
        before: Element | null,
        target: number,
        private readonly events: RawEvents,
    ) {
        this.playout = new Playout(target);
        this.canvas = document.createElement('canvas');
        this.canvas.setAttribute('data-testid', 'live-raw');
        this.canvas.setAttribute('aria-hidden', 'true');
        // 押すのは下の <video> (押し口がそこに付いている。`MediaStack`)
        this.canvas.style.cssText =
            'position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; pointer-events:none;';

        this.context = new AudioContext({ latencyHint: 'playback' });
        this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
        this.wall = this.context.state !== 'running';
        // 押される前でも鳴らせることがある (前に押したことのあるサイト)。駄目なら押すまで壁時計
        void this.context.resume().catch(() => undefined);
        this.context.onstatechange = () => this.follow();

        this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
        this.worker.onerror = () => this.giveUp('MPEG-2 の復号器が止まりました');
        const offscreen = this.canvas.transferControlToOffscreen();
        this.send({ type: 'init', canvas: offscreen, decoder: DECODER }, [offscreen]);

        this.timer = setInterval(() => this.tick(), TICK);
        // 差し込むのは最後。途中で転んだら (呼ぶ側が焼いたものに戻す) 何も残さない
        host.insertBefore(this.canvas, before);
    }

    /** どれだけ貯めるか (秒)。**決めるのは焼く道と同じ `pacing.nextTarget`** (live-player) */
    set target(seconds: number) {
        this.playout.target = seconds;
    }

    /** 音を鳴らせていないか (自動再生を断られた)。**押して `unmute` してもらう** */
    get blocked(): boolean {
        return this.context.state !== 'running';
    }

    /** 届いた TS を渡す。**写さずに worker へ移す** (1局 15Mbit/s ぶんを毎秒写さない) */
    feed(buffer: ArrayBuffer, offset: number): void {
        this.send({ type: 'data', buffer, offset }, [buffer]);
    }

    /** 選局し直した。**前の局の音も絵の待ちも捨てる** (いま出ている絵は、次が出るまで残る) */
    reset(): void {
        this.stopAll();
        this.playout.reset();
        this.near = null;
        this.heardAt = 0;
        this.shownAt = 0;
        this.send({ type: 'reset' });
    }

    /**
     * 音声を選ぶ。**焼き直しにならない** — 生の TS には全部の音声が入っているので、
     * どれを解くか (worker) と、デュアルモノのどちら側を両耳へ配るか (ここ) を変えるだけ
     */
    selectAudio(stream: number, side: AudioSide): void {
        this.side = side;
        this.send({ type: 'audio', index: stream });
    }

    /** 止める。**再開は放送の今から** (生では遡れるだけ持っていない。stream.md §5.5) */
    pause(): void {
        this.playout.hold();
        this.stopAll();
        this.tellClock();
    }

    resume(): void {
        this.playout.resume();
    }

    mute(): void {
        this.gain.gain.value = 0;
    }

    /** 音を出す。**押されて呼ばれる** — 自動再生で断られていても、ここなら鳴らせる */
    unmute(): void {
        this.gain.gain.value = 1;
        void this.context.resume().catch(() => undefined);
    }

    /** いま出している PTS (秒、伸ばしたもの)。**鳴らしていなければ null** */
    get position(): number | null {
        const at = this.clock();
        return at === null ? null : at.pts / CLOCK;
    }

    /** 手元にあと何秒ぶん持っているか (焼く道の `buffered.end - currentTime`) */
    get lead(): number {
        return this.playout.lead(this.now());
    }

    get playing(): boolean {
        return this.playout.playing;
    }

    /** 放送の PTS (90kHz、一周の中) を、いま出しているものの近くへ伸ばす。**字幕と時計の知らせ用** */
    unwrap(pts: number): number {
        return this.near === null ? pts : unwrap(pts, this.near);
    }

    destroy(): void {
        if (this.gone) return;
        this.gone = true;
        clearInterval(this.timer);
        this.stopAll();
        this.worker.terminate();
        void this.context.close().catch(() => undefined);
        this.canvas.remove();
    }

    private send(message: ToWorker, transfer: Transferable[] = []): void {
        if (!this.gone) this.worker.postMessage(message, transfer);
    }

    private giveUp(reason: string): void {
        if (this.gone) return;
        this.events.gaveUp(reason);
    }

    private receive(message: FromWorker): void {
        switch (message.type) {
            case 'audio': {
                if (this.heardAt === 0) this.heardAt = Date.now();
                this.heard++;
                const chunk: AudioChunk = message;
                this.near = message.pts;
                const scheduled = this.playout.push(chunk, this.now());
                if (scheduled !== null) this.play(scheduled);
                break;
            }
            case 'shown':
                this.shownAt = Date.now();
                this.events.shown();
                break;
            case 'stats':
                this.dropped = message.dropped;
                this.decodeMs = message.p95;
                /*
                 * **外から読める形で出しておく。** 絵は worker の canvas に居て、画面の側からは
                 * 画素を読めない。描いたコマ数と解けた音のコマ数が進んでいれば、生の道は動いている
                 * (E2E が見る。手元で切り分けるときも DevTools で読める)
                 */
                this.canvas.dataset['shown'] = String(message.shown);
                this.canvas.dataset['audio'] = String(this.heard);
                break;
            case 'fail':
                this.giveUp(message.reason);
                break;
        }
    }

    /** 時計の秒。**音が鳴っていれば音の時間、鳴らせなければ壁時計** */
    private now(): number {
        return this.wall ? performance.now() / 1000 : this.context.currentTime;
    }

    /**
     * いま耳に届いている PTS と、それが届いた時刻 (performance の ms)。
     * **音の時間は「いま予約している位置」なので、出口までの遅れを引く** (`getOutputTimestamp`)
     */
    private clock(): { pts: number; at: number } | null {
        if (this.wall) {
            const at = performance.now();
            const pts = this.playout.position(at / 1000);
            return pts === null ? null : { pts, at };
        }
        const stamp = this.context.getOutputTimestamp();
        const contextTime = stamp.contextTime ?? 0;
        if (contextTime > 0 && stamp.performanceTime !== undefined) {
            const pts = this.playout.position(contextTime);
            return pts === null ? null : { pts, at: stamp.performanceTime };
        }
        const latency = this.context.outputLatency || this.context.baseLatency || 0;
        const pts = this.playout.position(this.context.currentTime - latency);
        return pts === null ? null : { pts, at: performance.now() };
    }

    private tellClock(): void {
        const at = this.clock();
        this.send(
            at === null
                ? { type: 'clock', pts: null, at: 0 }
                : { type: 'clock', pts: at.pts, at: performance.timeOrigin + at.at },
        );
    }

    private tick(): void {
        const decided = this.playout.tick(this.now());
        if (decided.kind === 'start') {
            for (const scheduled of decided.schedule) this.play(scheduled);
        } else if (decided.kind === 'stall') {
            this.stopAll();
            this.events.stalled();
        } else if (decided.kind === 'jump') {
            this.stopAll();
            for (const scheduled of decided.schedule) this.play(scheduled);
        }
        this.tellClock();
        // 絵は出ているのに音が来ない。**音の出ない生より、焼いたもののほうがいい**
        if (this.shownAt > 0 && this.heardAt === 0 && Date.now() - this.shownAt > NO_AUDIO) {
            this.giveUp('音声を解けないので、焼いたものに戻しました');
        }
    }

    /**
     * 時計を替える。**鳴っている位置はそのまま。** 自動再生の許しが出たら音へ、音が止められたら
     * (出口が外れた・OS に止められた) 壁時計へ — 止まった音の時計に絵まで付いて止まらないように
     */
    private follow(): void {
        const wall = this.context.state !== 'running';
        if (this.gone || wall === this.wall) return;
        const position = this.playout.position(this.now());
        this.wall = wall;
        if (wall) this.stopAll();
        if (position === null) return;
        for (const scheduled of this.playout.rebase(position, this.now())) this.play(scheduled);
    }

    private play(scheduled: Scheduled<AudioChunk>): void {
        if (this.wall) return;
        const { chunk } = scheduled;
        const frames = chunk.planes[0]?.length ?? 0;
        if (frames === 0) return;
        const buffer = this.context.createBuffer(2, frames, chunk.sampleRate);
        /*
         * **デュアルモノは片側を両耳へ** (焼く道の `pan` と同じ)。
         *
         * 5.1ch の番組は**頭の2本だけ**鳴らす — ちゃんと下げる (中央と後ろを混ぜる) には
         * AudioDecoder が面をどの順で返すかを知る必要があり、ブラウザごとに実機で
         * 確かめていない (stream.md §5.5「実機で確かめること」)
         */
        const left = chunk.planes[0]!;
        const right = chunk.planes[1] ?? left;
        const [l, r] =
            this.side === 'main' ? [left, left] : this.side === 'sub' ? [right, right] : [left, right];
        buffer.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
        buffer.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
        const node = this.context.createBufferSource();
        node.buffer = buffer;
        node.connect(this.gain);
        node.onended = () => this.nodes.delete(node);
        node.start(scheduled.when, scheduled.offset);
        this.nodes.add(node);
    }

    private stopAll(): void {
        for (const node of this.nodes) {
            try {
                node.stop();
            } catch {
                // まだ始まっていない・もう終わっている
            }
        }
        this.nodes.clear();
    }
}
