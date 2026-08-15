import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDevices, type HwDevice, hwChain } from './hwenc';

const A: HwDevice = { path: '/dev/dri/renderD128', label: 'A', qsv: ['h264', 'av1'], vaapi: ['h264', 'av1'] };
const B: HwDevice = { path: '/dev/dri/renderD129', label: 'B', qsv: ['h264'], vaapi: ['h264'] };

describe('GPU の道の選び方', () => {
    test('載っていない口は全部よい。同じ口の中では QSV → VA-API', () => {
        expect(hwChain('av1', {}, 0, [A, B])).toEqual([
            { device: A.path, kind: 'qsv' },
            { device: A.path, kind: 'vaapi' },
        ]);
    });

    test('口はジョブごとに回す。両方焼ける H.264 は先頭が入れ替わる', () => {
        const first = hwChain('h264', {}, 0, [A, B]).map((w) => w.device);
        const second = hwChain('h264', {}, 1, [A, B]).map((w) => w.device);
        expect(first).toEqual([A.path, A.path, B.path, B.path]);
        expect(second).toEqual([B.path, B.path, A.path, A.path]);
    });

    test('口ごとに外せる。A は AV1 だけ、B は H.264 だけ、のような割り振り', () => {
        const allow = {
            [A.path]: { qsv: ['av1' as const], vaapi: [] },
            [B.path]: { qsv: ['h264' as const], vaapi: ['h264' as const] },
        };
        expect(hwChain('h264', allow, 0, [A, B])).toEqual([
            { device: B.path, kind: 'qsv' },
            { device: B.path, kind: 'vaapi' },
        ]);
        expect(hwChain('av1', allow, 0, [A, B])).toEqual([{ device: A.path, kind: 'qsv' }]);
        // 使えないものは許しても出ない (B は AV1 を焼けない)
        expect(hwChain('av1', { [B.path]: { qsv: ['av1'], vaapi: ['av1'] } }, 0, [B])).toEqual([]);
    });

    test('口は最後の段の * で拾い、名前順', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dri-'));
        for (const name of ['renderD129', 'renderD128', 'card0']) writeFileSync(join(dir, name), '');
        expect(findDevices(`${dir}/renderD*`)).toEqual([`${dir}/renderD128`, `${dir}/renderD129`]);
        expect(findDevices('/nonexistent/renderD*')).toEqual([]);
    });
});
