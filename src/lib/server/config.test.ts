import { describe, expect, test } from "bun:test";

import { parseBool, parseNum } from "./config";

describe("環境変数の読み方", () => {
  test("空か空白だけなら既定を使い、前後の空白は落とす", () => {
    expect(parseNum("SCHEDULER_TICK", undefined, 5000)).toBe(5000);
    expect(parseNum("SCHEDULER_TICK", "", 5000)).toBe(5000);
    expect(parseNum("SCHEDULER_TICK", "  ", 5000)).toBe(5000);
    expect(parseNum("SCHEDULER_TICK", " 1000 ", 5000)).toBe(1000);
    expect(parseBool("DENPA_AUTOSTART", " ", true)).toBe(true);
  });

  test("読めない数は既定に戻さずに例外を送出する", () => {
    expect(() => parseNum("SCHEDULER_TICK", "5s", 5000)).toThrow(
      "SCHEDULER_TICK は数で書きます (いまは「5s」)",
    );
  });

  test("SHUTDOWN_WAIT は 0 以上の整数だけを読む (エージェントと同じ)", () => {
    const wait = { min: 0, integer: true };
    expect(parseNum("SHUTDOWN_WAIT", "0", 1, wait)).toBe(0);
    expect(parseNum("SHUTDOWN_WAIT", "60000", 1, wait)).toBe(60000);
    for (const bad of ["-1", "1.5", "6h", "1e3", "0x10"]) {
      expect(() => parseNum("SHUTDOWN_WAIT", bad, 1, wait)).toThrow(
        "SHUTDOWN_WAIT は 0 以上の整数で書きます",
      );
    }
  });

  test("オン/オフは 1・true・0・false だけを読む", () => {
    expect(parseBool("DENPA_AUTOSTART", "1", false)).toBe(true);
    expect(parseBool("DENPA_AUTOSTART", "TRUE", false)).toBe(true);
    expect(parseBool("DENPA_AUTOSTART", "0", true)).toBe(false);
    expect(parseBool("DENPA_AUTOSTART", "false", true)).toBe(false);
    expect(() => parseBool("DENPA_AUTOSTART", "yes", true)).toThrow(
      "DENPA_AUTOSTART は 1 か 0",
    );
  });
});
