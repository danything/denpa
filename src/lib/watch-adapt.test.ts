import { describe, expect, test } from "bun:test";

import type { AdaptDecision } from "./adapt";
import type { Pace } from "./rungs";
import {
  autoLabel,
  busyNote,
  rungQuery,
  watchAdapt,
  type WatchSample,
} from "./watch-adapt";

describe("画面に出すもの", () => {
  test("メニューの「自動」の行に、段を下げている間だけ形式と高さを添える", () => {
    expect(autoLabel(0, "h264")).toBe("自動");
    expect(autoLabel(2, "h264")).toBe("自動 (H.264 540p)");
    expect(autoLabel(1, "hevc")).toBe("自動 (H.265 720p)");
    // 応答を受ける前はコーデックが分からない
    expect(autoLabel(3, null)).toBe("自動 (360p)");
    expect(autoLabel("audio", "audio")).toBe("自動 (音声だけ)");
  });

  test("サーバが混んでいて替えられなかったときは、下げようとしたか上げようとしたかを書く", () => {
    expect(busyNote(true)).toBe(
      "サーバが混んでいるため、画質を下げられませんでした",
    );
  });

  test("段を下げたリクエストには段と端末が再生できるコーデックを足す。段 0 は足さない", () => {
    expect(rungQuery(2, ["av1", "h264"])).toBe("&rung=2&playable=av1,h264");
    expect(rungQuery(0, ["av1", "h264"])).toBe("");
  });
});

/** 時計を進めながら刻む観る画面の真似 */
function harness(sample: Partial<WatchSample> = {}) {
  let now = 0;
  let current: WatchSample = {
    current: 0,
    manual: false,
    throughput: null,
    ahead: 30,
    waiting: false,
    paceId: null,
    baseKbps: null,
    ...sample,
  };
  let shown: WatchSample | null = current;
  const decided: AdaptDecision[] = [];
  const reads: string[] = [];
  let pace: Pace | null = null;
  const adapt = watchAdapt({
    sample: () => shown,
    readPace: async (id) => {
      reads.push(id);
      return pace === null ? null : { ...pace };
    },
    decide: (decision) => decided.push(decision),
    now: () => now,
  });
  return {
    adapt,
    decided,
    reads,
    set(next: Partial<WatchSample>) {
      current = { ...current, ...next };
      shown = current;
    },
    hide() {
      shown = null;
    },
    pace(next: Pace | null) {
      pace = next;
    },
    /** `ms` だけ 1 秒ごとに刻む */
    async run(ms: number) {
      for (let t = 0; t < ms; t += 1000) {
        adapt.tick();
        // 送り出しの具合の読み出しが返るのを待つ
        await new Promise((resolve) => setTimeout(resolve, 0));
        now += 1000;
      }
    },
  };
}

describe("刻み (watchAdapt)", () => {
  test("詰まったら、立ち上がりの 3 秒を過ぎてから下げる", async () => {
    const h = harness({ waiting: true, ahead: 0 });
    await h.run(3000);
    expect(h.decided).toEqual([]);
    await h.run(1000);
    expect(h.decided).toEqual([{ step: 1, reason: "slow" }]);
  });

  test("止めている間は刻まず、動き出したら測り直す (止めていた間の溜まりを回線のぶんと読まない)", async () => {
    const h = harness();
    await h.run(5000);
    h.hide();
    await h.run(10_000);
    h.set({ waiting: true, ahead: 0 });
    await h.run(3000);
    expect(h.decided).toEqual([]);
    await h.run(1000);
    expect(h.decided).toEqual([{ step: 1, reason: "slow" }]);
  });

  test("シークのあとは 3 秒数えない", async () => {
    const h = harness();
    await h.run(5000);
    h.adapt.reset();
    h.set({ waiting: true, ahead: 0 });
    await h.run(3000);
    expect(h.decided).toEqual([]);
  });

  test("送り出しの具合は 2 秒ごとに読み、エンコードが遅れていれば段を下げずに知らせる", async () => {
    const h = harness({ current: 1, paceId: "a", waiting: true, ahead: 0 });
    h.pace({ backlog: 0, dropped: 0, speed: 0.5 });
    await h.run(8000);
    expect(h.reads).toEqual(["a", "a", "a", "a"]);
    expect(h.decided.length).toBeGreaterThan(0);
    expect(h.decided.every((d) => d.reason === "encode" && d.step === 1)).toBe(
      true,
    );
  });

  test("別のストリームに替わったら、前のストリームの具合は使わずにすぐ読み直す", async () => {
    const h = harness({ current: 1, paceId: "a" });
    await h.run(1000);
    h.set({ paceId: "b" });
    await h.run(1000);
    expect(h.reads).toEqual(["a", "b"]);
  });
});
