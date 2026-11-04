import { describe, expect, test } from "bun:test";

import {
  type AdaptDecision,
  adaptNote,
  type AdaptSample,
  AUDIO_AFTER,
  BASE_GUESS_KBPS,
  ENCODE_LAG,
  GRACE,
  HOLD,
  PROBE,
  RungAdapter,
  stepLabel,
  THIN,
  UP_WAIT_LIVE,
  UP_WAIT_MOST,
  UP_WAIT_WATCH,
} from "./adapt";
import type { Pace } from "./rungs";

const calm: Omit<AdaptSample, "now"> = {
  route: "watch",
  current: 0,
  manual: false,
  throughput: null,
  ahead: 30,
  waiting: false,
  pace: null,
  baseKbps: null,
};

type Over = Partial<AdaptSample> | ((now: number) => Partial<AdaptSample>);

/** `from` から `to` まで 1 秒ごとに刻み、最初に返したものとその時刻を返す */
function first(
  adapter: RungAdapter,
  from: number,
  to: number,
  over: Over,
): { at: number; decision: AdaptDecision } | null {
  for (let now = from; now <= to; now += 1_000) {
    const o = typeof over === "function" ? over(now) : over;
    const decision = adapter.tick({ ...calm, ...o, now });
    if (decision !== null) return { at: now, decision };
  }
  return null;
}

/** 2 秒ごとに新しい `pace` を作る (サーバが送る間隔) */
function paces(make: (n: number) => Pace): (now: number) => Pace {
  const made = new Map<number, Pace>();
  return (now) => {
    const n = Math.floor(now / 2_000);
    if (!made.has(n)) made.set(n, make(n));
    return made.get(n)!;
  };
}

describe("下げる", () => {
  test("詰まったら、測った速さの 7 割から音声を引いた値に収まるいちばん高い段へ下げる", () => {
    const a = new RungAdapter();
    // 5 Mbit/s × 0.7 = 3.5 Mbit/s。段 1 (3 + 0.096 Mbit/s) が収まる
    expect(
      first(a, 0, 10_000, { waiting: true, throughput: 5_000_000 }),
    ).toEqual({ at: GRACE, decision: { step: 1, reason: "slow" } });

    // 2.5 Mbit/s × 0.7 = 1.75 Mbit/s。段 2 (1.5 + 0.096) が収まる
    const b = new RungAdapter();
    expect(
      first(b, 0, 10_000, { waiting: true, throughput: 2_500_000 })?.decision,
    ).toEqual({ step: 2, reason: "slow" });

    // どの段も収まらなければ段 3
    const c = new RungAdapter();
    expect(
      first(c, 0, 10_000, { waiting: true, throughput: 300_000 })?.decision
        .step,
    ).toBe(3);
  });

  test("速さを測れなければ 2 段下げ、段 0 からは段 1 に移る", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 10_000, { route: "live", current: 1, waiting: true })
        ?.decision.step,
    ).toBe(3);
    const b = new RungAdapter();
    expect(
      first(b, 0, 10_000, { route: "live", current: 0, waiting: true })
        ?.decision.step,
    ).toBe(1);
  });

  test("溜まりが 2 秒を切って減り続けたら、詰まる前に下げる", () => {
    const a = new RungAdapter();
    // 1 秒に 0.5 秒ずつ減る。2 秒続いて 2 秒を切った 7 秒目に下げる
    const hit = first(a, 0, 20_000, (now) => ({
      route: "live",
      current: 1,
      ahead: Math.max(0, 4.5 - (now / 1_000) * 0.5),
    }));
    expect(hit).toEqual({ at: 6_000, decision: { step: 3, reason: "slow" } });
  });

  test("遅れを詰めるために少しずつ減るだけなら下げない", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 20_000, (now) => ({
        route: "live",
        current: 1,
        ahead: 1.5 - (now / 1_000) * 0.05,
      })),
    ).toBeNull();
  });

  test("サーバの backlog が 3 秒続けて伸びたら下げる。伸びが止まれば下げない", () => {
    const a = new RungAdapter();
    const growing = paces((n) => ({
      backlog: n * 100_000,
      dropped: 0,
      speed: null,
    }));
    expect(
      first(a, 0, 20_000, (now) => ({
        route: "live",
        current: 1,
        ahead: 1,
        pace: growing(now),
      }))?.decision,
    ).toEqual({ step: 3, reason: "slow" });

    const b = new RungAdapter();
    const flat = paces(() => ({ backlog: 300_000, dropped: 0, speed: null }));
    expect(
      first(b, 0, 20_000, (now) => ({
        route: "live",
        current: 1,
        ahead: 1,
        pace: flat(now),
      })),
    ).toBeNull();
  });

  test("サーバが塊を捨てたら下げる。同じ pace の捨てた数は 1 回だけ数える", () => {
    const a = new RungAdapter();
    const pace: Pace = { backlog: 0, dropped: 2, speed: null };
    const at = (now: number) =>
      a.tick({ ...calm, route: "live", current: 1, manual: true, pace, now });
    expect(at(0)).toBeNull();
    // GRACE の間に届いた pace は、そのあとも数えない
    expect(at(GRACE)).toBeNull();
    const fresh = { ...pace };
    expect(
      a.tick({
        ...calm,
        route: "live",
        current: 1,
        manual: true,
        pace: fresh,
        now: GRACE + 1_000,
      }),
    ).toEqual({ step: 1, reason: "pinned" });
    expect(
      a.tick({
        ...calm,
        route: "live",
        current: 1,
        manual: true,
        pace: fresh,
        now: GRACE + 2_000,
      }),
    ).toBeNull();
  });
});

