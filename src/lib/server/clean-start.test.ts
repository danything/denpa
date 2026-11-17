import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { mkvFromClip } from "../../../tests/fake/mkv-clip";
import { cleanFrom } from "./clean-start";

/**
 * 作り置きの fMP4 (x264 がエンコードした H.264。キーフレームはどれも IDR) から組んだ Matroska で確かめる
 * (`tests/fake/mkv-clip.ts`)。始められないキーフレームは、先頭のほかの IDR のスライスを IDR でない P に書き換えて作る
 * (MediaCodec のエンコーダが、intra-refresh の回復点に印を付けて返したときの形)
 */
const clip = new Uint8Array(
  readFileSync(new URL("../../../tests/fake/live-h264.mp4", import.meta.url)),
);

/**
 * 長さ 4 バイトの NAL の並びの、IDR のスライス (5) を IDR でない P のスライスにする。
 * x264 のスライスの先頭は `0x88` (first_mb_in_slice 0・slice_type 7 の I) なので、`0x89` (slice_type 8 の SP。I でない) にする
 */
function notStartable(data: Uint8Array): Uint8Array {
  const out = data.slice();
  let at = 0;
  while (at + 4 < out.length) {
    const size = new DataView(out.buffer).getUint32(at);
    if ((out[at + 4]! & 0x1f) === 5) {
      out[at + 4] = (out[at + 4]! & 0xe0) | 1;
      if (out[at + 5] === 0x88) out[at + 5] = 0x89;
    }
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
  mkvFromClip(clip, 6, "主音声", (data, at) =>
    at > 0 ? notStartable(data) : data,
  ),
);
/** 先頭のほかに始められるキーフレームが無く、20 秒より長いもの */
const long = `${dir}/long.mkv`;
writeFileSync(
  long,
  mkvFromClip(clip, 75, "主音声", (data, at) =>
    at > 0 ? notStartable(data) : data,
  ),
);

describe("cleanFrom", () => {
  test("手前のキーフレームから始められるなら、そのまま返し、印を直す", async () => {
    expect(await cleanFrom(idr, 4.9)).toEqual({
      from: 4.9,
      marks: { codec: "h264", lengthSize: 4 },
      missing: false,
    });
    expect((await cleanFrom(idr, 0)).from).toBe(0);
  });

  test("手前のキーフレームが P なら、手前の IDR の少し後ろ (ffmpeg がその IDR を選ぶ時刻) を返す", async () => {
    const start = await cleanFrom(broken, 4.9);
    expect(start.from).toBeGreaterThan(0);
    expect(start.from).toBeLessThanOrEqual(0.5);
    expect(start.missing).toBe(false);
  });

  test("手前 20 秒に始められるキーフレームが無ければ missing。変換は手前から読む", async () => {
    const start = await cleanFrom(long, 70);
    expect(start).toMatchObject({ from: 70, missing: true });
    if (!start.missing) throw new Error("missing のはず");
    expect(start.decodeFrom).toBeLessThan(70);
    expect(start.decodeFrom).toBeGreaterThan(60);
    // 20 秒の中に先頭の IDR があれば寄せる
    expect((await cleanFrom(long, 15)).missing).toBe(false);
  });

  test("Matroska でないファイルなら、そのまま返し、印も直さない", async () => {
    const text = `${dir}/text.mkv`;
    writeFileSync(text, "not a matroska");
    const asIs = { missing: false as const, from: 12, marks: null };
    expect(await cleanFrom(text, 12)).toEqual(asIs);
    expect(await cleanFrom(`${dir}/missing.mkv`, 12)).toEqual(asIs);
  });
});
