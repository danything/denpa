import { describe, expect, test } from "bun:test";

import { load } from "./diagnostics.server";

describe("「バージョンと環境」と「ログ」の読み込み", () => {
  test("アクセストークンには、ログとエージェントごとのものを返さない", async () => {
    const data = load(new URL("http://denpa.local/settings/general"), {
      token: 1,
    });
    expect(data.agentsError).toContain("アクセストークンでは使えません");
    expect(data.serverLogs).toEqual([]);
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
