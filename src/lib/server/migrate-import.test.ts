import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';

/**
 * EPGStation の録画の取り込み (`importOne`) が、途中で止まっても
 * 「ファイルの無い行」を残さないこと。
 *
 * 先に行を入れてからファイルを写していた頃は、写している途中で落ちると行だけが残り、
 * 次の実行はそれを取り込み済みと読んで飛ばしていた。
 *
 * DB が途中で失敗するところは、SQLite のトリガで RAISE させて作る (本物の取り込みを
 * そのまま動かすため、試験用の差し込み口は持たない)。
 * 設定は環境変数ではなく設定そのものを書き換える (files.test.ts と同じ理由)。
 */
const root = mkdtempSync(join(tmpdir(), 'denpa-migrate-'));
const { config } = await import('./config');
config.dbPath = join(root, 'denpa.db');
config.rawDir = join(root, 'raw');
config.encodedDir = join(root, 'encoded');

const { orm } = await import('./db');
const { recordings } = await import('./schema');
const { importOne, source, status, sweepTemporaries } = await import('./migrate');
type Row = import('./migrate').Row;

const sourceDir = join(root, 'epgstation');
source.recordedDir = sourceDir;

const START = Date.UTC(2026, 8, 7, 3, 0, 0);
const CONTENT = 'これは録画の中身';

function row(id: number): Row {
    const filePath = `番組${id}.m2ts`;
    writeFileSync(join(sourceDir, filePath), CONTENT);
    return {
        id,
        name: `番組${id}`,
        description: null,
        startAt: START,
        endAt: START + 30 * 60_000,
        channelId: null,
        channelName: 'テスト局',
        serviceId: null,
        networkId: null,
        filePath,
        fileType: 'ts',
        fileSize: CONTENT.length,
    };
}

const apply = { apply: true, move: false };

function imported(id: number) {
    return orm().select().from(recordings).where(eq(recordings.program_id, -id)).all();
}

/** 置き場に並んでいるもの (書きかけも含む) */
function rawFiles(): string[] {
    return existsSync(config.rawDir) ? readdirSync(config.rawDir) : [];
}

/** 次の INSERT / UPDATE を失敗させる。プロセスが途中で死んだのと同じく、そこで止まる */
function failOn(event: 'INSERT' | 'UPDATE'): void {
    orm().run(
        sql.raw(
            `CREATE TRIGGER fail_${event} BEFORE ${event} ON recordings BEGIN SELECT RAISE(ABORT, '落ちた'); END`,
        ),
    );
}

