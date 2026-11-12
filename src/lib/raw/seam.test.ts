import { describe, expect, test } from "bun:test";

import { Seam, SNAP } from "./seam";

const RATE = 48_000;
/** 1024 サンプルのコマの長さ (秒) */
const FRAME = 1024 / RATE;

describe("Seam", () => {
  test("PTS が数 tick 揺れても、前のコマの終わりのサンプルにつなぐ", () => {
    const seam = new Seam(RATE);
    const jitter = [0, 2, -1, 1, 0, -2];
    const starts = jitter.map((ticks, i) =>
      seam.place(0.05 + i * FRAME + ticks / 90_000, FRAME),
    );
    starts.forEach((start, i) =>
      expect(start * RATE).toBeCloseTo(2400 + i * 1024, 6),
    );
  });

  test("最初のコマは、いちばん近いサンプルに置く", () => {
    const seam = new Seam(RATE);
    expect(seam.place(1.00001, FRAME) * RATE).toBeCloseTo(48_000, 6);
  });

  test("SNAP より離れていれば途切れとみなし、時刻どおりに置く", () => {
    const seam = new Seam(RATE);
    seam.place(1, FRAME);
    const later = 1 + FRAME + SNAP * 2;
    expect(seam.place(later, FRAME)).toBeCloseTo(later, 4);
  });

  test("reset のあとは前のコマにつながない", () => {
    const seam = new Seam(RATE);
    seam.place(1, FRAME);
    seam.reset();
    const at = 1 + FRAME + 0.001;
    expect(seam.place(at, FRAME) * RATE).toBeCloseTo(Math.round(at * RATE), 6);
  });

  test("コマのサンプルレートが違っても (44.1kHz の音)、終わりの位置を小数のまま持ち越す", () => {
    const seam = new Seam(RATE);
    const length = 1024 / 44_100;
    seam.place(1, length);
    const second = seam.place(1 + length + 1e-5, length);
    expect(second).toBeCloseTo(1 + length, 9);
  });
});
