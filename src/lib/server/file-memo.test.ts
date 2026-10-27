import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileMemo } from "./file-memo";

/**
 * **録画の字幕を作り直さない** (`captions.json`)。抜くには ffmpeg が動画を丸ごと読み、
 * 観はじめの読み込みとディスクを取り合っていた
 */
describe("fileMemo", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-memo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, body = "a"): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  test("同じファイルなら作り直さない", async () => {
    const memo = fileMemo<number>(4);
    const path = file("same.mkv");
    let made = 0;
    const make = () => Promise.resolve(++made);
    expect(await memo.get(path, make)).toBe(1);
    expect(await memo.get(path, make)).toBe(1);
    expect(made).toBe(1);
  });

  test("作っている最中に求められたら、同じ結果を待たせる", async () => {
    const memo = fileMemo<number>(4);
    const path = file("busy.mkv");
    let made = 0;
    let finish: (value: number) => void = () => undefined;
    const make = () => {
      made++;
      return new Promise<number>((resolve) => (finish = resolve));
    };
    const first = memo.get(path, make);
    const second = memo.get(path, make);
    finish(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(made).toBe(1);
  });

  test("書き換わったら (再エンコード) 作り直す", async () => {
    const memo = fileMemo<string>(4);
    const path = file("changed.mkv", "old");
    expect(await memo.get(path, () => Promise.resolve("old"))).toBe("old");
    writeFileSync(path, "new body");
    utimesSync(path, new Date(), new Date(Date.now() + 60_000));
    expect(await memo.get(path, () => Promise.resolve("new"))).toBe("new");
  });

  test("失敗は覚えない", async () => {
    const memo = fileMemo<string>(4);
    const path = file("failed.mkv");
    await expect(
      memo.get(path, () => Promise.reject(new Error("timeout"))),
    ).rejects.toThrow("timeout");
    expect(await memo.get(path, () => Promise.resolve("ok"))).toBe("ok");
  });

  test("上限を超えたら、いちばん前に使ったものから捨てる", async () => {
    const memo = fileMemo<string>(2);
    const [a, b, c] = ["a.mkv", "b.mkv", "c.mkv"].map((name) => file(name));
    let made = 0;
    const make = (value: string) => () => {
      made++;
      return Promise.resolve(value);
    };
    await memo.get(a!, make("a"));
    await memo.get(b!, make("b"));
    // a を使い直したので、次に捨てるのは b
    await memo.get(a!, make("a"));
    await memo.get(c!, make("c"));
    expect(made).toBe(3);
    await memo.get(a!, make("a"));
    expect(made).toBe(3);
    await memo.get(b!, make("b"));
    expect(made).toBe(4);
  });

  test("ファイルが無ければ覚えずに作る", async () => {
    const memo = fileMemo<number>(4);
    let made = 0;
    const make = () => Promise.resolve(++made);
    const path = join(dir, "missing.mkv");
    await memo.get(path, make);
    await memo.get(path, make);
    expect(made).toBe(2);
  });
});
