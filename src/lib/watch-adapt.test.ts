import { describe, expect, test } from "bun:test";

import type { AdaptDecision } from "./adapt";
import { busyNote, type Pace } from "./rungs";
import {
  autoLabel,
  fileIdle,
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

/** **ファイルの直再生で、ブラウザが読むのを止めているか** (`fileIdle`)。読み終えたときだけ足りている印にする */
describe("読むのを止めているか (fileIdle)", () => {
  const LOADING = 2;
  const IDLE = 1;
  /** 0〜30 秒を読み終え、10 秒目を観ている */
  const read = {
    networkState: IDLE,
    seeking: false,
    buffered: [[0, 30]] as [number, number][],
    currentTime: 10,
  };

  test("いまの位置を読めていて、NETWORK_IDLE か直前の刻みの間に suspend が来たら止めている", () => {
    expect(fileIdle(read, Number.NEGATIVE_INFINITY, 5_000)).toBe(true);
    const loading = { ...read, networkState: LOADING };
    expect(fileIdle(loading, 4_500, 5_000)).toBe(true);
    expect(fileIdle(loading, 3_000, 5_000)).toBe(false);
    // ファイルの終わりに着いた (先は 0 秒)
    expect(fileIdle({ ...read, currentTime: 30 }, 0, 5_000)).toBe(true);
  });

  test("読み始める前の NETWORK_IDLE は、止めていると見ない (回線が細くて 1 バイトも届かなくても下げなくなる)", () => {
    expect(fileIdle({ ...read, buffered: [], currentTime: 0 }, 0, 5_000)).toBe(
      false,
    );
  });

  test("読んでいない先へ飛んだ直後と、飛んでいる最中は止めていると見ない", () => {
    expect(fileIdle({ ...read, currentTime: 600 }, 0, 5_000)).toBe(false);
    expect(fileIdle({ ...read, seeking: true }, 0, 5_000)).toBe(false);
  });

  test("先頭は、映像と音声の始まりのずれのぶん後ろから読めていても数える", () => {
    expect(
      fileIdle({ ...read, buffered: [[0.03, 30]], currentTime: 0 }, 0, 5_000),
    ).toBe(true);
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

  test("止めている間は刻まず、動き出したら測り直す (止めていた間のバッファを回線のぶんと読まない)", async () => {
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

  test("その場の変換が実時間の 1.2 倍でしか出ず、受け取りの速さが段に足りなくても、サーバが ffmpeg を待っていれば下げない", async () => {
    // 段 1 (3.096 Mbit/s) の 1.2 倍。× 0.7 では段 1 に届かない
    const h = harness({ current: 1, paceId: "a", throughput: 3_715_200 });
    h.pace({ backlog: 0, dropped: 0, speed: 1.2, wait: 0.8 });
    await h.run(30_000);
    expect(h.decided).toEqual([]);
    // 割合を返さないサーバなら、これまでどおり下げる
    const old = harness({ current: 1, paceId: "a", throughput: 3_715_200 });
    old.pace({ backlog: 0, dropped: 0, speed: 1.2 });
    await old.run(30_000);
    expect(old.decided[0]).toEqual({ step: 2, reason: "slow" });
  });

  test("別のストリームに替わったら、前のストリームの具合は使わずにすぐ読み直す", async () => {
    const h = harness({ current: 1, paceId: "a" });
    await h.run(1000);
    h.set({ paceId: "b" });
    await h.run(1000);
    expect(h.reads).toEqual(["a", "b"]);
  });
});
