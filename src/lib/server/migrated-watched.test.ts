import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { bootstrap, MIGRATIONS } from "./db";

/**
 * **EPGStation から移した録画は視聴済み** (`0024_migrated-watched`)。一度流れると戻せないので、
 * 0023 までの DB に行を入れてから本物の手順 (`bootstrap`) で上げて確かめる
 */
test("移した録画は取り込んだ時刻で視聴済みに、denpa で録ったもの・途中まで観たものは変えない", () => {
  // 0023 までの置き場を作る (journal を切り詰めるだけ。SQL は同じもの)
  const old = mkdtempSync(join(tmpdir(), "denpa-migrated-watched-"));
  cpSync(MIGRATIONS, old, { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(old, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < "0024",
  );
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));

  const db = new Database(":memory:");
  migrate(drizzle({ client: db }), { migrationsFolder: old });
  const insert = db.prepare(
    `INSERT INTO recordings (id, program_id, service_id, name, start_at, end_at, finished_at, resume_ms, watched_at, created_at, updated_at)
         VALUES (?, ?, 1, '番組', 0, 0, 1000, ?, ?, 5000, 5000)`,
  );
  insert.run(1, -12, null, null); // 移した (観たかどうかは分からない)
  insert.run(2, -13, null, 9000); // 移して、denpa で観終えた
  insert.run(3, -14, 600_000, null); // 移して、denpa で途中まで観た
  insert.run(4, 77, null, null); // denpa で録って、まだ観ていない
  insert.run(5, null, null, null); // 手動の録画

  bootstrap(db);

  const rows = db
    .query("SELECT id, watched_at FROM recordings ORDER BY id")
    .all();
  expect(rows).toEqual([
    { id: 1, watched_at: 5000 },
    { id: 2, watched_at: 9000 },
    { id: 3, watched_at: null },
    { id: 4, watched_at: null },
    { id: 5, watched_at: null },
  ]);
});