describe("観る画面で速さが足りないとき", () => {
  test("測った速さの 7 割がいまの段に足りない状態が 10 秒続いたら、溜まりがあっても下げる", () => {
    const a = new RungAdapter();
    // 16 Mbit/s の MPEG-2 に 20 Mbit/s × 0.7 = 14 Mbit/s では足りない
    expect(
      first(a, 0, 60_000, {
        current: 0,
        baseKbps: 16_000,
        throughput: 20_000_000,
        ahead: 50,
      }),
    ).toEqual({ at: GRACE + THIN, decision: { step: 1, reason: "slow" } });

    // 段 2 (1.596 Mbit/s) に 2 Mbit/s × 0.7 = 1.4 Mbit/s では足りない
    const b = new RungAdapter();
    expect(
      first(b, 0, 60_000, { current: 2, throughput: 2_000_000, ahead: 50 })
        ?.decision,
    ).toEqual({ step: 3, reason: "slow" });
  });

  test("段 0 のビットレートが分からなければ BASE_GUESS_KBPS と比べる", () => {
    const a = new RungAdapter();
    // 12 Mbit/s × 0.7 = 8.4 Mbit/s は 10.5 Mbit/s に足りない
    expect(
      first(a, 0, 60_000, { current: 0, throughput: 12_000_000, ahead: 50 })
        ?.at,
    ).toBe(GRACE + THIN);
    expect(BASE_GUESS_KBPS).toBe(10_500);
  });

  test("足りていれば下げず、途中で足りれば数え直す", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 60_000, {
        current: 0,
        baseKbps: 16_000,
        throughput: 25_000_000,
        ahead: 50,
      }),
    ).toBeNull();
    const b = new RungAdapter();
    expect(
      first(b, 0, 60_000, (now) => ({
        current: 0,
        baseKbps: 16_000,
        throughput: now % 8_000 === 0 ? 25_000_000 : 20_000_000,
        ahead: 50,
      })),
    ).toBeNull();
  });

  test("ライブでは速さを下げる引き金に使わない", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 60_000, {
        route: "live",
        current: 0,
        baseKbps: 16_000,
        throughput: 2_000_000,
        ahead: 1,
      }),
    ).toBeNull();
  });
});

describe("GRACE", () => {
  test("選局の直後 3 秒は詰まっても下げない", () => {
    const a = new RungAdapter();
    expect(first(a, 0, GRACE - 1_000, { waiting: true })).toBeNull();
    expect(first(a, GRACE, GRACE, { waiting: true })).not.toBeNull();
  });

  test("シークした直後も 3 秒は数えない", () => {
    const a = new RungAdapter();
    expect(first(a, 0, 5_000, {})).toBeNull();
    a.reset(6_000);
    expect(
      first(a, 6_000, 6_000 + GRACE - 1_000, { waiting: true }),
    ).toBeNull();
    expect(
      first(a, 6_000 + GRACE, 6_000 + GRACE, { waiting: true }),
    ).not.toBeNull();
  });
});

