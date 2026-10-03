import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { config } from './config';
import { bootstrap, MIGRATIONS } from './db';
import * as schema from './schema';

/**
 * **録画ファイルの場所は、DB には置き場からの相対で入る** (schema.ts の `mediaPath`)。
 *
 * 絶対パスで持っていた頃は、置き場のマウント先を変えると全部の録画が辿れなくなった。
 * コードからは今までどおり絶対パスに見えること、DB の中身は相対になっていること、
 * 古い DB の絶対パスがマイグレーションで相対に直ることを見る
 */
const saved = { raw: config.rawDir, encoded: config.encodedDir };
config.rawDir = '/media/raw';
config.encodedDir = '/media/encoded';
afterAll(() => {
    config.rawDir = saved.raw;
    config.encodedDir = saved.encoded;
});

function fresh() {
    const db = new Database(':memory:');
    bootstrap(db);
    return { db, orm: drizzle({ client: db, schema }) };
}

const NOW = Date.UTC(2026, 9, 3);
const row = (over: Partial<typeof schema.recordings.$inferInsert>) => ({
    service_id: 1,
    name: '番組',
    start_at: NOW,
    end_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
});

describe('録画ファイルの場所', () => {
    test('置き場の下なら相対で書き、読むときは絶対に戻す', () => {
        const { db, orm } = fresh();
        orm.insert(schema.recordings)
            .values(
                row({
                    id: 1,
                    ts_path: '/media/raw/番組-20261003-1.m2ts',
                    library_path: '/media/encoded/番組/番組 - 2026-10-03 - 0900.mkv',
                    alt_path: '/media/encoded/番組/番組 - 2026-10-03 - 0900 [H264].mkv',
                }),
            )
            .run();

        expect(db.query('SELECT ts_path, library_path, alt_path FROM recordings').get()).toEqual({
            ts_path: '番組-20261003-1.m2ts',
            library_path: '番組/番組 - 2026-10-03 - 0900.mkv',
            alt_path: '番組/番組 - 2026-10-03 - 0900 [H264].mkv',
        });
        const read = orm.select().from(schema.recordings).where(eq(schema.recordings.id, 1)).get()!;
        expect(read.ts_path).toBe('/media/raw/番組-20261003-1.m2ts');
        expect(read.library_path).toBe('/media/encoded/番組/番組 - 2026-10-03 - 0900.mkv');

        // 絶対パスで探しても当たる (eq に渡した値も同じ読み替えを通る)
        const found = orm
            .select({ id: schema.recordings.id })
            .from(schema.recordings)
            .where(eq(schema.recordings.library_path, '/media/encoded/番組/番組 - 2026-10-03 - 0900.mkv'))
            .get();
        expect(found?.id).toBe(1);
    });

    test('置き場を移しても、DB を触らずに新しい置き場を指す', () => {
        const { orm } = fresh();
        orm.insert(schema.recordings)
            .values(row({ id: 1, ts_path: '/media/raw/a.m2ts' }))
            .run();
        config.rawDir = '/mnt/fast/raw';
        try {
            expect(orm.select().from(schema.recordings).get()?.ts_path).toBe('/mnt/fast/raw/a.m2ts');
        } finally {
            config.rawDir = '/media/raw';
        }
    });

    test('置き場の外のものは絶対のまま持つ', () => {
        const { db, orm } = fresh();
        orm.insert(schema.recordings)
            .values(row({ id: 1, ts_path: '/elsewhere/a.m2ts' }))
            .run();
        expect(db.query('SELECT ts_path FROM recordings').get()).toEqual({ ts_path: '/elsewhere/a.m2ts' });
        expect(orm.select().from(schema.recordings).get()?.ts_path).toBe('/elsewhere/a.m2ts');
    });
});

describe('古い DB の絶対パスを相対に直す (0002_relative-media-paths)', () => {
    const migration = readFileSync(`${MIGRATIONS}/0002_relative-media-paths.sql`, 'utf8');

    test('生TS はファイル名、焼いたものはシリーズとファイル (古い Season フォルダは3段)', () => {
        const { db } = fresh();
        const insert = db.prepare(
            `INSERT INTO recordings (id, service_id, name, start_at, end_at, created_at, updated_at, ts_path, library_path, alt_path)
             VALUES (?, 1, '番組', 0, 0, 0, 0, ?, ?, ?)`,
        );
        insert.run(
            1,
            '/app/recorded/バーテックスフォース-20261003-233000-344.m2ts',
            '/library/アニメ ふんばるず/アニメ ふんばるず - 2026-10-03 - 2325.mkv',
            '/library/アニメ ふんばるず/アニメ ふんばるず - 2026-10-03 - 2325 [H264].mkv',
        );
        insert.run(
            2,
            '/media/DTV/denpa/recorded/a.m2ts',
            '/media/DTV/denpa/library/番組/Season 2026/番組 - x.mkv',
            null,
        );
        insert.run(3, 'b.m2ts', '番組/c.mkv', null);
        insert.run(4, 'C:\\rec\\a.m2ts', null, null);

        for (const statement of migration.split('--> statement-breakpoint')) db.run(statement);

        expect(
            db.query('SELECT id, ts_path, library_path, alt_path FROM recordings ORDER BY id').all(),
        ).toEqual([
            {
                id: 1,
                ts_path: 'バーテックスフォース-20261003-233000-344.m2ts',
                library_path: 'アニメ ふんばるず/アニメ ふんばるず - 2026-10-03 - 2325.mkv',
                alt_path: 'アニメ ふんばるず/アニメ ふんばるず - 2026-10-03 - 2325 [H264].mkv',
            },
            { id: 2, ts_path: 'a.m2ts', library_path: '番組/Season 2026/番組 - x.mkv', alt_path: null },
            // 相対のものと Windows で書かれたものは触らない
            { id: 3, ts_path: 'b.m2ts', library_path: '番組/c.mkv', alt_path: null },
            { id: 4, ts_path: 'C:\\rec\\a.m2ts', library_path: null, alt_path: null },
        ]);
    });
});
