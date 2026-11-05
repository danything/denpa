import { describe, expect, test } from "bun:test";

import { tsProbe } from "./ts-probe";

describe("探りの長さ (tsProbe)", () => {
  test("本編の開始までの秒数だけ延ばし、probesize も同じ割合で増やす", () => {
    expect(tsProbe(0)).toEqual([
      "-analyzeduration",
      "15000000",
      "-probesize",
      "30000000",
    ]);
    expect(tsProbe(15)).toEqual([
      "-analyzeduration",
      "30000000",
      "-probesize",
      "60000000",
    ]);
  });

  test("負の値と読めない値は延ばさず、長すぎる値は 120 秒で止める", () => {
    expect(tsProbe(-5)).toEqual(tsProbe(0));
    expect(tsProbe(Number.NaN)).toEqual(tsProbe(0));
    expect(tsProbe(3600)).toEqual(tsProbe(120));
  });
});