describe("行き来しない", () => {
  test("下げたあと 20 秒は、詰まっても続けて下げない", () => {
    const a = new RungAdapter();
    first(a, 0, 0, { route: "live", current: 1 });
    // 10 秒目に画面が段 2 に切り替えた
    const hit = first(a, 10_000, 60_000, {
      route: "live",
      current: 2,
      waiting: true,
    });
    expect(hit).toEqual({
      at: 10_000 + HOLD,
      decision: { step: 3, reason: "slow" },
    });
  });

  test("速さが次の段の 2 倍に届かなければ上げない", () => {
    const a = new RungAdapter();
    // 段 1 は 3.096 Mbit/s。2 倍は 6.192 Mbit/s
    expect(
      first(a, 0, 120_000, { current: 2, throughput: 6_000_000 }),
    ).toBeNull();
  });
});

describe("上げる", () => {
  test("観る画面は、次の段の 2 倍以上の速さが 20 秒続いたら 1 段上げる", () => {
    const a = new RungAdapter();
    expect(first(a, 0, 120_000, { current: 2, throughput: 6_500_000 })).toEqual(
      {
        at: GRACE + UP_WAIT_WATCH,
        decision: { step: 1, reason: "restored" },
      },
    );
  });

  test("段 0 へは、ファイルのビットレートの 2 倍以上が続いたときだけ戻す", () => {
    const a = new RungAdapter();
    // 16 Mbit/s の MPEG-2。2 倍は 32 Mbit/s
    expect(
      first(a, 0, 120_000, {
        current: 1,
        baseKbps: 16_000,
        throughput: 30_000_000,
      }),
    ).toBeNull();
    const b = new RungAdapter();
    expect(
      first(b, 0, 120_000, {
        current: 1,
        baseKbps: 16_000,
        throughput: 33_000_000,
      })?.decision,
    ).toEqual({ step: 0, reason: "restored" });
  });

  test("ライブは、溜まりが無い状態が 30 秒続いたら 1 段上げてみる", () => {
    const a = new RungAdapter();
    const clear = paces(() => ({ backlog: 0, dropped: 0, speed: null }));
    expect(
      first(a, 0, 120_000, (now) => ({
        route: "live",
        current: 2,
        ahead: 1,
        pace: clear(now),
      })),
    ).toEqual({
      at: GRACE + UP_WAIT_LIVE,
      decision: { step: 1, reason: "restored" },
    });
  });

  test("ライブで送れずに溜まっている間は上げない", () => {
    const a = new RungAdapter();
    const held = paces(() => ({ backlog: 50_000, dropped: 0, speed: null }));
    expect(
      first(a, 0, 120_000, (now) => ({
        route: "live",
        current: 2,
        ahead: 1,
        pace: held(now),
      })),
    ).toBeNull();
  });

  test("段 0 より上には上げない", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 120_000, { current: 0, throughput: 100_000_000 }),
    ).toBeNull();
  });
});

