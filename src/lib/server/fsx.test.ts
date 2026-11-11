import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-fsx-"));
config.encodedDir = join(root, "encoded");

const { pruneEmptyDirs } = await import("./fsx");

test("空になったフォルダを畳むのは置き場の中だけ。置き場そのものは残す", () => {
  const series = join(config.encodedDir, "シリーズ", "S1");
  mkdirSync(series, { recursive: true });
  pruneEmptyDirs(join(series, "x.mkv"));
  expect(existsSync(join(config.encodedDir, "シリーズ"))).toBe(false);
  expect(existsSync(config.encodedDir)).toBe(true);
});

test("名前の先頭が置き場と同じだけの隣のフォルダには触らない", () => {
  const beside = join(root, "encoded-old", "S");
  mkdirSync(beside, { recursive: true });
  pruneEmptyDirs(join(beside, "x.mkv"));
  expect(existsSync(beside)).toBe(true);
});
