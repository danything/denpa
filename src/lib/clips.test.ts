import { describe, expect, test } from "bun:test";

import { clipVersion, clipVersionQuery, parseLayerPatch } from "./clips";

describe("切り抜きの重ねの版", () => {
  test("重ねの無いものは空 (中身は替わらない)", () => {
    expect(clipVersion({})).toBe("");
    expect(clipVersionQuery({ layers: {} })).toBe("");
  });

  test("コメント・字幕の順に、持っていない - / 重ねていない 0 / 重ねている 1", () => {
    expect(clipVersion({ captions: true })).toBe("-1");
    expect(clipVersion({ comments: true, captions: false })).toBe("10");
    expect(clipVersionQuery({ layers: { comments: false } })).toBe("?v=0-");
  });
});

describe("出し入れの本文", () => {
  test("変えたいものだけ真偽で", () => {
    expect(parseLayerPatch({ captions: false })).toEqual({ captions: false });
    expect(parseLayerPatch({ captions: true, comments: false })).toEqual({
      captions: true,
      comments: false,
    });
  });

  test("空・知らない名前・真偽でない値・オブジェクトでないものは読まない", () => {
    expect(parseLayerPatch({})).toBeNull();
    expect(parseLayerPatch({ captions: true, video: false })).toBeNull();
    expect(parseLayerPatch({ captions: "false" })).toBeNull();
    expect(parseLayerPatch({ comments: 1 })).toBeNull();
    expect(parseLayerPatch(null)).toBeNull();
    expect(parseLayerPatch([true])).toBeNull();
    expect(parseLayerPatch("captions")).toBeNull();
  });
});