describe("待ちの倍増", () => {
  test("上げて足りなければすぐ戻し、次に上げるまでの待ちを倍にする (上限 5 分)", () => {
    const a = new RungAdapter();
    const live = { route: "live" as const, ahead: 1 };
    let now = 0;
    let current: 1 | 2 = 2;
    const waits: number[] = [];
    for (let round = 0; round < 6; round++) {
      // 上げるまで待つ
      const up = first(a, now, now + 600_000, { ...live, current });
      expect(up?.decision).toEqual({ step: 1, reason: "restored" });
      waits.push(a.upWait("live"));
      current = 1;
      // 上げた 5 秒後に詰まる。HOLD の間でもすぐ戻す
      first(a, up!.at + 1_000, up!.at + 1_000, { ...live, current });
      const back = first(a, up!.at + 5_000, up!.at + 5_000, {
        ...live,
        current,
        waiting: true,
      });
      expect(back?.decision).toEqual({ step: 2, reason: "slow" });
      current = 2;
      now = back!.at + 1_000;
    }
    expect(waits[0]).toBe(UP_WAIT_LIVE);
    expect(a.upWait("live")).toBe(UP_WAIT_MOST);
    expect(waits.slice(1)).toEqual([
      60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  test("上げて 1 分足りていれば、待ちを元に戻す", () => {
    const a = new RungAdapter();
    const live = { route: "live" as const, ahead: 1 };
    const up = first(a, 0, 120_000, { ...live, current: 2 })!;
    first(a, up.at + 1_000, up.at + 1_000, { ...live, current: 1 });
    first(a, up.at + 5_000, up.at + 5_000, {
      ...live,
      current: 1,
      waiting: true,
    });
    expect(a.upWait("live")).toBe(UP_WAIT_LIVE * 2);
    // 段 2 に戻したあと、また上げて今度は 1 分以上続いた
    first(a, up.at + 6_000, up.at + 6_000, { ...live, current: 2 });
    const again = first(a, up.at + 7_000, up.at + 600_000, {
      ...live,
      current: 2,
    })!;
    // 段 0 へ上げないように、送れずに溜まっている量を変えずに置く
    const queued: Pace = { backlog: 1, dropped: 0, speed: null };
    first(a, again.at + 1_000, again.at + PROBE + 2_000, {
      ...live,
      current: 1,
      pace: queued,
    });
    expect(a.upWait("live")).toBe(UP_WAIT_LIVE);
  });
});

describe("エンコードの遅れ", () => {
  test("エンコードが実時間に追いつかない間は、詰まっても段を下げず encode を返す", () => {
    const a = new RungAdapter();
    const slow = paces(() => ({ backlog: 0, dropped: 0, speed: 0.8 }));
    expect(
      first(a, 0, 30_000, (now) => ({
        route: "live",
        current: 0,
        waiting: true,
        ahead: 0,
        pace: slow(now),
      })),
    ).toEqual({
      at: GRACE + ENCODE_LAG,
      decision: { step: 0, reason: "encode" },
    });
  });
});

describe("手で選んでいるとき", () => {
  test("段を動かさず、足りないときに pinned だけを返す", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 10_000, {
        current: 0,
        manual: true,
        waiting: true,
        throughput: 1_000_000,
      }),
    ).toEqual({ at: GRACE, decision: { step: 0, reason: "pinned" } });
    const b = new RungAdapter();
    expect(
      first(b, 0, 120_000, {
        current: 2,
        manual: true,
        throughput: 100_000_000,
      }),
    ).toBeNull();
  });
});

describe("音声だけ", () => {
  test("段 3 でも 10 秒続けて足りなければ音声だけにする", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 60_000, { route: "live", current: 3, waiting: true }),
    ).toEqual({
      at: GRACE + AUDIO_AFTER,
      decision: { step: "audio", reason: "slow" },
    });
  });

  test("途中で足りれば数え直す", () => {
    const a = new RungAdapter();
    expect(
      first(a, 0, 60_000, (now) => ({
        route: "live",
        current: 3,
        waiting: now % 8_000 !== 0,
      })),
    ).toBeNull();
  });

  test("音声だけから、段 3 の 2 倍の速さが続けば段 3 に戻す", () => {
    const a = new RungAdapter();
    // 段 3 は 0.696 Mbit/s。2 倍は 1.392 Mbit/s
    expect(
      first(a, 0, 120_000, { current: "audio", throughput: 1_400_000 })
        ?.decision,
    ).toEqual({ step: 3, reason: "restored" });
  });
});

