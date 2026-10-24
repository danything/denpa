import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { Fmp4Splitter, readFragment, readInit } from "./fmp4";
import { KeyGate } from "./key-gate";

/**
 * 本物の ffmpeg が書いた 2 秒 (`tests/fake/fmp4-loop.ts` に作り方)。0.05 秒ずつの塊で、
 * キーフレームは頭と 1.021 秒 (16 個目の塊の2コマ目)
 */
const file = new Uint8Array(
  readFileSync(new URL("../../../tests/fake/live-h264.mp4", import.meta.url)),
);
const segments = new Fmp4Splitter().feed(file);
const head = segments.find((s) => s.kind === "init")!.data;
const fragments = segments.filter((s) => s.kind === "media").map((s) => s.data);
const tracks = readInit(head);
const video = tracks.find((t) => t.kind === "video")!.id;
/** 映像のキーフレームを含む塊のうち、頭の次のもの */
const KEY = fragments.findIndex(
  (f, i) =>
    i > 0 && readFragment(f, tracks).some((s) => s.track === video && s.key),
);

describe("途中から入った流れ", () => {
  test("キーフレームを含む塊まで渡さず、その時刻を覚える", () => {
    const gate = new KeyGate();
    gate.init(head);
    const passed = fragments.slice(5).map((f) => gate.pass(f));
    expect(passed.indexOf(true)).toBe(KEY - 5);
    // そこから先は全部渡す
    expect(passed.slice(KEY - 5).every(Boolean)).toBe(true);
    expect(gate.at).toBeCloseTo(1.021, 2);
  });

  test("頭から入ればそのまま渡す", () => {
    const gate = new KeyGate();
    gate.init(head);
    expect(gate.pass(fragments[0]!)).toBe(true);
    expect(gate.at).toBe(0);
  });

  test("init が来たら数え直す", () => {
    const gate = new KeyGate();
    gate.init(head);
    gate.pass(fragments[0]!);
    gate.init(head);
    expect(gate.at).toBeNull();
    expect(gate.pass(fragments[3]!)).toBe(false);
  });

  // 印が読めない流れでも、映像が出ないまま止まらない
  test("キーフレームが来ないまま 4 秒ぶん過ぎたら、待つのをやめる", () => {
    const gate = new KeyGate();
    gate.init(head);
    const deltas = fragments.slice(1, KEY);
    let passed = false;
    let seen = 0;
    for (let round = 0; round < 10 && !passed; round++) {
      for (const f of deltas) {
        seen++;
        if (gate.pass(f)) {
          passed = true;
          break;
        }
      }
    }
    expect(passed).toBe(true);
    expect(gate.at).toBeNull();
    // 1 秒ぶんで 15 個ほど。4 秒を待ってから
    expect(seen).toBeGreaterThan(55);
  });

  test("init が読めなければ待たない", () => {
    const gate = new KeyGate();
    gate.init(new Uint8Array(16));
    expect(gate.pass(fragments[3]!)).toBe(true);
  });
});
