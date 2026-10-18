import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Fmp4Splitter } from '#lib/ts/fmp4.js';
import { type Fmp4Host, Fmp4Video } from './fmp4';

/**
 * **追っかけで抱えきれなくなったとき** (`follow`)。圧縮のまま持つのが上限を超えたら、受け取るのを
 * やめて `full` を1回だけ返し、以降は捨てる。リクエストし直し (`reset` → 新しい init) で元に戻る。
 *
 * 映像はデコードさせない (刻まないので VideoDecoder に渡らない)。VideoDecoder と 2D のコンテキストは形だけの偽物。
 * 流すのは E2E と同じ作り置き (本物の ffmpeg が書いた AV1 + Opus。`tests/fake/fmp4-loop.ts`)
 */

class FakeDecoder {
    state = 'unconfigured';
    decodeQueueSize = 0;
    configure(): void {
        this.state = 'configured';
    }
    reset(): void {
        this.state = 'unconfigured';
    }
    close(): void {
        this.state = 'closed';
    }
    decode(): void {}
}

const globals = globalThis as { VideoDecoder?: unknown };
let saved: unknown;
beforeAll(() => {
    saved = globals.VideoDecoder;
    globals.VideoDecoder = FakeDecoder;
});
afterAll(() => {
    globals.VideoDecoder = saved;
});

const file = new Uint8Array(readFileSync(new URL('../../../tests/fake/live-av1.mp4', import.meta.url)));
const segments = new Fmp4Splitter().feed(file);
const init = segments.find((s) => s.kind === 'init')!.data;
const media = segments.filter((s) => s.kind === 'media').map((s) => s.data);

function watcher(follow: boolean) {
    const seen = { full: 0, sounds: 0, failed: [] as string[] };
    const host: Fmp4Host = {
        audio: {
            open: () => true,
            push: () => {
                seen.sounds++;
            },
        },
        drew: () => {},
        fail: (reason) => seen.failed.push(reason),
        record: () => {},
        full: () => {
            seen.full++;
        },
    };
    const canvas = { getContext: () => ({}) } as unknown as OffscreenCanvas;
    return { video: new Fmp4Video(canvas, host, follow), seen };
}

/** 2秒ぶんを繰り返し流す (作り置きの時刻のまま。キーフレームから入り直すので、圧縮の待ちは積み増していく) */
function feedRounds(video: Fmp4Video, rounds: number): void {
    for (let i = 0; i < rounds; i++) for (const data of media) video.feed(data);
}

describe('Fmp4Video (追っかけで抱えきれないとき)', () => {
    test('上限を超えたら full を1回だけ返し、以降は音も映像も捨てる。リクエストし直せば戻る', () => {
        const { video, seen } = watcher(true);
        video.feed(init);
        // 作り置きは 2秒で 140KB ほど。120MB を超えるまで流す
        for (let round = 0; round < 2_000 && seen.full === 0; round++) feedRounds(video, 1);
        expect(seen.full).toBe(1);
        expect(seen.failed).toEqual([]);

        const sounds = seen.sounds;
        feedRounds(video, 3);
        expect(seen.full).toBe(1);
        expect(seen.sounds).toBe(sounds);

        // リクエストし直し: 選局し直しと同じく reset のあとに新しい init
        video.reset();
        video.feed(init);
        feedRounds(video, 1);
        expect(seen.sounds).toBeGreaterThan(sounds);
        expect(seen.full).toBe(1);
        video.close();
    });

    test('追っかけでなければ溢れを言わない (いちばん新しいキーフレームから持ち直す)', () => {
        const { video, seen } = watcher(false);
        video.feed(init);
        feedRounds(video, 50);
        expect(seen.full).toBe(0);
        video.close();
    });
});
