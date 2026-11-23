import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptionPage } from "@danything/arib/caption-text";
import {
  captionMkv,
  encodeAribText,
  management,
  text,
} from "@danything/arib/synth-caption";
import { eq, sql } from "drizzle-orm";

/**
 * 録画の字幕のインデックス (`caption-index.ts`)。DB は一時ファイルへ、ffmpeg は偽物 (sh) に差し替える
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-capidx-"));
const { config } = await import("./config");
config.dbPath = join(dir, "denpa.db");
config.encodedDir = join(dir, "encoded");
config.rawDir = join(dir, "raw");
mkdirSync(config.encodedDir, { recursive: true });
mkdirSync(config.rawDir, { recursive: true });
const realFfmpeg = config.ffmpeg;
afterAll(() => {
  config.ffmpeg = realFfmpeg;
  rmSync(dir, { recursive: true, force: true });
});

const { orm } = await import("./db");
const { CAPTION_FTS, captionIndex, captionLines, encodeJobs, recordings } =
  await import("./schema");
const {
  CAPTION_INDEX_VERSION,
  captionLineId,
  captionLinesOf,
  dropCaptionIndex,
  indexRecording,
  nextRecording,
  pendingCaptionIndex,
  pruneCaptionIndex,
  recordingOfLine,
  wipeOldVersion,
  writeCaptionIndex,
} = await import("./caption-index");
const { captionGrams, captionKey } = await import("./caption-key");

const MIN = 60_000;
const START = Date.UTC(2026, 9, 1, 12);

/** 1 行の字幕の 1 枚 */
function page(words: string): CaptionPage {
  return {
    v: 1,
    plane: [960, 540],
    duration: null,
    runs:
      words === ""
        ? []
        : [
            {
              x: 0,
              y: 0,
              w: 36,
              h: 36,
              fx: 0,
              fy: 0,
              size: 36,
              scaleX: 1,
              text: words,
              fg: "#ffffffff",
              bg: "#00000000",
            },
          ],
  };
}

function addRecording(
  id: number,
  extra: Partial<typeof recordings.$inferInsert> = {},
) {
  orm()
    .insert(recordings)
    .values({
      id,
      service_id: 1,
      name: `録画 ${id}`,
      start_at: START,
      end_at: START + 30 * MIN,
      record_from: START,
      ts_head: START,
      finished_at: START + 30 * MIN,
      created_at: START,
      updated_at: START,
      ...extra,
    })
    .run();
  return orm().select().from(recordings).where(eq(recordings.id, id)).get()!;
}

/** FTS5 で引いた行の ID (新しい順) */
function match(word: string): number[] {
  const grams = captionGrams(captionKey(word).key);
  return (
    orm().all(
      sql`SELECT rowid AS id FROM ${sql.raw(CAPTION_FTS)} WHERE ${sql.raw(CAPTION_FTS)} MATCH ${`"${grams}"`} ORDER BY rowid DESC`,
    ) as { id: number }[]
  ).map((row) => row.id);
}

beforeEach(() => {
  orm().run(
    sql`INSERT INTO ${sql.raw(CAPTION_FTS)}(${sql.raw(CAPTION_FTS)}) VALUES ('delete-all')`,
  );
  orm().delete(captionLines).run();
  orm().delete(captionIndex).run();
  orm().delete(encodeJobs).run();
  orm().delete(recordings).run();
});

describe("取り出した字幕を入れる行にする", () => {
  const recording = {
    cm_kept: null,
    encode_skip: 10,
    start_at: START,
    ts_head: START - 60_000,
    record_from: START - 60_000,
  };

  test("元の TS の物差しに直し、番組の前の余白・空の 1 枚・続けて同じ 1 枚は入れない", () => {
    const lines = captionLinesOf(
      recording,
      {
        v: 1,
        pages: [
          { at: 30, page: page("前の番組") },
          { at: 61, page: page("こんばんは") },
          { at: 62, page: page("こんばんは") },
          { at: 63, page: page("") },
          { at: 64, page: page("ニュースです") },
        ],
      },
      false,
    );
    expect(lines).toEqual([
      { at_ms: 61_000, language: 1, text: "こんばんは" },
      { at_ms: 64_000, language: 1, text: "ニュースです" },
    ]);
  });

  test("エンコード済みから読んだら、捨てた先頭のぶん足す。第 2 言語も入れる", () => {
    const lines = captionLinesOf(
      recording,
      {
        v: 1,
        pages: [{ at: 55, page: page("字幕") }],
        language: { index: 1, code: "jpn", label: "日本語" },
        others: [
          {
            index: 2,
            code: "eng",
            label: "英語",
            pages: [{ at: 56, page: page("caption") }],
          },
        ],
      },
      true,
    );
    expect(lines).toEqual([
      { at_ms: 65_000, language: 1, text: "字幕" },
      { at_ms: 66_000, language: 2, text: "caption" },
    ]);
  });

  test("前のバージョンで CM を切ったものは、残した区間から元の TS の物差しへ直す", () => {
    const lines = captionLinesOf(
      {
        ...recording,
        cm_kept: [
          { start: 60, end: 100 },
          { start: 200, end: 300 },
        ],
      },
      {
        v: 1,
        pages: [
          { at: 39.9, page: page("本編 1") },
          { at: 40, page: page("本編 2") },
        ],
      },
      true,
    );
    expect(lines.map((l) => [l.at_ms, l.text])).toEqual([
      [99_900, "本編 1"],
      [200_000, "本編 2"],
    ]);
  });
});

