import { describe, expect, test } from "bun:test";

import { fetchKakolog } from "./kakolog";

/*
 * 過去ログ API からの取得。外には繋がず、fetch を差し替える。返事は自分で作った偽物
 */

const T = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 24 * 60 * 60_000;

/** 訊かれた URL と付けたものを控え、`body` を返す偽の fetch */
function fake(body: (url: URL) => unknown) {
  const asked: { url: URL; init: RequestInit | undefined }[] = [];
  const get = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ url, init });
    return new Response(JSON.stringify(body(url)));
  }) as typeof fetch;
  return { asked, get };
}

const chat = (ms: number, content: string) => ({
  chat: {
    thread: "1",
    no: "1",
    date: String(Math.floor(ms / 1000)),
    date_usec: String((ms % 1000) * 1000),
    user_id: "1234",
    content,
  },
});

describe("fetchKakolog", () => {
  test("区間を秒で訊き、Cookie と denpa のページの URL を渡さない", async () => {
    const { asked, get } = fake(() => ({
      packet: [chat(T + 1500, "a"), chat(T + 2500, "b")],
    }));
    const { comments, odd } = await fetchKakolog("jk1", T, T + 60_000, {
      now: T + DAY,
      fetch: get,
    });
    expect(comments).toEqual([
      { at: T + 1500, text: "a" },
      { at: T + 2500, text: "b" },
    ]);
    expect(odd).toBe(0);
    expect(asked).toHaveLength(1);
    const { url, init } = asked[0]!;
    expect(url.origin + url.pathname).toBe(
      "https://jikkyo.tsukumijima.net/api/kakolog/jk1",
    );
    expect(url.searchParams.get("starttime")).toBe(String(T / 1000));
    expect(url.searchParams.get("endtime")).toBe(String(T / 1000 + 60));
    expect(url.searchParams.get("format")).toBe("json");
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
  });

  test("終わりは今で切る (今より後は誤りになる)", async () => {
    const { asked, get } = fake(() => ({ packet: [] }));
    await fetchKakolog("jk1", T, T + 60 * 60_000, {
      now: T + 600_500,
      fetch: get,
    });
    expect(asked[0]!.url.searchParams.get("endtime")).toBe(
      String(T / 1000 + 600),
    );
  });

  test("3 日を超える区間は分けて訊く", async () => {
    const { asked, get } = fake(() => ({ packet: [] }));
    await fetchKakolog("jk1", T, T + 4 * DAY, {
      now: T + 10 * DAY,
      fetch: get,
    });
    expect(asked.map((a) => a.url.searchParams.get("starttime"))).toEqual([
      String(T / 1000),
      String((T + 3 * DAY) / 1000),
    ]);
  });

  test("空の packet はコメントなし。{error} は HTTP 200 でも誤り", async () => {
    const empty = fake(() => ({ packet: [] }));
    expect(
      (
        await fetchKakolog("jk1", T, T + 1000, {
          now: T + DAY,
          fetch: empty.get,
        })
      ).comments,
    ).toEqual([]);
    const broken = fake(() => ({
      error: "取得開始時刻または取得終了時刻が不正です。",
    }));
    await expect(
      fetchKakolog("jk1", T, T + 1000, { now: T + DAY, fetch: broken.get }),
    ).rejects.toThrow("不正です");
  });

  test("形のずれた行は飛ばして数える", async () => {
    const { get } = fake(() => ({
      packet: [chat(T, "a"), { chat: { content: "時刻が無い" } }],
    }));
    const { comments, odd } = await fetchKakolog("jk1", T, T + 1000, {
      now: T + DAY,
      fetch: get,
    });
    expect(comments.map((c) => c.text)).toEqual(["a"]);
    expect(odd).toBe(1);
  });
});
