import { describe, expect, test } from "bun:test";

import { cfAbsoluteTime, fileTime, type WindowsWake } from "./awake.js";
import {
  HOLD_BEFORE,
  scheduleWakeWindows,
  shouldHold,
  wakeSecond,
  wakeState,
} from "./power.js";

const idle = {
  recording: false,
  encoding: false,
  watching: false,
  next: null,
  now: 1_000_000,
};

describe("shouldHold", () => {
  test("録画・エンコード・ライブ視聴のどれかがあればスリープさせない", () => {
    expect(shouldHold(idle)).toBe(false);
    expect(shouldHold({ ...idle, recording: true })).toBe(true);
    expect(shouldHold({ ...idle, encoding: true })).toBe(true);
    expect(shouldHold({ ...idle, watching: true })).toBe(true);
  });

  test("次の録画が近ければスリープさせない (起こしたあとに眠り直させない)", () => {
    expect(shouldHold({ ...idle, next: idle.now + HOLD_BEFORE - 1 })).toBe(
      true,
    );
    expect(shouldHold({ ...idle, next: idle.now + HOLD_BEFORE })).toBe(false);
  });
});

describe("Windows の起こすタイマー", () => {
  test("時刻は 1601-01-01 (UTC) からの 100 ns (SetWaitableTimer に UTC の時刻として渡す)", () => {
    expect(fileTime(0)).toBe(116_444_736_000_000_000n);
    // 2026-11-07T11:58:30.123Z。ミリ秒より細かい値は捨てる
    expect(fileTime(Date.UTC(2026, 10, 7, 11, 58, 30, 123) + 0.9)).toBe(
      (BigInt(Date.UTC(2026, 10, 7, 11, 58, 30, 123)) + 11_644_473_600_000n) *
        10_000n,
    );
  });
});

describe("Mac の起こす予約", () => {
  test("時刻は秒にそろえる (取り消すときに置いたときと同じ時刻を渡すため)", () => {
    expect(wakeSecond(Date.UTC(2026, 10, 7, 11, 58, 30, 999))).toBe(
      Date.UTC(2026, 10, 7, 11, 58, 30),
    );
  });

  test("CoreFoundation の時刻は 2001-01-01 (UTC) からの秒", () => {
    expect(cfAbsoluteTime(Date.UTC(2001, 0, 1))).toBe(0);
    expect(cfAbsoluteTime(Date.UTC(2001, 0, 1, 0, 1, 0, 500))).toBe(60.5);
  });
});

describe("Windows の起こすタイマーの設定し直し", () => {
  test("失敗したら理由を残して次に設定し直し、録画が無くなれば取り消して理由も消す", async () => {
    const calls: string[] = [];
    let refuse: string | null = "SetWaitableTimer が失敗しました (エラー 5)";
    const timer: WindowsWake = {
      set: (at) => {
        calls.push(`set ${at}`);
        return refuse;
      },
      cancel: () => {
        calls.push("cancel");
      },
    };
    const get = () => Promise.resolve(timer);
    const now = 1_000_000;

    // 一度も設定していないうちに録画が無ければ、タイマーに触らない
    await scheduleWakeWindows(null, now, get);
    expect(calls).toEqual([]);

    // 失敗: 理由を残し、時刻は出さない
    await scheduleWakeWindows(now + 60_000, now, get);
    expect(wakeState(now)).toEqual({ at: null, problem: refuse });

    // 次の定期チェックで設定し直す
    refuse = null;
    await scheduleWakeWindows(now + 60_000, now + 30_000, get);
    expect(wakeState(now + 30_000)).toEqual({
      at: now + 60_000,
      problem: null,
    });
    // 同じ時刻なら設定し直さない
    await scheduleWakeWindows(now + 60_000, now + 40_000, get);
    expect(calls).toEqual([`set ${now + 60_000}`, `set ${now + 60_000}`]);

    // 起こす時刻を過ぎたら (もう起きている) 設定せず、時刻も出さない
    await scheduleWakeWindows(now + 50_000, now + 70_000, get);
    expect(calls).toHaveLength(2);
    expect(wakeState(now + 70_000).at).toBeNull();

    // 失敗したあとで録画が無くなれば、取り消して理由も消す
    refuse = "この PC はタイマーでスリープから復帰できません";
    await scheduleWakeWindows(now + 200_000, now + 70_000, get);
    expect(wakeState(now + 70_000).problem).toBe(refuse);
    await scheduleWakeWindows(null, now + 80_000, get);
    expect(calls.at(-1)).toBe("cancel");
    expect(wakeState(now + 80_000)).toEqual({ at: null, problem: null });
  });
});
