import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { Rule } from "../types";
import { bootstrap, MIGRATIONS } from "./db";
import { compile, haystack, matchesCompiled } from "./rules";
import * as schema from "./schema";

/**
 * **2.0 に上げると、今あるルールのジャンルの条件が外れる** (0013_clear-rule-genres)。
 *
 * 上げる前の DB (0012 まで当たったもの) を作り、起動と同じ `bootstrap` で残りを当てる。
 * 予約をそろえ直すのはマイグレーションではなく、起動直後の当て直し (`epg.sync` → `rules.applyRules`)
 */
describe("ルールのジャンルの条件を外す (0013_clear-rule-genres)", () => {
  /**
   * 0013 を当てる前の DB。0012 までのマイグレーションだけを写した置き場から当てる。次の `bootstrap` がそこから先を当てる
   * (当てた記録を消すだけだと、0013 より後に作ったテーブルを作り直そうとして落ちる)
   */
  function before0013() {
    const dir = mkdtempSync(join(tmpdir(), "denpa-0012-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const path = join(dir, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.tag < "0013");
    writeFileSync(path, JSON.stringify(journal));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: dir });
    rmSync(dir, { recursive: true, force: true });
    return db;
  }

  test("どのルールも全ジャンル (NULL) になり、ほかの条件は残る", () => {
    const db = before0013();
    db.run(
      `INSERT INTO rules (id, name, keyword, service_ids, genres, created_at) VALUES
                (1, 'アニメ', 'テストアニメ', NULL, '["7"]', 0),
                (2, 'ドラマ', '', '[3]', '["3", "3-0"]', 0),
                (3, '全部', 'テスト', NULL, NULL, 0),
                (4, '空', 'テスト', NULL, '[]', 0)`,
    );

    bootstrap(db);

    expect(
      db
        .query("SELECT id, keyword, service_ids, genres FROM rules ORDER BY id")
        .all(),
    ).toEqual([
      { id: 1, keyword: "テストアニメ", service_ids: null, genres: null },
      { id: 2, keyword: "", service_ids: "[3]", genres: null },
      { id: 3, keyword: "テスト", service_ids: null, genres: null },
      { id: 4, keyword: "テスト", service_ids: null, genres: null },
    ]);
  });

  test("外れたあとは、ほかのジャンルの番組にも当たる", () => {
    const db = before0013();
    db.run(
      `INSERT INTO rules (id, name, keyword, genres, created_at) VALUES (1, 'r', 'テストアニメ', '["7"]', 0)`,
    );
    const program = {
      name: "テストアニメ #1",
      description: "",
      extended: null,
      service_id: 1,
      is_free: true,
      genres: [5],
      genre_detail: [{ lv1: 5, lv2: 0 }],
      start_at: 0,
    };
    const read = () =>
      drizzle({ client: db, schema }).select().from(schema.rules).get()!;
    const hits = (rule: Rule) =>
      matchesCompiled(compile(rule), program, "GR", false, (fields) =>
        haystack(program, fields),
      );
    expect(hits(read())).toBe(false);

    bootstrap(db);

    expect(compile(read()).genres).toBeNull();
    expect(hits(read())).toBe(true);
  });
});