describe("上げてみている間", () => {
  const live = { route: "live" as const, ahead: 1 };
  // 段 0 へ上げないように、送れずに溜まっている量を変えずに置く
  const queued: Pace = { backlog: 1, dropped: 0, speed: null };

  test("手で選んだら上げてみていたことを捨て、手動を外した直後に前の段へ戻さない", () => {
    const a = new RungAdapter();
    const up = first(a, 0, 120_000, { ...live, current: 2 })!;
    first(a, up.at + 1_000, up.at + 1_000, { ...live, current: 1 });
    expect(
      first(a, up.at + 5_000, up.at + 8_000, {
        ...live,
        current: 1,
        manual: true,
      }),
    ).toBeNull();
    // 手動を外して詰まっても、HOLD の間は動かさない (上げてみて足りなかったとは見ない)
    expect(
      first(a, up.at + 9_000, up.at + 9_000, {
        ...live,
        current: 1,
        waiting: true,
      }),
    ).toBeNull();
    expect(a.upWait("live")).toBe(UP_WAIT_LIVE);
  });

  test("期限の刻みでちょうど足りなくても、待ちの倍数はその刻みで戻す", () => {
    const a = new RungAdapter();
    // 1 回失敗して待ちを倍にしておく
    const up = first(a, 0, 120_000, { ...live, current: 2 })!;
    first(a, up.at + 1_000, up.at + 1_000, { ...live, current: 1 });
    first(a, up.at + 5_000, up.at + 5_000, {
      ...live,
      current: 1,
      waiting: true,
    });
    first(a, up.at + 6_000, up.at + 6_000, { ...live, current: 2 });
    const again = first(a, up.at + 7_000, up.at + 600_000, {
      ...live,
      current: 2,
    })!;
    const switchedAt = again.at + 1_000;
    first(a, switchedAt, switchedAt + PROBE - 1_000, {
      ...live,
      current: 1,
      pace: queued,
    });
    const hit = first(a, switchedAt + PROBE, switchedAt + PROBE, {
      ...live,
      current: 1,
      waiting: true,
    });
    // 上げる前の段 (2) に戻すのではなく、ふつうに下げる
    expect(hit?.decision).toEqual({ step: 3, reason: "slow" });
    expect(a.upWait("live")).toBe(UP_WAIT_LIVE);
  });
});

describe("サーバが切り替えなかったとき", () => {
  test("refused のあと 20 秒は同じ段をリクエストし直さない", () => {
    const a = new RungAdapter();
    const short = { waiting: true, throughput: 5_000_000 };
    expect(first(a, 0, 10_000, short)).toEqual({
      at: GRACE,
      decision: { step: 1, reason: "slow" },
    });
    a.refused(GRACE);
    expect(first(a, GRACE + 1_000, 60_000, short)).toEqual({
      at: GRACE + HOLD,
      decision: { step: 1, reason: "slow" },
    });
  });
});

/** **画面に出す文** (`stepLabel`・`adaptNote`)。ライブも観る画面も同じ文 */
describe("画面に出す文", () => {
  test("自動の行の値は、段 0 は形式だけ、下げたら高さを添える、音声だけはそう出す", () => {
    expect(stepLabel(0, "MPEG-2")).toBe("MPEG-2");
    expect(stepLabel(2, "H.264")).toBe("H.264 540p");
    expect(stepLabel(1, "H.265")).toBe("H.265 720p");
    // 応答を受ける前はコーデックが分からない
    expect(stepLabel(3, "")).toBe("360p");
    expect(stepLabel("audio", "H.264")).toBe("音声だけ");
  });

  test("段を動かしたときは、理由と替えた先を書く", () => {
    expect(adaptNote({ step: 2, reason: "slow" }, 0)).toBe(
      "回線が細いため、540p に下げました",
    );
    expect(adaptNote({ step: "audio", reason: "slow" }, 3)).toBe(
      "回線が細いため、音声だけにしました",
    );
    expect(adaptNote({ step: 1, reason: "restored" }, 2)).toBe(
      "回線が戻ったため、720p に上げました",
    );
    expect(adaptNote({ step: 3, reason: "restored" }, "audio")).toBe(
      "回線が戻ったため、360p の映像に戻しました",
    );
    expect(adaptNote({ step: 0, reason: "restored" }, 1)).toBe(
      "回線が戻ったため、元の画質に戻しました",
    );
  });

  test("エンコードの遅れと手で選んでいるときは、段を動かさない理由とすること", () => {
    expect(adaptNote({ step: 1, reason: "encode" }, 1)).toBe(
      "サーバのエンコードが追いつかないため、再生が止まります",
    );
    expect(adaptNote({ step: 0, reason: "pinned" }, 0)).toBe(
      "回線が細いため、再生が止まります。コーデックを「自動」にすると、画質を下げて再生を続けます",
    );
  });
});
