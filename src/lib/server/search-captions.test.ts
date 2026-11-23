import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";

/**
 * 録画の字幕で探す (`search.searchCaptions`)。字幕のインデックスは `caption-index.writeCaptionIndex` で直に入れる
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-search-cap-"));
const { config } = await import("./config");
config.dbPath = join(dir, "denpa.db");

const { orm } = await import("./db");
const { CAPTION_FTS, captionIndex, captionLines, recordings } =
  await import("./schema");
const { writeCaptionIndex } = await import("./caption-index");
const { searchCaptions } = await import("./search");

const START = Date.UTC(2026, 9, 1, 12);
const MIN = 60_000;

/** 録画を足し、字幕を入れる。字幕の時刻は元の TS の先頭からの秒 (元の TS は番組の 1 分前から) */
function recordingWith(
  id: number,
  lines: [number, string][],
  name = `録画 ${id}`,
) {
  orm()
    .insert(recordings)
    .values({
      id,
      service_id: 1,
      service_name: "でんぱテレビ",
      name,
      start_at: START,
      end_at: START + 30 * MIN,
      ts_head: START - MIN,
      finished_at: START + 30 * MIN,
      library_path: join(dir, `${id}.mkv`),
      created_at: START,
      updated_at: START,
    })
    .run();
  writeCaptionIndex(
    {
      id,
      library_path: join(dir, `${id}.mkv`),
      ts_path: null,
      encode_skip: null,
      encode_job: null,
    },
    {
      state: "done",
      lines: lines.map(([at, text]) => ({
        at_ms: at * 1000,
        language: 1,
        text,
      })),
    },
  );
}

beforeEach(() => {
  orm().run(
    sql`INSERT INTO ${sql.raw(CAPTION_FTS)}(${sql.raw(CAPTION_FTS)}) VALUES ('delete-all')`,
  );
  orm().delete(captionLines).run();
  orm().delete(captionIndex).run();
  orm().delete(recordings).run();
});

describe("録画の字幕で探す", () => {
  test("2 字の語で引け、番組の始めからの秒と前後の 1 枚を返す", () => {
    recordingWith(1, [
      [70, "続いて天気です"],
      [75, "東京の天気は 午後から雨です"],
      [80, "傘を持ってお出かけください"],
    ]);
    const found = searchCaptions("天気 雨", { limit: 10 });
    expect(found.total).toBe(1);
    const [row] = found.rows;
    expect(row?.hits).toEqual([
      {
        at: 15,
        text: "東京の天気は 午後から雨です",
        marks: [
          [3, 5],
          [11, 12],
        ],
        before: "続いて天気です",
        after: "傘を持ってお出かけください",
        language: 1,
      },
    ]);
    expect(row?.has_file).toBe(true);
  });

  test("行をまたいでも、全角・半角を揃えても当たる", () => {
    recordingWith(2, [[70, "ＮＨＫの 東京都"]]);
    expect(searchCaptions("nhkの東京", { limit: 10 }).total).toBe(1);
  });

  test("新しい録画から並べ、上限を超えたら more を立てる", () => {
    for (const id of [3, 4, 5]) recordingWith(id, [[70, "地震の情報です"]]);
    const found = searchCaptions("地震", { limit: 2 });
    expect(found.rows.map((r) => r.id)).toEqual([5, 4]);
    expect(found.total).toBe(2);
    expect(found.more).toBe(true);
  });

  test("10 秒より近い当たりは 1 つにまとめ、見せるのは 3 か所まで", () => {
    recordingWith(
      6,
      [70, 72, 74, 100, 200, 300, 400].map(
        (at) => [at, `大谷選手 ${at}`] as [number, string],
      ),
    );
    const [row] = searchCaptions("大谷", { limit: 10 }).rows;
    expect(row?.hits_total).toBe(5);
    expect(row?.hits.map((h) => h.at)).toEqual([10, 40, 140]);
  });

  test("1 字だけの言葉では探さない。1 字の語はほかの語と一緒なら確かめ直しに使う", () => {
    recordingWith(7, [
      [70, "雨の東京"],
      [90, "晴れの東京"],
    ]);
    expect(searchCaptions("雨", { limit: 10 })).toMatchObject({
      short: true,
      rows: [],
    });
    const [row] = searchCaptions("東京 雨", { limit: 10 }).rows;
    expect(row?.hits.map((h) => h.text)).toEqual(["雨の東京"]);
  });

  test("記号だけの語でも式を空にしない", () => {
    recordingWith(8, [[70, "(笑) ♪♪"]]);
    expect(searchCaptions("(笑)", { limit: 10 }).total).toBe(1);
    expect(searchCaptions("♪♪", { limit: 10 }).total).toBe(1);
    expect(searchCaptions('"', { limit: 10 }).short).toBe(true);
    expect(searchCaptions("a・b", { limit: 10 }).total).toBe(0);
  });

  test("消した録画は出さない", () => {
    recordingWith(9, [[70, "消す録画の字幕"]]);
    orm().update(recordings).set({ deleted_at: START }).run();
    expect(searchCaptions("消す", { limit: 10 }).total).toBe(0);
  });
});
