import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Fmp4Sample } from "#lib/ts/fmp4.js";
import { MkvDemuxer } from "#lib/ts/mkv-media.js";
import { mkvFromClip } from "../../../tests/fake/mkv-clip";
import type { Fmp4Video } from "./fmp4";
import { MkvInput } from "./mkv";

/**
 * **尻まで読んだら、待たせているコマを出しきる** (`finish`)。dts を起こすために数コマ待たせるので、
 * 出しきらないと最後の数コマがデコードされないまま終わる。
 * 流すのは作り置きの fMP4 から組んだ Matroska (`tests/fake/mkv-clip.ts`。映像はトラック 1)
 */
const av1 = mkvFromClip(
  new Uint8Array(
    readFileSync(new URL("../../../tests/fake/live-av1.mp4", import.meta.url)),
  ),
  3,
);
const videoAt = new MkvDemuxer()
  .feed(av1)
  .blocks.filter((b) => b.track === 1)
  .map((b) => b.at);

/** 渡されたコマを控えるだけの受け手 (`Fmp4Video` のメソッドのうち、MkvInput が使うものだけ) */
function receiver() {
  const video: Fmp4Sample[] = [];
  const target = {
    configure: () => {},
    push: (samples: readonly Fmp4Sample[]) => {
      video.push(...samples.filter((s) => s.track === 1));
    },
  } as unknown as Fmp4Video;
  return { video, input: new MkvInput(target) };
}

describe("MkvInput", () => {
  test("読んでいる間は数コマ待たせ、尻まで読んだら残りを出しきる", () => {
    const { video, input } = receiver();
    input.feed(av1);
    expect(videoAt.length).toBeGreaterThan(10);
    // 先のコマを見るまで待たせているぶんが、まだ渡っていない
    expect(video.length).toBeLessThan(videoAt.length);

    input.finish();
    expect(video.map((s) => s.pts)).toEqual(videoAt);
    for (const [i, sample] of video.entries()) {
      expect(sample.dts).toBeLessThanOrEqual(sample.pts);
      if (i > 0) expect(sample.dts).toBeGreaterThanOrEqual(video[i - 1]!.dts);
    }

    // 2度言われても同じものは出さない
    input.finish();
    expect(video.length).toBe(videoAt.length);
  });

  test("飛んだら (reset) 待たせていたものは捨てる", () => {
    const { video, input } = receiver();
    input.feed(av1);
    const before = video.length;
    input.reset();
    input.finish();
    expect(video.length).toBe(before);
  });
});
