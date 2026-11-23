import { describe, expect, test } from "bun:test";

import { captionWords } from "./caption-words";

describe("字幕の 1 枚を文字にする", () => {
  const run = (x: number, y: number, text: string, extra = {}) => ({
    x,
    y,
    w: 36,
    h: 36,
    fx: 0,
    fy: 0,
    size: 36,
    scaleX: 1,
    text,
    fg: "#ffffffff",
    bg: "#00000000",
    ...extra,
  });

  test("上の行から、行の中は左から。ルビと外字は落とす", () => {
    const page = {
      v: 1 as const,
      plane: [960, 540] as [number, number],
      duration: null,
      runs: [
        run(300, 480, "ニュースです"),
        run(100, 480, "７時の"),
        run(100, 420, "こんばんは"),
        run(100, 400, "ばん", { ruby: true }),
        run(500, 420, "〓", { drcs: "a" }),
      ],
    };
    expect(captionWords(page)).toBe("こんばんは ７時のニュースです");
    expect(captionWords(null)).toBe("");
  });
});
