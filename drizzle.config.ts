import { defineConfig } from 'drizzle-kit';

/**
 * マイグレーションの出し方 (`bun run db:generate`)。
 *
 * テーブルの定義は `src/lib/server/schema.ts` にしか無い。そこを変えて
 * `db:generate` を回すと、前回の snapshot との差分が `drizzle/` に SQL で出る。
 * 当てるのは起動時 (`server/db.ts`)。手順は docs/development.md
 */
export default defineConfig({
    dialect: 'sqlite',
    schema: './src/lib/server/schema.ts',
    out: './drizzle',
});
