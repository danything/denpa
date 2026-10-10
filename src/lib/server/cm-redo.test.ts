import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

/**
 * **CM 検出だけやり直す** ジョブ (`encoder.runCmJob`)。偽 ffmpeg (`tests/fake/ffmpeg.sh`) で通す。
 * 偽 ffmpeg は 300 秒と 360 秒に 1 秒の無音を返す (尺 600 秒)。ffprobe は無い。
 * 生TSは持たせず、焼いたもの (mkv) から読ませる
 */
const root = mkdtempSync(join(tmpdir(), 'denpa-cmredo-'));
const { config } = await import('./config');
config.dbPath = join(root, 'denpa.db');
config.cmLogoDir = join(root, 'logos');
config.encodedDir = join(root, 'encoded');
config.ffmpeg = 'tests/fake/ffmpeg.sh';
config.ffprobe = join(root, 'no-ffprobe');
mkdirSync(config.encodedDir, { recursive: true });

const { orm } = await import('./db');
const { encodeJobs, recordings } = await import('./schema');
const { CM_CUT_ALREADY, enqueue, pump } = await import('./encoder');

const now = Date.now();
const mkv = join(config.encodedDir, 'a.mkv');
writeFileSync(mkv, 'mkv');

function seed(kept: { start: number; end: number }[] | null): void {
    orm().delete(recordings).run();
    orm().delete(encodeJobs).run();
    orm()
        .insert(recordings)
        .values({
            id: 1,
            service_id: 1,
            name: '番組',
            start_at: now,
            end_at: now + 600_000,
            library_path: mkv,
            cm_kept: kept,
            encode_skip: 0.5,
            created_at: now,
            updated_at: now,
        })
        .run();
}

async function finished(jobId: number) {
    for (;;) {
        const job = orm().select().from(encodeJobs).where(eq(encodeJobs.id, jobId)).get()!;
        if (job.state !== 'queued' && job.state !== 'running') return job;
        await Bun.sleep(50);
    }
}

test('焼いたものから読み直し、入れ物の頭からの秒で覚える (焼いたときに捨てた頭を足す)', async () => {
    seed(null);
    const jobId = enqueue(1, 'cm');
    pump();
    const job = await finished(jobId);
    expect(job.state).toBe('done');
    const rec = orm().select().from(recordings).where(eq(recordings.id, 1)).get()!;
    expect(rec.cm_ranges).toEqual([{ start: 300.5, end: 360.5 }]);
    // 焼いたものの置き場所は変わらない (焼き直していない)
    expect(rec.library_path).toBe(mkv);
});

test('CM を切って焼いたものは受けない', async () => {
    seed([{ start: 0, end: 300 }]);
    const jobId = enqueue(1, 'cm');
    pump();
    const job = await finished(jobId);
    expect(job.state).toBe('failed');
    expect(job.error).toBe(CM_CUT_ALREADY);
});

test('同じ録画に2つは積まない (焼くジョブがあればそれを返す)', () => {
    seed(null);
    const encode = enqueue(1);
    expect(enqueue(1, 'cm')).toBe(encode);
});
