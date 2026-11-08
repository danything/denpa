import { describe, expect, test } from "bun:test";

import { codecsFor, mseType } from "./live";

describe("MSE に渡す型 (MP4 の Opus の書き方)", () => {
  const av1 = codecsFor("av1");

  test("小文字の opus を受け取れる端末では小文字にする (Android の Chrome は大文字で流すと断った)", () => {
    expect(mseType(av1, () => true)).toBe(
      'video/mp4; codecs="av01.0.08M.08,opus"',
    );
  });

  test("小文字を断る端末 (Safari) では大文字のまま", () => {
    expect(mseType(av1, (type) => !type.includes(",opus"))).toBe(av1);
  });

  test("Opus を含まない型と、MP4 でない型は替えない", () => {
    const asked: string[] = [];
    const supported = (type: string) => {
      asked.push(type);
      return true;
    };
    expect(mseType(codecsFor("h264"), supported)).toBe(codecsFor("h264"));
    expect(mseType('video/webm; codecs="av01.0.08M.08,Opus"', supported)).toBe(
      'video/webm; codecs="av01.0.08M.08,Opus"',
    );
    expect(asked).toEqual([]);
  });
});
