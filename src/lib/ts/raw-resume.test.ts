import { describe, expect, test } from "bun:test";

import { OFFSET_HEADER, ORIGIN_HEADER } from "./playback";
import { RawCursor, rawHeard } from "./raw-resume";

function headers(origin: string | null, offset: string | null): Headers {
  const out = new Headers();
  if (origin !== null) out.set(ORIGIN_HEADER, origin);
  if (offset !== null) out.set(OFFSET_HEADER, offset);
  return out;
}

describe("rawHeard", () => {
  test("物差しの 0 と流し始めた位置を読む", () => {
    expect(rawHeard(headers("900000", "188000"))).toEqual({
      origin: 900000,
      offset: 188000,
    });
  });

  test("物差しの 0 が無ければ null", () => {
    expect(rawHeard(headers(null, "0"))).toBeNull();
    expect(rawHeard(headers("x", "0"))).toBeNull();
  });

  test("流し始めた位置が無い・読めなければ offset は null (続きはリクエストできない)", () => {
    expect(rawHeard(headers("0", null))?.offset).toBeNull();
    expect(rawHeard(headers("0", "-1"))?.offset).toBeNull();
    expect(rawHeard(headers("0", "1.5"))?.offset).toBeNull();
  });
});

describe("RawCursor", () => {
  test("流し始めた位置に渡したバイト数を足した所が続きの位置。パケットの途中でもそのまま", () => {
    const cursor = new RawCursor();
    expect(cursor.resumeAt).toBeNull();
    expect(cursor.open({ origin: 5, offset: 1880 }, null)).toBe(true);
    cursor.take(1000);
    cursor.take(77);
    expect(cursor.resumeAt).toBe(2957);
  });

  test("続きの応答は物差しの 0 と位置が合えば使い、そのまま数え続ける", () => {
    const cursor = new RawCursor();
    cursor.open({ origin: 5, offset: 0 }, null);
    cursor.take(500);
    expect(cursor.open({ origin: 5, offset: 500 }, 500)).toBe(true);
    cursor.take(10);
    expect(cursor.resumeAt).toBe(510);
  });

  test("続きの応答の物差しの 0 か位置が違えば使わず、続きを忘れる", () => {
    const cursor = new RawCursor();
    cursor.open({ origin: 5, offset: 0 }, null);
    cursor.take(500);
    expect(cursor.open({ origin: 6, offset: 500 }, 500)).toBe(false);
    expect(cursor.resumeAt).toBeNull();

    cursor.open({ origin: 5, offset: 0 }, null);
    cursor.take(500);
    expect(cursor.open({ origin: 5, offset: null }, 500)).toBe(false);
    expect(cursor.resumeAt).toBeNull();
  });

  test("流し始めた位置が分からない応答では続きをリクエストしない", () => {
    const cursor = new RawCursor();
    cursor.open({ origin: 5, offset: null }, null);
    cursor.take(500);
    expect(cursor.resumeAt).toBeNull();
  });

  test("飛んだら続きは無い", () => {
    const cursor = new RawCursor();
    cursor.open({ origin: 5, offset: 0 }, null);
    cursor.take(500);
    cursor.clear();
    expect(cursor.resumeAt).toBeNull();
  });
});
