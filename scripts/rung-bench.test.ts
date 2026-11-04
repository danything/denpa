import { describe, expect, test } from "bun:test";

import type { LiveHw } from "../src/lib/server/hwenc";
import { videoArgs } from "../src/lib/server/live";
import { benchVideo, readBench } from "./rung-bench";

/**
 * **測る引数が本物とずれていないか。** `rung-bench.ts` はイメージの中で依存を読めないので、段の映像の引数を自分で組む。
 * `live.ts` の `videoArgs` と同じものかをここで確かめる
 */
describe("段を下げた変換を測るスクリプト", () => {
  const rkmpp: LiveHw = {
    way: { device: "/dev/mpp_service", kind: "rkmpp" },
    full: false,
  };

  for (const interlaced of [true, false]) {
    for (const rung of [1, 2, 3] as const) {
      test(`${interlaced ? "放送" : "エンコード済み"}の段 ${rung} は videoArgs と同じ`, () => {
        for (const [codec, encoder] of [
          ["hevc", "hevc_rkmpp"],
          ["h264", "h264_rkmpp"],
        ] as const) {
          const real = videoArgs(codec, rkmpp, interlaced, rung);
          const bench = benchVideo(encoder, interlaced, rung);
          expect(bench.filter).toBe(real.filter);
          expect(["-c:v", ...bench.encoder]).toEqual(real.encoder);
        }
        const x264 = videoArgs("h264", null, interlaced, rung);
        const bench = benchVideo("libx264", interlaced, rung);
        expect(bench.filter).toBe(x264.filter);
        expect(["-c:v", ...bench.encoder]).toEqual(x264.encoder);
      });
    }
  }

  test("ffmpeg の -benchmark と進み具合の行を読む", () => {
    const stderr = [
      "frame=  450 fps= 90 q=-0.0 size=N/A time=00:00:15.01 bitrate=N/A speed=3.0x",
      "frame=  899 fps= 89 q=-0.0 Lsize=N/A time=00:00:30.00 bitrate=N/A speed=2.98x",
      "bench: utime=12.500s stime=0.500s rtime=10.000s",
    ].join("\n");
    expect(readBench(stderr)).toEqual({
      frames: 899,
      utime: 12.5,
      stime: 0.5,
      rtime: 10,
    });
    expect(readBench("frame= 1")).toBeNull();
  });
});
