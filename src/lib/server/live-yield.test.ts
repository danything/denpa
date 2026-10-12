import { describe, expect, test } from 'bun:test';
import type { YieldedRecording } from '#lib/live.js';
import { recordingOn, tunerOf, yieldedTo } from './live-yield';

/** 一覧の1本。読むところ (`index` `channel` `users`) だけ */
const tuner = (index: number, channel: string | null, ...uses: string[]) => ({
    index,
    channel: channel === null ? null : { type: 'GR' as const, channel },
    users: uses.map((use) => ({ use, priority: use.startsWith('rec ') ? 10 : 9 })),
});

const found = (id: number): YieldedRecording => ({ id, title: `録画${id}`, serviceName: '局', endAt: 1 });
const noWait = () => Promise.resolve();

describe('ライブが譲った録画を名指しする', () => {
    test('掴めたら、自分の読み手がいる本を覚える', () => {
        const tuners = [tuner(0, 'T16', 'epg T16'), tuner(1, 'T21', 'rec 3', 'live GR/T21')];
        expect(tunerOf(tuners, 'GR', 'T21', 'live GR/T21')).toBe(1);
        // 同じチャンネルでも読み手が違えば別 (番組表集めだけの本は自分の本ではない)
        expect(tunerOf(tuners, 'GR', 'T16', 'live GR/T16')).toBeNull();
    });

    test('蹴られたら、覚えた本にいる録画が相手', () => {
        // ライブの読み手は消え、録画が別のチャンネルで入っている
        const after = [tuner(0, 'T16', 'epg T16'), tuner(1, 'T27', 'rec 42')];
        expect(recordingOn(after, 1)).toBe(42);
        // 録画の居ない本・知らない本なら分からない
        expect(recordingOn(after, 0)).toBeNull();
        expect(recordingOn(after, 7)).toBeNull();
    });

    test('録画の読み手が載るのが遅れても、少し待って読み直す', async () => {
        const lists = [[tuner(1, null)], [tuner(1, 'T27', 'rec 42')]];
        let asked = 0;
        const recording = await yieldedTo(
            1,
            () => Promise.resolve(lists[Math.min(asked++, lists.length - 1)]!),
            found,
            noWait,
        );
        expect(recording?.id).toBe(42);
        expect(asked).toBe(2);
    });

    test('録画以外に外された・本を覚えていないなら null (画面は頼み直すだけ)', async () => {
        let asked = 0;
        const list = () => {
            asked++;
            return Promise.resolve([tuner(1, 'T16', 'epg T16')]);
        };
        expect(await yieldedTo(1, list, found, noWait)).toBeNull();
        // いつまでも待たない
        expect(asked).toBeLessThanOrEqual(5);
        expect(await yieldedTo(null, list, found, noWait)).toBeNull();
    });

    test('エージェントに訊けない間は読み直す', async () => {
        let asked = 0;
        const list = () => {
            asked++;
            return asked === 1
                ? Promise.reject(new Error('エージェントに繋がらない'))
                : Promise.resolve([tuner(1, 'T27', 'rec 5')]);
        };
        expect((await yieldedTo(1, list, found, noWait))?.id).toBe(5);
    });

    test('消された録画は名指ししない', async () => {
        const list = () => Promise.resolve([tuner(1, 'T27', 'rec 5')]);
        expect(await yieldedTo(1, list, () => null, noWait)).toBeNull();
    });
});
