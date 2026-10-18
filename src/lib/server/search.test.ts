import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * サイト全体の検索 (`/search`)。番組表・録画・予約・ルールを同じ読み方で探す
 * (空白で区切った語をすべて含む。全角/半角・大文字/小文字は揃えて比べる)
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-search-')), 'denpa.db');

const { now, orm } = await import('./db');
const { hasAll, searchPrograms, searchRecordings, searchReservations, searchRules, searchWords } =
    await import('./search');
const { programs, recordings, reservations, rules, services } = await import('./schema');

const SERVICE = 3239123608;
const HOUR = 60 * 60 * 1000;

function clear(): void {
    orm().delete(recordings).run();
    orm().delete(reservations).run();
    orm().delete(programs).run();
    orm().delete(rules).run();
    orm().delete(services).run();
}
afterAll(clear);

beforeEach(() => {
    clear();
    orm()
        .insert(services)
        .values({
            id: SERVICE,
            service_id: 23608,
            network_id: 32391,
            name: 'ＴＯＫＹＯ　ＭＸ１',
            type: 'GR',
            service_type: 1,
            channel: 'T16',
            updated_at: now(),
        })
        .run();
});

function program(id: number, name: string, startsIn: number, description = ''): void {
    const start = now() + startsIn;
    orm()
        .insert(programs)
        .values({
            id,
            service_id: SERVICE,
            network_id: 32391,
            event_id: id,
            start_at: start,
            end_at: start + HOUR,
            name,
            description,
            updated_at: now(),
        })
        .run();
}

function recording(id: number, fields: { name: string; series?: string; deleted?: boolean }): void {
    orm()
        .insert(recordings)
        .values({
            id,
            service_id: SERVICE,
            service_name: 'ＴＯＫＹＯ　ＭＸ１',
            name: fields.name,
            series: fields.series ?? '',
            start_at: now() - 2 * HOUR - id,
            end_at: now() - HOUR,
            ts_path: `/media/raw/${id}.ts`,
            finished_at: now() - HOUR,
            deleted_at: fields.deleted ? now() : null,
            created_at: now(),
            updated_at: now(),
        })
        .run();
}

describe('語の読み方', () => {
    test('空白で区切り、全角は半角に、大文字は小文字に揃える', () => {
        expect(searchWords('  ＡＢＣ　でんぱ ')).toEqual(['abc', 'でんぱ']);
        expect(searchWords('   ')).toEqual([]);
    });

    test('すべての語を含むときだけ当たる', () => {
        expect(hasAll(['abc', 'でんぱ'], 'ＡＢＣ', 'でんぱテレビ')).toBe(true);
        expect(hasAll(['abc', 'ラジオ'], 'ＡＢＣ', 'でんぱテレビ')).toBe(false);
    });
});

describe('これからの放送', () => {
    test('番組名か概要に当たる、終わっていない番組だけ。近い順', () => {
        program(1, 'テストアニメ 第2話', 3 * HOUR);
        program(2, 'ニュース', 2 * HOUR, 'テストアニメの特集');
        program(3, 'テストアニメ 第1話', -3 * HOUR);
        program(4, '天気予報', HOUR);
        const found = searchPrograms('テストアニメ', 10);
        expect(found.total).toBe(2);
        expect(found.rows.map((row) => row.id)).toEqual([2, 1]);
    });

    test('件数は全部、行は上限まで', () => {
        for (let i = 1; i <= 5; i++) program(i, `テストアニメ 第${i}話`, i * HOUR);
        const found = searchPrograms('テストアニメ', 2);
        expect(found.total).toBe(5);
        expect(found.rows).toHaveLength(2);
    });

    test('予約が立っていれば行に出す', () => {
        program(1, 'テストアニメ', HOUR);
        const start = now() + HOUR;
        orm()
            .insert(reservations)
            .values({
                program_id: 1,
                service_id: SERVICE,
                name: 'テストアニメ',
                start_at: start,
                end_at: start + HOUR,
                manual: true,
                created_at: now(),
                updated_at: now(),
            })
            .run();
        const [row] = searchPrograms('テストアニメ', 10).rows;
        expect(row?.reservation_state).toBe('scheduled');
        expect(row?.reservation_id).not.toBeNull();
    });

    test('空の言葉では何も探さない', () => {
        program(1, 'テストアニメ', HOUR);
        expect(searchPrograms('  ', 10)).toEqual({ total: 0, rows: [] });
    });
});

describe('録画', () => {
    test('番組名・シリーズ・局名に当たる。消したものは出さない', () => {
        recording(1, { name: '第3話「旅立ち」', series: 'テストアニメ' });
        recording(2, { name: 'テストアニメ 第2話', deleted: true });
        recording(3, { name: 'ニュース' });
        expect(searchRecordings('テストアニメ', 10).rows.map((row) => row.id)).toEqual([1]);
        // 局名は全角で入っていても半角で当たる
        expect(searchRecordings('tokyo mx', 10).total).toBe(2);
        expect(searchRecordings('テストアニメ', 10).rows[0]?.has_file).toBe(true);
    });
});

describe('予約とルール', () => {
    test('予約は番組名と局名に当たる。取り消したものは出さない', () => {
        const start = now() + HOUR;
        orm()
            .insert(reservations)
            .values([
                {
                    program_id: 1,
                    service_id: SERVICE,
                    name: 'テストアニメ',
                    start_at: start,
                    end_at: start + HOUR,
                    created_at: now(),
                    updated_at: now(),
                },
                {
                    program_id: 2,
                    service_id: SERVICE,
                    name: 'テストアニメ 再',
                    start_at: start,
                    end_at: start + HOUR,
                    state: 'canceled' as const,
                    created_at: now(),
                    updated_at: now(),
                },
            ])
            .run();
        const found = searchReservations('テストアニメ', 10);
        expect(found.rows.map((row) => row.program_id)).toEqual([1]);
        expect(found.rows[0]?.state).toBe('scheduled');
    });

    test('ルールは名前とキーワードに当たる', () => {
        orm()
            .insert(rules)
            .values([
                { name: 'アニメ枠', keyword: 'テストアニメ', created_at: now() },
                { name: 'ニュース', keyword: 'ニュース', created_at: now() },
            ])
            .run();
        expect(searchRules('テストアニメ', 10).rows.map((row) => row.name)).toEqual(['アニメ枠']);
        expect(searchRules('アニメ枠', 10).total).toBe(1);
    });
});
