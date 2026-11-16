import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { mkvFromClip } from "../../../tests/fake/mkv-clip";
import { cleanFrom } from "./clean-start";

/**
 * 作り置きの fMP4 (x264 がエンコードした H.264。キーフレームはどれも IDR) から組んだ Matroska で確かめる
 * (`tests/fake/mkv-clip.ts`)。IDR でないキーフレームは、先頭のほかの IDR のスライスを IDR でない種類 (1) に書き換えて作る
 * (MediaCodec のエンコーダが、印を付けた IDR でないコマを返したときの形)
 */
const clip = new Uint8Array(
  readFileSync(new URL("../../../tests/fake/live-h264.mp4", import.meta.url)),
);

/** 長さ 4 バイトの NAL の並びの、IDR のスライス (5) を IDR でないスライス (1) にする */
function notIdr(data: Uint8Array): Uint8Array {
  const out = data.slice();
  let at = 0;
  while (at + 4 < out.length) {
    const size = new DataView(out.buffer).getUint32(at);
    if ((out[at + 4]! & 0x1f) === 5) out[at + 4] = (out[at + 4]! & 0xe0) | 1;
    at += 4 + size;
  }
  return out;
}

const dir = mkdtempSync(`${tmpdir()}/clean-start-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const idr = `${dir}/idr.mkv`;
writeFileSync(idr, mkvFromClip(clip, 6));
const broken = `${dir}/broken.mkv`;
writeFileSync(
  broken,
  mkvFromClip(clip, 6, "主音声", (data, at) => (at > 0 ? notIdr(data) : data)),
);

describe("cleanFrom", () => {
  test("手前のキーフレームが IDR なら、そのまま返す", async () => {
    expect(await cleanFrom(idr, 4.9)).toBe(4.9);
    expect(await cleanFrom(idr, 0)).toBe(0);
  });

  test("手前のキーフレームが IDR でなければ、手前の IDR の少し後ろ (ffmpeg がその IDR を選ぶ時刻) を返す", async () => {
    const start = await cleanFrom(broken, 4.9);
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThanOrEqual(0.5);
  });

  test("Matroska でないファイルなら、そのまま返す", async () => {
    const text = `${dir}/text.mkv`;
    writeFileSync(text, "not a matroska");
    expect(await cleanFrom(text, 12)).toBe(12);
    expect(await cleanFrom(`${dir}/missing.mkv`, 12)).toBe(12);
  });
});
