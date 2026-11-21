import { describe, expect, test } from "bun:test";

import { load } from "./diagnostics.server";

describe("「バージョンと環境」と「ログ」の読み込み", () => {
  test("アクセストークンには、ログとエージェントごとのものを返さない", async () => {
    const data = load(new URL("http://denpa.local/settings/general"), {
      token: 1,
    });
    expect(data.agentsError).toContain("アクセストークンでは使えません");
    expect(data.serverLogs).toEqual([]);
    expect(data.faults).toEqual([]);
    // サーバの機材 (CPU・GPU) はエージェントのある場所に繋がらないので返す
    expect(typeof data.environment.cpu).toBe("string");
    expect(typeof data.environment.gpu).toBe("string");
    // 録画の前にスリープから起こすのは Windows と Mac だけ (単体テストは Linux で流す)
    if (process.platform === "linux") expect(data.wake).toBeNull();
    expect(data.hosts).toEqual([]);
    expect(data.agents).toEqual([]);
    expect(await data.agentLogs).toEqual([]);
    expect(await data.agentAbout).toEqual([]);
    expect((await data.tuners).list).toEqual([]);
    const card = await data.card;
    expect(card.readers).toEqual([]);
    expect(card.remote).toBeUndefined();
  });
});
