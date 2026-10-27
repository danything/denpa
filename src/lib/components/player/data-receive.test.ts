import { describe, expect, test } from "bun:test";

import { storedDataReceive, wantsData } from "./data-receive";

describe("データ放送を常に受信するか", () => {
  test("オンにしたことのある端末だけオンで始まる", () => {
    expect(storedDataReceive(null)).toBe(false);
    expect(storedDataReceive("0")).toBe(false);
    expect(storedDataReceive("1")).toBe(true);
  });

  test("開いているか、常に受信していて局を映しているときにサーバへリクエストする", () => {
    expect(wantsData({ open: false, always: false, tuned: true })).toBe(false);
    expect(wantsData({ open: true, always: false, tuned: true })).toBe(true);
    expect(wantsData({ open: false, always: true, tuned: true })).toBe(true);
    // 追っかけ・録画に譲っている間は、常に受信でもリクエストしない (開いていれば今までどおり)
    expect(wantsData({ open: false, always: true, tuned: false })).toBe(false);
    expect(wantsData({ open: true, always: true, tuned: false })).toBe(true);
  });
});
