import { describe, expect, test } from "bun:test";

import { EVENT_LABEL, EVENTS, webhookEvent } from "./webhook-events";

describe("webhookEvent", () => {
  test("通知の種類だけを通す (画面から来た知らない値は保存しない)", () => {
    for (const event of EVENTS) expect(webhookEvent(event)).toBe(true);
    expect(webhookEvent("recording")).toBe(false);
    expect(webhookEvent("")).toBe(false);
  });

  test("どの種類にも画面に出す名前がある", () => {
    expect(Object.keys(EVENT_LABEL).sort()).toEqual([...EVENTS].sort());
  });
});
