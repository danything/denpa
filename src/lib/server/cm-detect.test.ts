import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CM検出の流れ (`cm.detectCm`) を、偽 ffmpeg (`tests/fake/ffmpeg.sh`) で通す。
 * 偽 ffmpeg は 300 秒と 360 秒に 1 秒の無音を返し、尺 (`Duration:`) は 600 秒。ffprobe は無い
 */
const root = mkdtempSync(join(tmpdir(), 'denpa-cm-'));
const { config } = await import('./config');
config.dbPath = join(root, 'denpa.db');
config.cmLogoDir = join(root, 'logos');
config.ffmpeg = 'tests/fake/ffmpeg.sh';
config.ffprobe = join(root, 'no-ffprobe');

const { detectCm } = await import('./cm');
const { logoUnusable } = await import('../format');

describe('CM検出の流れ', () => {
    test('ロゴが使えなければ、同じ材料から尺だけで決め直し、理由を残す', async () => {
        const found = await detectCm(join(root, 'in.m2ts'), { serviceId: 1 });
        expect(found.cm).toEqual([{ start: 300, end: 360 }]);
        // 絵の大きさが測れない (ffprobe が無い) のでロゴは覚えられない
        expect(found.note).toContain('大きさが測れませんでした');
        expect(logoUnusable(found.note)).toBe(true);
    });
});
