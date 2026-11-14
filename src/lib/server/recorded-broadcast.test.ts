import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  packetize,
  patSection,
  programMap,
  stream,
} from "@danything/arib/synth";

import { headVideo, recordedBroadcast } from "./recorded-broadcast";

/**
 * **録画の放送のコーデック** (`recorded-broadcast.ts`)。TS の録画は先頭の PMT の映像で、TS で送る 4K の局 (HEVC) を見分ける。
 * 録画は合成した TS を一時ファイルに書く
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-recorded-broadcast-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SERVICE = 0x0400;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x100;

/** 映像の PID に空のパケットを `count` 個 */
function filler(count: number): Uint8Array {
  return stream(
    ...Array.from({ length: count }, () =>
      packetize(VIDEO_PID, new Uint8Array(10)),
    ),
  );
}

/** PAT と、映像の stream_type が `video` の PMT */
function head(video: number): Uint8Array {
  return stream(
    packetize(0x0000, patSection([[SERVICE, PMT_PID]])),
    packetize(
      PMT_PID,
      programMap(SERVICE, VIDEO_PID, [
        [video, VIDEO_PID],
        [0x0f, 0x110],
      ]),
    ),
  );
}

let files = 0;
/** 録画のファイルを書いてパスを返す */
function recording(bytes: Uint8Array, ext = ".m2ts"): string {
  const path = join(dir, `rec-${files++}${ext}`);
  writeFileSync(path, bytes);
  return path;
}

describe("録画の放送のコーデック (recordedBroadcast)", () => {
  test("PMT の映像が HEVC の TS は 4K の局 (hevc)。MPEG-2 なら mpeg2", () => {
    expect(
      recordedBroadcast(recording(stream(filler(3), head(0x24))), SERVICE),
    ).toBe("hevc");
    expect(recordedBroadcast(recording(head(0x02)), SERVICE)).toBe("mpeg2");
    // H.264 の局も 4K の局ではない
    expect(recordedBroadcast(recording(head(0x1b)), SERVICE)).toBe("mpeg2");
  });

  test("4K の局の録画 (.mmts) は中身を読まずに hevc", () => {
    expect(recordedBroadcast(join(dir, "missing.mmts"), SERVICE)).toBe("hevc");
  });

  test("PMT がまだ無い・ファイルが無い・放送の番号が分からなければ mpeg2", () => {
    expect(recordedBroadcast(recording(filler(5)), SERVICE)).toBe("mpeg2");
    expect(recordedBroadcast(join(dir, "missing.m2ts"), SERVICE)).toBe("mpeg2");
    expect(recordedBroadcast(recording(head(0x24)), 0)).toBe("mpeg2");
    // ほかの局の PMT では決めない
    expect(recordedBroadcast(recording(head(0x24)), SERVICE + 1)).toBe("mpeg2");
  });

  test("PMT がまだ無かった録画は覚えず、書き足されたら読み直す", () => {
    const path = recording(filler(5));
    expect(recordedBroadcast(path, SERVICE)).toBe("mpeg2");
    writeFileSync(path, stream(filler(5), head(0x24)));
    expect(recordedBroadcast(path, SERVICE)).toBe("hevc");
  });

  test("読んで決まった答えは覚える (同じ録画は読み直さない)", () => {
    const path = recording(head(0x24));
    expect(recordedBroadcast(path, SERVICE)).toBe("hevc");
    rmSync(path);
    expect(recordedBroadcast(path, SERVICE)).toBe("hevc");
  });

  test("読むのは先頭の決まった量まで。その先の PMT は見ない", () => {
    const path = recording(stream(filler(20), head(0x24)));
    expect(headVideo(path, SERVICE, 188 * 10)).toBeUndefined();
    expect(headVideo(path, SERVICE)).toBe("hevc");
  });
});
