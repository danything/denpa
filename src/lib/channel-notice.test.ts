import { describe, expect, test } from "bun:test";

import { channelNotice } from "./channel-notice";

describe("channelNotice", () => {
  test("エージェントが 1 台も無ければ、スキャンより先にエージェントの追加へ案内する", () => {
    expect(channelNotice({}, 0, 0)).toBe("agent");
    // 前に取り込んだ局が残っていても、番組表に出せる局が無ければ同じ
    expect(channelNotice({}, 3, 0)).toBe("agent");
    expect(channelNotice({ GR: 8 }, 8, 0)).toBeNull();
  });

  test("どの種別にも局が無ければスキャンへ案内する", () => {
    expect(channelNotice({}, 0)).toBe("all");
    expect(channelNotice({ GR: 0, BS: 0, CS: 0 }, 0)).toBe("all");
  });

  test("衛星だけの家では出さない (地上波が無くても)", () => {
    expect(channelNotice({ GR: 0, BS: 12, CS: 0 }, 12)).toBeNull();
    expect(channelNotice({ CS: 3 }, 3)).toBeNull();
  });

  test("地上波だけでも出さない", () => {
    expect(channelNotice({ GR: 8, BS: 0, CS: 0 }, 8)).toBeNull();
  });

  test("ケーブルだけの家でも、復号できる局があれば出さない", () => {
    expect(channelNotice({ CATV: 5 }, 7)).toBeNull();
  });

  test("局はあるが、どれも復号できなければ (スカパー！プレミアムだけなど) そのわけを言う", () => {
    expect(channelNotice({}, 2)).toBe("undecodable");
    expect(channelNotice({ CATV: 0 }, 3)).toBe("undecodable");
  });
});
