import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { remuxPlayer } from './remux-player';
import type { MediaSourceClass } from './ts/media-source';

/*
 * MSE を真似た最小の器。中身の代わりに「この塊は何秒から何秒か」を Float64 2つで運ぶ。
 * 足す・捨てるは次の刻みで終わる (本物と同じく、その間は `updating`)
 */
type Range = [number, number];

class FakeSourceBuffer extends EventTarget {
    updating = false;
    mode = 'segments';
    ranges: Range[] = [];
    get buffered(): TimeRanges {
        const ranges = [...this.ranges].sort((a, b) => a[0] - b[0]);
        return {
            length: ranges.length,
            start: (i: number) => ranges[i]![0],
            end: (i: number) => ranges[i]![1],
        } as TimeRanges;
    }
    private later(change: () => void): void {
        this.updating = true;
        setTimeout(() => {
            change();
            this.updating = false;
            this.dispatchEvent(new Event('updateend'));
        }, 1);
    }
    appendBuffer(data: BufferSource): void {
        const [start, end] = new Float64Array((data as Uint8Array).slice().buffer);
        this.later(() => {
            const last = this.ranges.find((range) => Math.abs(range[1] - start!) < 0.01);
            if (last !== undefined) last[1] = end!;
            else this.ranges.push([start!, end!]);
        });
    }
    remove(start: number, end: number): void {
        this.later(() => {
            this.ranges = this.ranges
                .map(
                    ([a, b]): Range =>
                        a >= start && b <= end ? [0, 0] : a < end && a >= start ? [end, b] : [a, b],
                )
                .filter(([a, b]) => b > a);
        });
    }
    abort(): void {}
}

class FakeMediaSource extends EventTarget {
    static last: FakeMediaSource | null = null;
    readyState = 'open';
    duration = Number.NaN;
    buffer: FakeSourceBuffer | null = null;
    constructor() {
        super();
        FakeMediaSource.last = this;
        setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 1);
    }
    static isTypeSupported(): boolean {
        return true;
    }
    addSourceBuffer(): FakeSourceBuffer {
        this.buffer = new FakeSourceBuffer();
        return this.buffer;
    }
    endOfStream(): void {
        this.readyState = 'ended';
    }
}

class FakeVideo extends EventTarget {
    src = '';
    error = null;
    disableRemotePlayback = false;
    private at = 0;
    get currentTime(): number {
        return this.at;
    }
    set currentTime(value: number) {
        this.at = value;
        this.dispatchEvent(new Event('seeking'));
    }
}

/** 頼まれた位置から、2秒ずつの塊を `count` 個流す。`gate` が解けるまで2つ目から先を止められる */
let requests: string[] = [];
let gate: Promise<void> = Promise.resolve();
const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;

beforeEach(() => {
    requests = [];
    gate = Promise.resolve();
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        requests.push(url);
        const from = Number(new URL(url, 'http://x').searchParams.get('from'));
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (i > 0) await gate;
                if (init?.signal?.aborted || i >= 3) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(new Float64Array([from + i * 2, from + i * 2 + 2]).buffer));
                i++;
            },
        });
        return new Response(body);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
    URL.createObjectURL = realCreate;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function start(from = 100) {
    const video = new FakeVideo();
    const states: string[] = [];
    const player = remuxPlayer(
        video as unknown as HTMLVideoElement,
        { Source: FakeMediaSource as unknown as MediaSourceClass, managed: false },
        {
            url: (at, audio) => `remux?from=${at}&audio=${audio}`,
            codecs: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
            duration: 600,
            start: from,
            audio: 0,
            state: (state) => states.push(state),
        },
    );
    return { video, player, states, media: () => FakeMediaSource.last! };
}

describe('詰め替えの流し方 (remuxPlayer)', () => {
    test('尺を先に言い、続きの位置から頼んで、尻まで読んだら終わりを言う', async () => {
        const { video, media } = start(100);
        await settle();
        expect(media().duration).toBe(600);
        expect(video.currentTime).toBe(100);
        expect(requests).toEqual(['remux?from=100&audio=0']);
        expect(media().buffer?.ranges).toEqual([[100, 106]]);
        expect(media().readyState).toBe('ended');
    });

    test('溜まっている所・読んでいる流れの少し先へは頼み直さない。遠くへ跳べば頼み直して前を捨てる', async () => {
        const { video, media } = start(100);
        await settle();
        video.currentTime = 104;
        await settle();
        expect(requests).toHaveLength(1);
        video.currentTime = 300;
        await settle();
        expect(requests).toEqual(['remux?from=100&audio=0', 'remux?from=300&audio=0']);
        expect(media().buffer?.ranges).toEqual([[300, 306]]);
    });

    test('読んでいる最中に跳んでも、古い流れの残りは新しい流れに混ざらない', async () => {
        let open!: () => void;
        gate = new Promise((resolve) => {
            open = resolve;
        });
        const { video, media } = start(100);
        await settle();
        // 1つ目の塊だけ届いて、残りは止まっている
        expect(media().buffer?.ranges).toEqual([[100, 102]]);
        video.currentTime = 300;
        open();
        await settle();
        expect(media().buffer?.ranges).toEqual([[300, 306]]);
    });

    test('音声を選び直すと、いまの位置から頼み直す', async () => {
        const { video, player } = start(100);
        await settle();
        video.currentTime = 103;
        player.setAudio(1);
        await settle();
        expect(requests.at(-1)).toBe('remux?from=103&audio=1');
    });

    test('畳んだら読むのをやめる', async () => {
        const { video, player } = start(100);
        await settle();
        player.destroy();
        video.currentTime = 400;
        await settle();
        expect(requests).toHaveLength(1);
    });
});
