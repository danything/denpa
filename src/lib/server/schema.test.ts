import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getTableColumns, getTableName, is, Table } from 'drizzle-orm';
import { bootstrap, MIGRATIONS } from './db';
import * as schema from './schema';

/**
 * **schema.ts (型) と drizzle/ (マイグレーション) が同じ形か。**
 *
 * schema.ts を変えたのに `bun run db:generate` を回していないと、型と DB が
 * 食い違う。列の名前・型・NOT NULL・既定値の有無・生成列を突き合わせる。
 * それと、起動のしかた: 前からある DB にも当たること、列が足りなければ止まること
 */
interface Column {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    /** 0 = 普通の列。2 / 3 が生成列 (VIRTUAL / STORED) */
    hidden: number;
}

function tables(db: Database): string[] {
    return (
        db
            .query(
                `SELECT name FROM sqlite_master WHERE type = 'table'
                 AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name`,
            )
            .all() as { name: string }[]
    ).map((row) => row.name);
}

function columns(db: Database, table: string): Map<string, Column> {
    return new Map((db.query(`PRAGMA table_xinfo(${table})`).all() as Column[]).map((c) => [c.name, c]));
}

function migrations(db: Database): number {
    return (db.query('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
}

/** マイグレーションで作った DB */
function migrated(): Database {
    const db = new Database(':memory:');
    bootstrap(db);
    return db;
}

/**
 * マイグレーションを持つ前の DB。1.7.x までは起動のたびに `CREATE TABLE IF NOT EXISTS`
 * で整えていたので、テーブルはあるのに `__drizzle_migrations` が無い。
 * baseline と同じ文を素で流して作る (中身は同じ形)
 */
function preexisting(): Database {
    const db = new Database(':memory:');
    const sql = readFileSync(`${MIGRATIONS}/0000_baseline.sql`, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement);
    return db;
}

const defined = Object.values(schema).flatMap((value) => (is(value, Table) ? [value as Table] : []));

describe('schema.ts と drizzle/', () => {
    test('テーブルの一覧が同じ', () => {
        expect(defined.map(getTableName).sort()).toEqual(tables(migrated()));
    });

    for (const table of defined) {
        const name = getTableName(table);
        test(`${name} の列が同じ (db:generate を忘れていない)`, () => {
            const actual = columns(migrated(), name);
            const expected = Object.values(getTableColumns(table));
            // 名前の集合が一致 (どちらかにだけある列を先に言う)
            expect(expected.map((c) => c.name).sort()).toEqual([...actual.keys()].sort());

            for (const column of expected) {
                const real = actual.get(column.name)!;
                const where = `${name}.${column.name}`;
                expect(`${where} ${real.type.toLowerCase()}`).toBe(`${where} ${column.getSQLType()}`);
                expect(`${where} generated=${real.hidden !== 0}`).toBe(
                    `${where} generated=${column.generated !== undefined}`,
                );
                // 主キーは既定値を持たない。生成列は既定値を持ちようがない
                if (column.primary || column.generated !== undefined) continue;
                expect(`${where} notnull=${real.notnull === 1}`).toBe(`${where} notnull=${column.notNull}`);
                expect(`${where} default=${real.dflt_value !== null}`).toBe(
                    `${where} default=${column.hasDefault}`,
                );
            }
        });
    }
});

describe('起動', () => {
    test('マイグレーションを持つ前の DB にもそのまま当たり、二度目は何もしない', () => {
        const db = preexisting();
        expect(() => bootstrap(db)).not.toThrow();
        expect(migrations(db)).toBe(1);
        expect(tables(db)).toEqual(tables(migrated()));

        bootstrap(db);
        expect(migrations(db)).toBe(1);
    });

    test('列が足りない古い DB は、どの列かを言って止まる', () => {
        const db = migrated();
        db.exec('ALTER TABLE webhooks DROP COLUMN last_status');
        expect(() => bootstrap(db)).toThrow(/webhooks\.last_status/);
    });
});
