import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { bootstrap, MIGRATIONS } from './db';

/**
 * **上げる前の録画は観終えた扱い** (`0005_watched-at`)。一度流れると戻せないので、
 * 0004 までの DB に行を入れてから本物の手順 (`bootstrap`) で上げて確かめる
 */
test('録り終えた録画は観終えた扱い、途中まで観たもの・録画中は未視聴のまま', () => {
    // 0004 までの置き場を作る (journal を切り詰めるだけ。SQL は同じもの)
    const old = mkdtempSync(join(tmpdir(), 'denpa-watched-'));
    cpSync(MIGRATIONS, old, { recursive: true });
    const journal = JSON.parse(readFileSync(join(old, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0005');
    writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));

    const db = new Database(':memory:');
    migrate(drizzle({ client: db }), { migrationsFolder: old });
    const insert = db.prepare(
        `INSERT INTO recordings (id, service_id, name, start_at, end_at, finished_at, resume_ms, created_at, updated_at)
         VALUES (?, 1, '番組', 0, 0, ?, ?, 0, 0)`,
    );
    insert.run(1, 1000, null); // 録り終えた (観たかどうかは分からない)
    insert.run(2, 1000, 600_000); // 途中まで観た
    insert.run(3, null, null); // 録画中

    const before = Date.now();
    bootstrap(db);
    const after = Date.now();

    const rows = db.query('SELECT id, watched_at FROM recordings ORDER BY id').all() as {
        id: number;
        watched_at: number | null;
    }[];
    // 時刻は上げたとき (ms)。julianday からの換算が秒やずれた桁になっていないこと
    expect(rows[0]!.watched_at).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0]!.watched_at).toBeLessThanOrEqual(after + 1000);
    expect(rows.slice(1)).toEqual([
        { id: 2, watched_at: null },
        { id: 3, watched_at: null },
    ]);
});