describe("インデックスに書く・消す", () => {
  const snapshotOf = (r: typeof recordings.$inferSelect) => ({
    id: r.id,
    library_path: r.library_path,
    ts_path: r.ts_path,
    encode_skip: r.encode_skip,
  });

  test("書いた行を FTS5 で引け、ID の上位が録画の ID", () => {
    const r = addRecording(3, { ts_path: join(config.rawDir, "a.m2ts") });
    expect(
      writeCaptionIndex(snapshotOf(r), {
        state: "done",
        lines: [
          { at_ms: 1000, language: 1, text: "東京都の 天気" },
          { at_ms: 2000, language: 1, text: "雨です" },
        ],
      }),
    ).toBe(true);
    expect(match("東京都の天気")).toEqual([captionLineId(3, 0)]);
    expect(recordingOfLine(captionLineId(3, 1))).toBe(3);
    // 書き直すと古い行は消える
    writeCaptionIndex(snapshotOf(r), {
      state: "done",
      lines: [{ at_ms: 5000, language: 1, text: "晴れです" }],
    });
    expect(match("天気")).toEqual([]);
    expect(match("晴れ")).toEqual([captionLineId(3, 0)]);
    dropCaptionIndex(3);
    expect(match("晴れ")).toEqual([]);
    expect(orm().select().from(captionIndex).all()).toEqual([]);
  });

  test("読んでいる間に録画の行が変わっていれば書かない", () => {
    const r = addRecording(4, { ts_path: join(config.rawDir, "b.m2ts") });
    const snapshot = snapshotOf(r);
    orm()
      .update(recordings)
      .set({ library_path: join(config.encodedDir, "b.mkv") })
      .where(eq(recordings.id, 4))
      .run();
    expect(
      writeCaptionIndex(snapshot, {
        state: "done",
        lines: [{ at_ms: 0, language: 1, text: "字幕" }],
      }),
    ).toBe(false);
    orm()
      .insert(encodeJobs)
      .values({ recording_id: 4, created_at: START })
      .run();
    expect(
      writeCaptionIndex(
        snapshotOf({ ...r, library_path: join(config.encodedDir, "b.mkv") }),
        {
          state: "done",
          lines: [],
        },
      ),
    ).toBe(false);
    orm()
      .update(recordings)
      .set({ deleted_at: START })
      .where(eq(recordings.id, 4))
      .run();
    orm().delete(encodeJobs).run();
    expect(
      writeCaptionIndex(
        snapshotOf({ ...r, library_path: join(config.encodedDir, "b.mkv") }),
        {
          state: "done",
          lines: [],
        },
      ),
    ).toBe(false);
    expect(match("字幕")).toEqual([]);
  });

  test("読めなければ間を延ばして読み直し、5 回で諦める", () => {
    const r = addRecording(5, { ts_path: join(config.rawDir, "c.m2ts") });
    const retries: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      writeCaptionIndex(snapshotOf(r), { state: "failed", error: "時間切れ" });
      const row = orm().select().from(captionIndex).get()!;
      retries.push(
        row.retry_at === null
          ? null
          : Math.round((row.retry_at - row.updated_at) / (60 * MIN)),
      );
    }
    expect(retries).toEqual([6, 12, 24, 48, null]);
  });

  test("録画の行が無くなったものを片付ける", () => {
    const r = addRecording(6, { ts_path: join(config.rawDir, "d.m2ts") });
    writeCaptionIndex(snapshotOf(r), {
      state: "done",
      lines: [{ at_ms: 0, language: 1, text: "片付け" }],
    });
    orm().delete(recordings).run();
    expect(pruneCaptionIndex()).toBe(1);
    expect(match("片付け")).toEqual([]);
    expect(orm().select().from(captionLines).all()).toEqual([]);
  });

  test("作り方のバージョンが違えば全部消す", () => {
    const r = addRecording(7, { ts_path: join(config.rawDir, "e.m2ts") });
    writeCaptionIndex(snapshotOf(r), {
      state: "done",
      lines: [{ at_ms: 0, language: 1, text: "古い字幕" }],
    });
    expect(wipeOldVersion()).toBe(false);
    orm()
      .update(captionIndex)
      .set({ version: CAPTION_INDEX_VERSION - 1 })
      .run();
    expect(wipeOldVersion()).toBe(true);
    expect(match("古い")).toEqual([]);
    expect(orm().select().from(captionLines).all()).toEqual([]);
  });
});

