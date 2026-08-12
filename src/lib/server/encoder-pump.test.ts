import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * エンコードキューの毒ジョブ対策。
 *
 * プロセスごと落とすジョブは running→queued へ戻り続け、同時実行1・id順だと
 * 毎回先頭に来てキューを塞ぐ。掴んだ回数 (attempts) が上限を超えたら、走らせずに
 * failed へ倒して後ろを進める、を確かめる。
 *
 * DBの置き場は一時ファイルへ。環境変数ではなく設定そのものを書き換える
 * (config は読み込み時に1度だけ環境変数を見るため。files.test.ts と同じ理由)。
 *
 * 録画には生TSを持たせない。上限未満のジョブは掴まれて runJob へ進むが、元にできる
 * ファイルが無いので ffmpeg を起こす前に自分で failed になる。テストで本物の
 * エンコードを起こさないための細工でもある
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-encpump-')), 'denpa.db');
config.encodeMaxAttempts = 5;

const { database } = await import('./db');
const { pump } = await import('./encoder');

const now = Date.now();

function reset(): void {
    const db = database();
    db.exec('DELETE FROM recordings; DELETE FROM encode_jobs');
    db.prepare(
        `INSERT INTO recordings (id, service_id, name, start_at, end_at, created_at, updated_at)
         VALUES (1, 1, '毒番組', ?, ?, ?, ?)`,
    ).run(now, now, now, now);
}

function seedJob(attempts: number): number {
    return Number(
        database()
            .prepare(
                `INSERT INTO encode_jobs (recording_id, state, attempts, created_at) VALUES (1, 'queued', ?, ?)`,
            )
            .run(attempts, now).lastInsertRowid,
    );
}

function job(jobId: number): { state: string; attempts: number } {
    return database().prepare('SELECT state, attempts FROM encode_jobs WHERE id = ?').get(jobId) as {
        state: string;
        attempts: number;
    };
}

test('上限を超えたジョブは掴まずに failed へ倒す', () => {
    reset();
    const jobId = seedJob(config.encodeMaxAttempts); // ちょうど上限 (>=)
    pump();
    const after = job(jobId);
    expect(after.state).toBe('failed');
    // 掴んでいないので attempts は増えない (増えていれば走らせてしまっている)
    expect(after.attempts).toBe(config.encodeMaxAttempts);
});

test('上限未満のジョブは普通に掴む (attempts が増える)', () => {
    reset();
    const jobId = seedJob(config.encodeMaxAttempts - 1);
    pump();
    // 掴みで attempts+1。上限の分岐で早々に切り捨てていないことの裏返し
    expect(job(jobId).attempts).toBe(config.encodeMaxAttempts);
});
