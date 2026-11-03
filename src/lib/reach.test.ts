import { describe, expect, test } from "bun:test";

import { reach } from "./reach";

const request = new Request("http://localhost/");

/** 返事が来ない取得。見切って abort されたら reject する */
const silent = (_request: Request, signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("reach", () => {
  test("繋がっていると言うなら、取得した応答を返す", async () => {
    const get = reach({
      fetch: async () => new Response("ok"),
      online: () => true,
      wait: 50,
      giveUpFor: 1000,
    });
    expect(await (await get(request)).text()).toBe("ok");
  });

  test("繋がっていないと言うなら、取得せずにすぐ見切る", async () => {
    let calls = 0;
    const get = reach({
      fetch: async () => {
        calls += 1;
        return new Response("ok");
      },
      online: () => false,
      wait: 50,
      giveUpFor: 1000,
    });
    await expect(get(request)).rejects.toThrow("オフラインです");
    expect(calls).toBe(0);
  });

  test("繋がっていないと言う間は覚えない。戻ればすぐ取得する", async () => {
    let online = false;
    const get = reach({
      fetch: async () => new Response("ok"),
      online: () => online,
      wait: 50,
      giveUpFor: 1000,
    });
    await expect(get(request)).rejects.toThrow();
    online = true;
    expect(await (await get(request)).text()).toBe("ok");
  });

  test("ヘッダが届かなければ見切り、取得も止める", async () => {
    let aborted = false;
    const get = reach({
      fetch: (req, signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return silent(req, signal);
      },
      online: () => true,
      wait: 10,
      giveUpFor: 1000,
    });
    await expect(get(request)).rejects.toThrow("返事がありません");
    expect(aborted).toBe(true);
  });

  test("見切ったあとは giveUpFor のあいだ取得せず、過ぎたら取得する", async () => {
    let time = 0;
    let calls = 0;
    let silentNow = true;
    const get = reach({
      fetch: (req, signal) => {
        calls += 1;
        if (silentNow) return silent(req, signal);
        return Promise.resolve(new Response("ok"));
      },
      online: () => true,
      wait: 10,
      giveUpFor: 5000,
      now: () => time,
    });
    await expect(get(request)).rejects.toThrow("返事がありません");
    expect(calls).toBe(1);
    // 続けて来た取得は待たずに見切る
    time = 4000;
    await expect(get(request)).rejects.toThrow();
    expect(calls).toBe(1);
    // 過ぎたら取得する
    time = 5000;
    silentNow = false;
    expect(await (await get(request)).text()).toBe("ok");
    expect(calls).toBe(2);
  });

  test("reset すると、見切った記憶をすぐ捨てる", async () => {
    let calls = 0;
    let silentNow = true;
    const get = reach({
      fetch: (req, signal) => {
        calls += 1;
        if (silentNow) return silent(req, signal);
        return Promise.resolve(new Response("ok"));
      },
      online: () => true,
      wait: 10,
      giveUpFor: 5000,
      now: () => 0,
    });
    await expect(get(request)).rejects.toThrow("返事がありません");
    get.reset();
    silentNow = false;
    expect(await (await get(request)).text()).toBe("ok");
    expect(calls).toBe(2);
  });

  test("ヘッダが届いたあとは待たない (本体が遅くても見切らない)", async () => {
    const get = reach({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              // 本体は届かないまま
            },
          }),
        ),
      online: () => true,
      wait: 10,
      giveUpFor: 1000,
    });
    const response = await get(request);
    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    // 見切っていないので、次もそのまま取得する
    expect((await get(request)).status).toBe(200);
  });

  test("取得が失敗したら、その失敗で見切る", async () => {
    const get = reach({
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
      online: () => true,
      wait: 50,
      giveUpFor: 1000,
    });
    await expect(get(request)).rejects.toThrow("Failed to fetch");
  });
});
