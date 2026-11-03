import { describe, expect, test } from "bun:test";

import { mayRead, type ReadAhead } from "./read-ahead";

const MB = 1024 * 1024;

/** 手元が空で、始めたばかり */
const start: ReadAhead = {
  lead: 0,
  ahead: 30,
  fed: 0,
  early: 8 * MB,
  played: 0,
  bytesPerSecond: undefined,
  floor: 2 * MB,
};

describe("mayRead", () => {
  test("始めたばかりなら読む", () => {
    expect(mayRead(start)).toBe(true);
  });

  test("手元の尺が上限に届いたら待つ", () => {
    expect(mayRead({ ...start, lead: 30, fed: 20 * MB })).toBe(false);
    expect(mayRead({ ...start, lead: 29, fed: 20 * MB })).toBe(true);
  });

  test("デコードし始める前は、渡したバイト数が上限に届いたら待つ", () => {
    expect(mayRead({ ...start, fed: 8 * MB })).toBe(false);
    expect(mayRead({ ...start, fed: 8 * MB - 1 })).toBe(true);
  });

  test("bytesPerSecond が無ければ、バイト数では抑えない", () => {
    expect(mayRead({ ...start, lead: 10, fed: 900 * MB })).toBe(true);
  });

  test("bytesPerSecond を渡すと、観た長さの少し先を超えて読まない", () => {
    // 1MB/秒の録画。観はじめで 30 秒ぶんの 1.5 倍 (45MB) まで
    const slow = { ...start, lead: 10, bytesPerSecond: MB };
    expect(mayRead({ ...slow, fed: 45 * MB })).toBe(true);
    expect(mayRead({ ...slow, fed: 45 * MB + 1 })).toBe(false);
  });

  test("観るのが進めば、そのぶん先まで読む", () => {
    const slow = { ...start, lead: 10, bytesPerSecond: MB, fed: 60 * MB };
    expect(mayRead({ ...slow, played: 0 })).toBe(false);
    // 10 秒観れば (10 + 30) × 1.5 = 60MB まで
    expect(mayRead({ ...slow, played: 10 })).toBe(true);
  });

  test("速さが小さくても、floor までは読む", () => {
    const tiny = { ...start, bytesPerSecond: 1000, fed: 2 * MB - 1 };
    expect(mayRead(tiny)).toBe(true);
    expect(mayRead({ ...tiny, fed: 2 * MB + 1, lead: 1 })).toBe(false);
  });
});