describe("次に読む録画", () => {
  const settled = START + 30 * MIN + 10 * MIN;

  test("録り終えて間もない・エンコードを待っている・4K の局の元の録画・ファイルの無い録画は読まない", () => {
    addRecording(10, {
      ts_path: join(config.rawDir, "f.m2ts"),
      finished_at: settled - MIN,
    });
    addRecording(11, { ts_path: join(config.rawDir, "g.m2ts") });
    orm()
      .insert(encodeJobs)
      .values({ recording_id: 11, created_at: START })
      .run();
    addRecording(12, { ts_path: join(config.rawDir, "h.mmts") });
    addRecording(13, { finished_at: START });
    addRecording(14, { ts_path: join(config.rawDir, "i.m2ts") });
    expect(nextRecording(settled)?.id).toBe(14);
    expect(pendingCaptionIndex(settled)).toBe(1);
  });

  test("読んだときとファイルの列が違えば読み直す", () => {
    const r = addRecording(20, { ts_path: join(config.rawDir, "j.m2ts") });
    writeCaptionIndex(
      { id: 20, library_path: null, ts_path: r.ts_path, encode_skip: null },
      { state: "done", lines: [] },
    );
    expect(nextRecording(settled)).toBeUndefined();
    orm()
      .update(recordings)
      .set({ library_path: join(config.encodedDir, "j.mkv"), encode_skip: 3 })
      .where(eq(recordings.id, 20))
      .run();
    expect(nextRecording(settled)?.id).toBe(20);
  });
});

describe("1 本読む", () => {
  const MKV = join(config.encodedDir, "k.mkv");
  writeFileSync(
    MKV,
    captionMkv([
      [0, management()],
      [7_000, text(encodeAribText("字幕です"))],
      [9_000, text([0x0c])],
    ]),
  );

  function fake(body: string[]): void {
    const path = join(dir, `ffmpeg-${Math.random()}`);
    writeFileSync(path, ["#!/bin/sh", ...body, ""].join("\n"));
    chmodSync(path, 0o755);
    config.ffmpeg = path;
  }

  test("エンコード済みから読み、元の TS の物差しで入れる", async () => {
    fake([`cat "${MKV}"`]);
    const r = addRecording(30, { library_path: MKV, encode_skip: 5 });
    await indexRecording(r);
    const row = orm().select().from(captionIndex).get()!;
    expect(row.state).toBe("done");
    expect(row.library_path).toBe(MKV);
    const lines = orm().select().from(captionLines).all();
    expect(lines.map((l) => l.text)).toContain("字幕です");
    expect(lines.find((l) => l.text === "字幕です")?.at_ms).toBe(12_000);
    expect(match("字幕です").length).toBe(1);
  });

  test("字幕のストリームが無ければ字幕なし (読み直さない)", async () => {
    fake(["echo \"Stream map '0:s:0' matches no streams.\" >&2", "exit 1"]);
    const r = addRecording(31, { library_path: MKV });
    await indexRecording(r);
    const row = orm().select().from(captionIndex).get()!;
    expect(row.state).toBe("missing");
    expect(row.retry_at).toBeNull();
  });

  test("置き場にファイルが無ければ読まずに後で見直す", async () => {
    const r = addRecording(32, {
      library_path: join(config.encodedDir, "none.mkv"),
    });
    await indexRecording(r);
    const row = orm().select().from(captionIndex).get()!;
    expect(row.state).toBe("waiting");
    expect(row.retry_at).not.toBeNull();
  });
});
