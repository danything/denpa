import { describe, expect, test } from "bun:test";

import { LogRing, serverLogs } from "./log-buffer";

describe("サーバのログの写し", () => {
  test("決まった数を超えたら古い行から消え、古い順に返す", () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i++) ring.push("info", `行 ${i}`, i);
    expect(ring.lines().map((line) => line.text)).toEqual([
      "行 2",
      "行 3",
      "行 4",
    ]);
  });

  test("console の出し方はそのままで、写しにも残る (重さと書式)", () => {
    console.warn("警告 %d 件", 3);
    console.error(new Error("壊れました").message);
    const last = serverLogs().slice(-2);
    expect(last.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: "warn", text: "警告 3 件" },
      { level: "error", text: "壊れました" },
    ]);
  });
});
