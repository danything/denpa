import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captionMkv,
  encodeAribText,
  management,
  text,
} from "@danything/arib/synth-caption";

import { config } from "./config";
import { extractCaptions } from "./recording-captions";

/**
 * 録画の字幕の取り出し (`recording-captions.ts`)。ffmpeg は偽物 (sh) に差し替え、
 * 字幕が無いときと失敗したときを分けるかを見る (字幕で探すインデックスは、字幕の無い録画を読み直さない)
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-reccap-"));
const realFfmpeg = config.ffmpeg;
afterAll(() => {
  config.ffmpeg = realFfmpeg;
  rmSync(dir, { recursive: true, force: true });
});

const MKV = join(dir, "captions.mkv");
writeFileSync(
  MKV,
  captionMkv([
    [0, management()],
    [40, text(encodeAribText("字幕"))],
    [3000, text([0x0c])],
  ]),
);

/** 偽の ffmpeg。`body` を sh で流す */
function fake(name: string, body: string[]): void {
  const path = join(dir, name);
  writeFileSync(path, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(path, 0o755);
  config.ffmpeg = path;
}

const source = (encoded: boolean) => ({
  kind: "ffmpeg" as const,
  argv: [] as string[],
  path: MKV,
  encoded,
});

describe("録画の字幕を取り出す", () => {
  test("ffmpeg が写した字幕をデコードする", async () => {
    fake("ok", [`cat "${MKV}"`]);
    const result = await extractCaptions(source(true));
    expect(result.kind).toBe("pages");
    if (result.kind !== "pages") return;
    expect(result.pages.pages.length).toBeGreaterThan(0);
  });

  test("字幕のストリームが無いのは字幕なし (失敗にしない)", async () => {
    fake("none", [
      "echo \"Stream map '0:s:0' matches no streams.\" >&2",
      "exit 1",
    ]);
    expect(await extractCaptions(source(true))).toEqual({ kind: "missing" });
  });

  test("何も写さずに終われば字幕なし", async () => {
    fake("empty", ["exit 0"]);
    expect(await extractCaptions(source(false))).toEqual({ kind: "missing" });
  });

  test("ほかの理由で終われば失敗 (読み直せば読めるかもしれない)", async () => {
    fake("broken", ["echo 'Invalid data found' >&2", "exit 1"]);
    const result = await extractCaptions(source(true));
    expect(result.kind).toBe("failed");
  });

  test("ffmpeg を起こせなければ失敗", async () => {
    config.ffmpeg = join(dir, "no-such-ffmpeg");
    expect((await extractCaptions(source(true))).kind).toBe("failed");
  });

  test("止める合図で ffmpeg を止め、失敗にする", async () => {
    fake("slow", ["sleep 30"]);
    const abort = new AbortController();
    const pending = extractCaptions(source(false), { signal: abort.signal });
    abort.abort();
    expect((await pending).kind).toBe("failed");
  });

  test("4K の局の隣に置いた文字の配置を読む", async () => {
    const path = join(dir, "x.captions.json");
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        pages: [
          {
            at: 1,
            page: { v: 1, plane: [960, 540], duration: null, runs: [] },
          },
        ],
      }),
    );
    expect(
      (await extractCaptions({ kind: "sidecar", path, encoded: true })).kind,
    ).toBe("pages");
    writeFileSync(path, JSON.stringify({ v: 1, pages: [] }));
    expect(
      await extractCaptions({ kind: "sidecar", path, encoded: true }),
    ).toEqual({ kind: "missing" });
    expect(
      (
        await extractCaptions({
          kind: "sidecar",
          path: join(dir, "missing.json"),
          encoded: true,
        })
      ).kind,
    ).toBe("failed");
  });
});
