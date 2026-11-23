import { Database } from "bun:sqlite";
import { join } from "node:path";

/**
 * **この bun の SQLite で、録画の字幕のインデックス (`caption_fts`) を作って引けるか** (tests/native-smoke.ts が呼ぶ)。
 * Linux の bun は SQLite を組み込んでいるが、Mac の bun は OS の SQLite を読む (推定)。Windows と Android の bun も、ここで確かめる。
 *
 * 使う形と同じものを作る。中身を持たない FTS5 (`content=''`) に、2 字ずつ区切ったものを入れ、
 * フレーズで引き、`'delete'` で 1 行消し、`'delete-all'` で全部消す。`VACUUM INTO` で写した先でも引けて、整合性も崩れないか
 *
 * @param work 写しを置く場所
 */
export function sqliteSmoke(work: string): void {
  const db = new Database(":memory:");
  const version = (
    db.query("SELECT sqlite_version() AS v").get() as { v: string }
  ).v;
  const options = (
    db.query("PRAGMA compile_options").all() as { compile_options: string }[]
  ).map((row) => row.compile_options);
  console.log(
    `SQLite ${version} (${options.filter((o) => /FTS/.test(o)).join(", ") || "FTS の指定なし"})`,
  );
  db.exec(
    `CREATE VIRTUAL TABLE caption_fts USING fts5(grams, content='', tokenize="unicode61 remove_diacritics 0 categories 'L* N* M* P* S* Co Cn'")`,
  );
  const insert = db.prepare(
    "INSERT INTO caption_fts(rowid, grams) VALUES (?, ?)",
  );
  insert.run(1, "東京 京都 都の の天 天気");
  insert.run(2, "(笑 笑) ♪♪ がぎ");
  const match = (q: string) =>
    (
      db
        .query(
          "SELECT rowid FROM caption_fts WHERE caption_fts MATCH ? ORDER BY rowid DESC",
        )
        .all(q) as { rowid: number }[]
    ).map((row) => row.rowid);
  const expectRows = (q: string, want: number[]) => {
    const got = match(q);
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(
        `MATCH ${q}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`,
      );
  };
  expectRows('"東京 京都"', [1]);
  expectRows('"(笑 笑)"', [2]);
  expectRows('"♪♪"', [2]);
  expectRows('"かき"', []);
  db.run(
    "INSERT INTO caption_fts(caption_fts, rowid, grams) VALUES ('delete', ?, ?)",
    [1, "東京 京都 都の の天 天気"],
  );
  expectRows('"東京 京都"', []);
  const copy = join(work, "sqlite-smoke.db");
  db.query("VACUUM INTO ?").run(copy);
  const copied = new Database(copy);
  copied.exec("PRAGMA trusted_schema = OFF");
  const check = (
    copied.query("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check;
  if (check !== "ok") throw new Error(`integrity_check: ${check}`);
  if (
    (
      copied
        .query("SELECT rowid FROM caption_fts WHERE caption_fts MATCH ?")
        .all('"がぎ"') as unknown[]
    ).length !== 1
  )
    throw new Error("写した先で引けません");
  copied.close();
  db.exec("INSERT INTO caption_fts(caption_fts) VALUES ('delete-all')");
  expectRows('"がぎ"', []);
  db.close();
  console.log("SQLite の FTS5 で字幕のインデックスを作って引けました");
}

if (import.meta.main) sqliteSmoke(process.argv[2] ?? ".");
