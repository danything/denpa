import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CM検出の流れ (`cm.openCm` → 読む → `decide`) を、偽 ffmpeg (`tests/fake/ffmpeg.sh`) で通す。
 * 偽 ffmpeg は 300 秒と 360 秒に 1 秒の無音を返し、尺 (`Duration:`) は 600 秒。ffprobe は無い。
 * ふだんはエンコードに相乗りして読むが、ここでは同じ出口を `cm-scan.scan` で読む
 */
const root = mkdtempSync(join(tmpdir(), 'denpa-cm-'));
const { config } = await import('./config');
config.dbPath = join(root, 'denpa.db');
config.cmLogoDir = join(root, 'logos');
config.ffmpeg = 'tests/fake/ffmpeg.sh';
config.ffprobe = join(root, 'no-ffprobe');

const { openCm } = await import('./cm');
const { scan } = await import('./cm-scan');
const { logoUnusable } = await import('../format');

async function detect(at: { skip?: number; video?: boolean } = {}) {
    const input = join(root, 'in.m2ts');
    const reading = await openCm(input, { serviceId: 1 });
    const want = reading.want();
    const found = await scan(input, { ...want, video: at.video ?? want.video, timeoutMs: 10_000 });
    return reading.decide(found, { skip: at.skip ?? 0, before: [], ...(at.video === false ? { video: false } : {}) });
}

describe('CM検出の流れ', () => {
    test('ロゴが使えなければ、同じ材料から尺だけで決め直し、理由を残す', async () => {
        const found = await detect();
        expect(found.cm).toEqual([{ start: 300, end: 360 }]);
        expect(found.duration).toBe(600);
        // 絵の大きさが測れない (ffprobe が無い) のでロゴは覚えられない
        expect(found.note).toContain('大きさが測れませんでした');
        expect(logoUnusable(found.note)).toBe(true);
    });

    test('絵の読み込みが落ちて音だけ読み直したなら、尺だけで決めて理由を残す', async () => {
        const found = await detect({ video: false });
        expect(found.cm).toEqual([{ start: 300, end: 360 }]);
        expect(found.note).toContain('絵の読み込みが失敗');
        expect(logoUnusable(found.note)).toBe(true);
    });

    test('頭を捨てて焼いたなら、尺もそのぶん短い (時刻は焼いたものの物差し)', async () => {
        expect((await detect({ skip: 0.5 })).duration).toBe(599.5);
    });
});