beforeEach(() => {
    orm().delete(recordings).run();
    rmSync(config.rawDir, { recursive: true, force: true });
    rmSync(config.encodedDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
    mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
    orm().run(sql.raw('DROP TRIGGER IF EXISTS fail_INSERT'));
    orm().run(sql.raw('DROP TRIGGER IF EXISTS fail_UPDATE'));
});

describe('録画の取り込み', () => {
    test('写したあとで DB が失敗すると、行も書きかけも残らず、やり直せば入る', async () => {
        const target = row(1);
        failOn('INSERT');
        await expect(importOne(target, apply)).rejects.toThrow('落ちた');
        expect(imported(1)).toEqual([]);
        expect(rawFiles()).toEqual([]);

        orm().run(sql.raw('DROP TRIGGER fail_INSERT'));
        expect(await importOne(target, apply)).toBe('imported');
        const [recording] = imported(1);
        expect(recording?.ts_path).not.toBeNull();
        expect(readFileSync(recording!.ts_path!, 'utf8')).toBe(CONTENT);
        expect(rawFiles()).toHaveLength(1);
        // 2回目は取り込み済み
        expect(await importOne(target, apply)).toBe('skipped');
    });

    test('rename したあとで DB が失敗すると、置いたファイルも消える', async () => {
        const target = row(2);
        failOn('UPDATE');
        await expect(importOne(target, apply)).rejects.toThrow('落ちた');
        // INSERT ごとトランザクションが戻る
        expect(imported(2)).toEqual([]);
        expect(rawFiles()).toEqual([]);

        orm().run(sql.raw('DROP TRIGGER fail_UPDATE'));
        expect(await importOne(target, apply)).toBe('imported');
        expect(rawFiles()).toHaveLength(1);
    });

    test('移動でも、DB に入るまで元は消さない', async () => {
        const target = row(3);
        const from = join(sourceDir, target.filePath!);
        failOn('INSERT');
        await expect(importOne(target, { apply: true, move: true })).rejects.toThrow('落ちた');
        expect(readFileSync(from, 'utf8')).toBe(CONTENT);
        expect(rawFiles()).toEqual([]);

        orm().run(sql.raw('DROP TRIGGER fail_INSERT'));
        expect(await importOne(target, { apply: true, move: true })).toBe('imported');
        expect(existsSync(from)).toBe(false);
        expect(readFileSync(imported(3)[0]!.ts_path!, 'utf8')).toBe(CONTENT);
    });

    // root はパーミッションを無視して消せてしまうので、そこでは確かめられない
    test.skipIf(process.getuid?.() === 0)('移動で元を消せなくても、取り込みは済んだことにする', async () => {
        const target = row(8);
        const from = join(sourceDir, target.filePath!);
        // 元の置き場を読み取り専用にする (中のファイルを消せない)
        chmodSync(sourceDir, 0o555);
        try {
            expect(await importOne(target, { apply: true, move: true })).toBe('imported');
        } finally {
            chmodSync(sourceDir, 0o755);
        }
        expect(existsSync(from)).toBe(true);
        expect(readFileSync(imported(8)[0]!.ts_path!, 'utf8')).toBe(CONTENT);
        expect(status().log.at(-1)).toContain('元を消せなかった');
    });

    test('前の版が残した「ファイルの無い行」は、同じ行のまま置き直す', async () => {
        const target = row(4);
        // 先に行を入れていた頃の版が、写している途中で止まった跡
        const { id } = orm()
            .insert(recordings)
            .values({
                reservation_id: null,
                program_id: -4,
                service_id: 0,
                name: '番組4',
                series: '番組4',
                start_at: START,
                end_at: START + 30 * 60_000,
                finished_at: START,
                created_at: START,
                updated_at: START,
            })
            .returning({ id: recordings.id })
            .get();

        expect(await importOne(target, apply)).toBe('imported');
        const rows = imported(4);
        expect(rows.map((r) => r.id)).toEqual([id]);
        expect(readFileSync(rows[0]!.ts_path!, 'utf8')).toBe(CONTENT);
    });

    test('denpa 側で消したものは戻さない', async () => {
        const target = row(5);
        orm()
            .insert(recordings)
            .values({
                reservation_id: null,
                program_id: -5,
                service_id: 0,
                name: '番組5',
                start_at: START,
                end_at: START + 30 * 60_000,
                finished_at: START,
                deleted_at: START,
                created_at: START,
                updated_at: START,
            })
            .run();

        expect(await importOne(target, apply)).toBe('skipped');
        expect(rawFiles()).toEqual([]);
    });

    test('取り残された書きかけは片付け、ほかのものには触らない', () => {
        const series = join(config.encodedDir, '番組');
        mkdirSync(config.rawDir, { recursive: true });
        mkdirSync(series, { recursive: true });
        writeFileSync(join(config.rawDir, '.epgstation-6.m2ts.migrating'), CONTENT);
        writeFileSync(join(series, '.epgstation-7.mkv.migrating'), CONTENT);
        writeFileSync(join(config.rawDir, '番組-20260907-120000-1.m2ts'), CONTENT);
        writeFileSync(join(series, '番組 - 2026-09-07 - 1200.mkv.1.av1.encoding'), CONTENT);

        expect(sweepTemporaries()).toBe(2);
        expect(rawFiles()).toEqual(['番組-20260907-120000-1.m2ts']);
        expect(readdirSync(series)).toEqual(['番組 - 2026-09-07 - 1200.mkv.1.av1.encoding']);
    });
});
