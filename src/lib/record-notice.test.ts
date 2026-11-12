import { describe, expect, test } from "bun:test";

import { COPY_NEVER_REASON } from "./format.js";
import { recordNotice } from "./record-notice.js";

describe("ライブの録画ボタンの通知", () => {
  test("予約できて録るなら、録画を始めると言う", () => {
    expect(recordNotice("ニュース", "scheduled", null)).toEqual({
      key: "record-ニュース-scheduled",
      kind: "info",
      text: "「ニュース」の録画を始めます",
    });
  });

  test("もう録画中なら、録画中だと言う", () => {
    expect(recordNotice("ニュース", "recording", null).text).toBe(
      "「ニュース」は録画中です",
    );
  });

  test("競合なら、始めるとは言わずに理由を添えて注意で出す", () => {
    const notice = recordNotice(
      "ニュース",
      "conflict",
      "チューナーが足りません",
    );
    expect(notice.kind).toBe("warning");
    expect(notice.text).toBe(
      "「ニュース」を予約しましたが、競合のため録画できません。チューナーが足りません",
    );
  });

  test("コピー禁止で録らないなら、録画しないと言い、理由を添える", () => {
    const notice = recordNotice("映画", "skipped", COPY_NEVER_REASON);
    expect(notice.kind).toBe("warning");
    expect(notice.text).toBe(`「映画」は録画しません。${COPY_NEVER_REASON}`);
  });

  test("理由が無ければ、理由の文を付けない", () => {
    expect(recordNotice("映画", "skipped", null).text).toBe(
      "「映画」は録画しません",
    );
  });

  test("ほかの状態は、状態の名前で言う", () => {
    expect(recordNotice("映画", "failed", null).text).toBe(
      "「映画」の予約は「失敗」です",
    );
  });
});
