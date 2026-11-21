import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type AdaptSample, RungAdapter } from "./adapt";
import {
  loadPlayback,
  parsePlayback,
  PLAYBACK_KEEP,
  type PlaybackEvent,
  playbackEvent,
  playbackSource,
  playbackText,
  pushPlayback,
  REPEAT_GAP,
} from "./playback-log";

const BASE = 1_761_300_000_000;

const event = (over: Partial<PlaybackEvent> = {}): PlaybackEvent => ({
  at: BASE,
  screen: "live",
  reason: "slow",
  from: 0,
  to: 1,
  note: "回線が細いため、720p に下げました",
  codec: "h264",
  throughput: 3_200_000,
  need: 10_500_000,
  capacity: null,
  speed: 1,
  ahead: 0.4,
  manual: false,
  ...over,
});

describe("再生の記録を足す", () => {
  test("古い順に足し、PLAYBACK_KEEP 件を超えたら古いものから捨てる", () => {
    let list: PlaybackEvent[] = [];
    for (let i = 0; i < PLAYBACK_KEEP + 5; i++)
      list = pushPlayback(
        list,
        event({ at: BASE + i * REPEAT_GAP, from: i % 2 === 0 ? 0 : 1 }),
      );
    expect(list).toHaveLength(PLAYBACK_KEEP);
    expect(list[0]!.at).toBe(BASE + 5 * REPEAT_GAP);
    expect(list.at(-1)!.at).toBe(BASE + (PLAYBACK_KEEP + 4) * REPEAT_GAP);
  });

  test("同じ判断が REPEAT_GAP のうちに続いたら足さない。過ぎたら足す", () => {
    const encode = event({
      reason: "encode",
      from: 1,
      to: 1,
      note: "サーバのエンコードが追いつかないため、再生が止まります",
    });
    let list = pushPlayback([], encode);
    list = pushPlayback(list, { ...encode, at: BASE + 1_000 });
    list = pushPlayback(list, { ...encode, at: BASE + REPEAT_GAP - 1 });
    expect(list).toHaveLength(1);
    list = pushPlayback(list, { ...encode, at: BASE + REPEAT_GAP });
    expect(list).toHaveLength(2);
    // 間に別の理由が挟まっても、間のうちの同じ判断は足さない (encode と pinned が交互に出るとき)
    const pinned = { ...encode, reason: "pinned" as const, at: BASE + 1_000 };
    const alternated = pushPlayback(
      pushPlayback(pushPlayback([], encode), pinned),
      { ...encode, at: BASE + 2_000 },
    );
    expect(alternated).toHaveLength(2);
    // 段が違えば続けて足す
    list = pushPlayback(list, event({ at: BASE + REPEAT_GAP + 1 }));
    expect(list).toHaveLength(3);
  });
});

describe("覚えたものを読む", () => {
  test("形式が違う件は捨て、欠けた値は null にする", () => {
    const raw = JSON.stringify([
      event(),
      { ...event(), reason: "unknown" },
      { ...event(), from: 7 },
      "文字",
      { ...event(), throughput: "速い", screen: "watch/12", codec: 3 },
    ]);
    const got = parsePlayback(raw);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(event());
    expect(got[1]!.throughput).toBeNull();
    expect(got[1]!.screen).toBeNull();
    expect(got[1]!.codec).toBeNull();
  });

  test("読めない文字列は空", () => {
    expect(parsePlayback(null)).toEqual([]);
    expect(parsePlayback("{")).toEqual([]);
    expect(parsePlayback('{"a":1}')).toEqual([]);
  });
});

describe("報告の行", () => {
  test("断り書きのあとに、画面・コーデック・段・速さ・バッファを添える", () => {
    expect(playbackText(event())).toBe(
      "回線が細いため、720p に下げました (ライブ・h264・元の画質 → 720p・受け取り 3.2 Mbit/s・必要 10.5 Mbit/s・エンコードの速さ 1.00・バッファ 0.4 秒)",
    );
    expect(
      playbackText(
        event({
          screen: null,
          reason: "restored",
          from: "audio",
          to: 3,
          note: "回線が戻ったため、360p の映像に戻しました",
          throughput: null,
          need: 1_200_000,
          capacity: 4_000_000,
          speed: null,
          manual: true,
        }),
      ),
    ).toBe(
      "回線が戻ったため、360p の映像に戻しました (h264・音声だけ → 360p・受け取り —・必要 1.2 Mbit/s・測った回線 4.0 Mbit/s・バッファ 0.4 秒・形式を手で選択)",
    );
  });

  test("下げたものは警告、上げたものはふつうの行。ほかの見出しより先に選ぶ", () => {
    const source = playbackSource([
      event(),
      event({ reason: "restored", at: BASE + 1 }),
    ]);
    expect(source.first).toBe(true);
    expect(source.tagged).toBe(true);
    expect(source.lines.map((line) => line.level)).toEqual(["warn", "info"]);
  });
});

describe("段を動かす判断を端末に覚える", () => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
  });
  afterEach(() => {
    if (original === undefined)
      delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", original);
  });

  test("回線が細くて下げたとき、受け取りの速さと段に要る速さを残す", () => {
    const adapter = new RungAdapter();
    const start = BASE + 1_000_000_000;
    const sample: Omit<AdaptSample, "now"> = {
      route: "watch",
      current: 0,
      manual: false,
      throughput: 2_000_000,
      ahead: 0,
      waiting: true,
      pace: null,
      baseKbps: 8_000,
      codec: "h264",
    };
    let decided = null;
    for (
      let now = start;
      now < start + 60_000 && decided === null;
      now += 1_000
    )
      decided = adapter.tick({ ...sample, now });
    expect(decided?.reason).toBe("slow");
    const saved = loadPlayback();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      reason: "slow",
      from: 0,
      codec: "h264",
      throughput: 2_000_000,
      need: 8_000_000,
      manual: false,
    });
    expect(saved[0]!.note).toContain("回線が細いため");
  });

  test("様子から 1 件を作る。上げたときは上げた先の段に要る速さ", () => {
    const got = playbackEvent(
      {
        now: BASE,
        route: "live",
        current: 2,
        manual: false,
        throughput: 5_000_000,
        ahead: 3,
        waiting: false,
        pace: { backlog: 0, dropped: 0, speed: 1.02 },
        baseKbps: null,
        capacity: { bps: 9_000_000, at: BASE },
      },
      { step: 1, reason: "restored" },
      "回線が戻ったため、720p に上げました",
      4_000_000,
    );
    expect(got).toMatchObject({
      screen: null,
      from: 2,
      to: 1,
      codec: null,
      capacity: 9_000_000,
      speed: 1.02,
      need: 4_000_000,
    });
  });
});
