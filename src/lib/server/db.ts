import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getTableColumns, getTableName, is, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { config } from './config';
import * as schema from './schema';

/**
 * SQLite への接続。
 *
 * 最初に使われるまで開かない。import しただけでディレクトリを掘ってDBを作ると、
 * 引数の組み立てなど「DBに触らないはずの関数」を単体テストするだけで書き込み権限が
 * 要るようになってしまう(実際、CIで /app を掘ろうとして落ちた)。
 */
let instance: Database | null = null;

export function database(): Database {
    if (instance !== null) return instance;

    mkdirSync(dirname(config.dbPath), { recursive: true });
    const db = new Database(config.dbPath, { create: true });

    // WAL でないと、録画中の書き込みとUIの読み取りが SQLITE_BUSY で衝突する
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    bootstrap(db);

    instance = db;
    return instance;
}

/**
 * マイグレーションの置き場 (drizzle-kit の出力)。**cwd から読む** — 開発サーバも
 * `bun test` もリポジトリ直下で動き、コンテナは `/app` に COPY してある (Dockerfile)。
 * vite に束ねさせない (`?raw` は bun test の直接実行で読めない)
 */
export const MIGRATIONS = 'drizzle';

/**
 * DB を今の形にする。**当てるのは `drizzle/` のマイグレーションだけ** (schema.ts が正)。
 *
 * 当てたぶんは `__drizzle_migrations` に残り、次からは新しいものだけが当たる。
 * 最初のマイグレーション (baseline) は `IF NOT EXISTS` にしてあるので、
 * マイグレーションを持つ前 (1.7.x まで) の DB にもそのまま当たる — あの頃は起動のたびに
 * `CREATE TABLE IF NOT EXISTS` と足りない列の追加で同じ形に整えていた
 */
export function bootstrap(db: Database, migrationsFolder: string = MIGRATIONS): void {
    migrate(drizzle({ client: db }), { migrationsFolder });
    verify(db);
}

/**
 * schema.ts の列が全部あるか。
 *
 * baseline は既にあるテーブルを触らないので、**1.7.x を一度も起動していない古い DB**
 * (足りない列を起動時に足していた頃のもの) は、足りないまま通ってしまう。
 * 動き出してから `no such column` で落ちるより、起動で言って止まるほうが分かる
 */
function verify(db: Database): void {
    for (const table of Object.values(schema)) {
        if (!is(table, Table)) continue;
        const name = getTableName(table);
        // table_info は生成列 (recordings.state) を出さない。xinfo なら hidden 付きで出る
        const have = new Set(
            (db.query(`PRAGMA table_xinfo(${name})`).all() as { name: string }[]).map((c) => c.name),
        );
        for (const column of Object.values(getTableColumns(table))) {
            if (have.has(column.name)) continue;
            throw new Error(
                `DB に ${name}.${column.name} がありません。1.7.x を一度起動して DB を整えてから上げてください`,
            );
        }
    }
}

function wrap() {
    return drizzle({ client: database(), schema });
}

let typed: ReturnType<typeof wrap> | null = null;

/**
 * 同じ接続を drizzle で包んだもの。**型の付いた読み書きはこちらから。**
 *
 * `database()` と接続は1つ (WAL や busy_timeout の設定もそのまま効く)。
 * bun:sqlite なので同期のまま — `.get()` / `.all()` / `.run()` を付けて呼ぶ。
 * 生の SQL でしか書けないもの (`RESERVATION_STATE` の CASE など) は
 * `queryOne` / `queryAll` に残してよい
 */
export function orm() {
    if (typed !== null) return typed;
    typed = wrap();
    return typed;
}

export function now(): number {
    return Date.now();
}

/**
 * 1行だけ取る。
 *
 * bun:sqlite の `.get()` は該当行が無いとき `undefined` ではなく `null` を返すので、
 * `=== undefined` で書くと素通りして「null のプロパティを読む」で落ちる。
 * ここで undefined に正規化しておき、呼び出し側は普通の省略可能値として扱えるようにする。
 * `db.query` を使うのは、同じSQLの prepared statement をbun側で使い回させるため。
 */
export function queryOne<T>(sql: string, ...params: SQLQueryBindings[]): T | undefined {
    return (
        (database()
            .query(sql)
            .get(...params) as T | null) ?? undefined
    );
}

export function queryAll<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return database()
        .query(sql)
        .all(...params) as T[];
}
