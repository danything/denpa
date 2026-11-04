import { describe, expect, test } from "bun:test";

import { PROBE_GAP, ProbeGate } from "./probe-gate";

/** **試しのデータの回数の制限** (`ProbeGate`) */
describe("試しのデータの回数の制限", () => {
  test("同じ利用者は PROBE_GAP たつまで次を取れず、残りの時間を返す", () => {
    const gate = new ProbeGate();
    expect(gate.allow("u", 0)).toBe(0);
    expect(gate.allow("u", 4_000)).toBe(PROBE_GAP - 4_000);
    expect(gate.allow("u", PROBE_GAP)).toBe(0);
  });

  test("断った分は数えない (断られ続けても、前に取ったときから数える)", () => {
    const gate = new ProbeGate();
    gate.allow("u", 0);
    gate.allow("u", 9_000);
    expect(gate.allow("u", PROBE_GAP)).toBe(0);
  });

  test("利用者が違えば別に数える", () => {
    const gate = new ProbeGate();
    expect(gate.allow("a", 0)).toBe(0);
    expect(gate.allow("b", 0)).toBe(0);
  });

  test("覚える数には上限があり、古いものから忘れる", () => {
    const gate = new ProbeGate();
    for (let i = 0; i <= 1_000; i++) gate.allow(`k${i}`, 0);
    // いちばん古い k0 は忘れたので、間を置かずに取れる
    expect(gate.allow("k0", 1)).toBe(0);
    expect(gate.allow("k1000", 1)).toBeGreaterThan(0);
  });
});
