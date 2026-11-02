import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
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

import type { HwDevice } from "./hwenc";

/**
 * **GPU のエンコーダは録画とライブで別々** (`settings().liveHwAllow`)。ライブ・追っかけ・その場の変換
 * (`live.pickLiveHw`。`playback.ts` の `withFallback` もこれを呼ぶ) と、その場の変換の本数の見立て
 * (`transcode.gpuReady`) はライブの印だけを見て、録画の印 (`hwAllow`) は見ない。DB は一時ファイルへ
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-live-hw-"));
const { config } = await import("./config");
const before = config.dbPath;
config.dbPath = join(dir, "denpa.db");
afterAll(() => {
  config.dbPath = before;
  rmSync(dir, { recursive: true, force: true });
});

const { saveSettings, settings } = await import("./settings");
const { pickLiveHw } = await import("./live");
const { gpuReady } = await import("./transcode");
const { bootstrap, MIGRATIONS } = await import("./db");

const A: HwDevice = {
  path: "/dev/dri/renderD128",
  label: "A",
  vaapi: ["h264", "av1"],
  rkmpp: [],
  nvenc: [],
  cqp: [],
  full: [],
};
const B: HwDevice = { ...A, path: "/dev/dri/renderD129", label: "B" };
const only = (codecs: ("av1" | "h264")[]) => ({
  vaapi: codecs,
  rkmpp: [],
  nvenc: [],
});

test("ライブは録画と別の GPU を使える。録画の印は見ない", () => {
  // 録画は A だけ、ライブは B だけ
  saveSettings({
    hwAllow: { [A.path]: only(["av1", "h264"]), [B.path]: only([]) },
    liveHwAllow: { [A.path]: only([]), [B.path]: only(["av1", "h264"]) },
  });
  for (const codec of ["h264", "av1"] as const) {
    expect(pickLiveHw(codec, true, [A, B])?.way.device).toBe(B.path);
  }
});

test("ライブの印を全部外せばソフトウェア。録画の印が付いていても GPU に載らず、本数の見立ても GPU 無し", () => {
  saveSettings({
    hwAllow: { [A.path]: only(["av1", "h264"]) },
    liveHwAllow: { [A.path]: only([]) },
  });
  expect(pickLiveHw("h264", true, [A])).toBeNull();
  expect(pickLiveHw("av1", false, [A])).toBeNull();
  expect(gpuReady([A])).toBe(false);
});

test("録画の印を外しても、ライブの印が付いていれば GPU に載り、本数の見立ても GPU あり", () => {
  saveSettings({
    hwAllow: { [A.path]: only([]) },
    liveHwAllow: { [A.path]: only(["h264"]) },
  });
  expect(pickLiveHw("h264", true, [A])?.way.device).toBe(A.path);
  expect(pickLiveHw("av1", true, [A])).toBeNull();
  expect(gpuReady([A])).toBe(true);
  expect(settings().hwAllow[A.path]?.vaapi).toEqual([]);
});

/**
 * **上げたときはライブも録画と同じ選び方から始める** (`0026_live-hw-allow`)。一度流れると戻せないので、
 * 0025 までの DB に行を入れてから本物の手順 (`bootstrap`) で上げて確かめる
 */
function migratedFrom(rows: [string, string][]): unknown[] {
  const old = mkdtempSync(join(tmpdir(), "denpa-live-hw-migrate-"));
  cpSync(MIGRATIONS, old, { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(old, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < "0026",
  );
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  const db = new Database(":memory:");
  migrate(drizzle({ client: db }), { migrationsFolder: old });
  const insert = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 7000)",
  );
  for (const [key, value] of rows) insert.run(key, value);
  bootstrap(db);
  rmSync(old, { recursive: true, force: true });
  return db
    .query(
      "SELECT key, value, updated_at FROM settings WHERE key IN ('hwAllow', 'liveHwAllow') ORDER BY key",
    )
    .all();
}

test("上げると録画の印をライブへ写す", () => {
  const allow = JSON.stringify({ [A.path]: only(["av1"]) });
  expect(migratedFrom([["hwAllow", allow]])).toEqual([
    { key: "hwAllow", value: allow, updated_at: 7000 },
    { key: "liveHwAllow", value: allow, updated_at: 7000 },
  ]);
});

test("録画の印が無ければ何も足さない (どちらも全部よいのまま)", () => {
  expect(migratedFrom([])).toEqual([]);
});
