import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Fmp4Sample } from "#lib/ts/fmp4.js";
import { MkvDemuxer } from "#lib/ts/mkv-media.js";

import { mkvFromClip } from "../../../tests/fake/mkv-clip";
import { type Fmp4Video, jumped } from "./fmp4";
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

  /*
   * **B フレームのある H.264 (x264 の既定) で、dts が1コマずつ進む。** 29.97 コマ・160x90・3秒を
   * x264 の medium (録画を H.264 でエンコードするときと同じ。`server/encoder.ts`) で焼いた Matroska
   * (`tests/fake/x264-bframes.mkv`)。作り方:
   *
   *     ffmpeg -f lavfi -i testsrc2=size=160x90:rate=30000/1001 -t 3 \
   *       -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p -an -f matroska x264-bframes.mkv
   *
   * 先の数枚の最小をそのまま dts にしていた頃は、dts が止まったり跳んだりして受け取る側が「時刻が飛んだ」と
   * 見なし (`jumped`)、90 コマ中 86 コマをキーフレームまで捨てていた (iPhone で真っ黒のまま音だけ進んだ)
   */
  test("B フレームがあっても dts は1コマずつ進み、受け取る側に捨てられない", () => {
    const mkv = new Uint8Array(
      readFileSync(
        new URL("../../../tests/fake/x264-bframes.mkv", import.meta.url),
      ),
    );
    const video: Fmp4Sample[] = [];
    const target = {
      configure: () => {},
      push: (samples: readonly Fmp4Sample[]) => {
        video.push(...samples);
      },
    } as unknown as Fmp4Video;
    const input = new MkvInput(target);
    input.feed(mkv);
    input.finish();
    expect(video.length).toBe(90);
    // 見せる順と違う (B フレームがある) ことを先に確かめる。無ければこの試験は何も見ていない
    expect(video.some((s, i) => i > 0 && s.pts < video[i - 1]!.pts)).toBe(true);
    // 時刻の刻みは 1ms。90kHz に直してから比べる (`Fmp4Video.push`)
    const ticks = (ms: number) => Math.round(ms * 90);
    for (const [i, sample] of video.entries()) {
      expect(sample.dts).toBeLessThanOrEqual(sample.pts);
      if (i === 0) continue;
      const before = video[i - 1]!;
      expect(
        jumped(
          ticks(before.dts + before.duration),
          ticks(sample.dts),
          ticks(sample.duration),
        ),
      ).toBe(false);
    }
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
