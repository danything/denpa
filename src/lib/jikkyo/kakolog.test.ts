import { describe, expect, test } from "bun:test";

import { readMail } from "./command";
import { fetchKakolog } from "./kakolog";

/*
 * 過去ログの取得 (denpa のサーバの `/api/jikkyo/kakolog` から)。fetch を差し替える。返事は自分で作った偽物
 */

const T = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const URL_ = "http://denpa.test/api/jikkyo/kakolog";

/** 訊かれた URL を控え、`body` を返す偽の fetch */
function fake(body: (url: URL) => unknown) {
  const asked: URL[] = [];
  const get = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url);
    return new Response(JSON.stringify(body(url)));
  }) as typeof fetch;
  return { asked, get };
}

describe("fetchKakolog", () => {
  test("区間を ms で訊き、出どころと ID を残して読む", async () => {
    const { asked, get } = fake(() => ({
      comments: [
        { at: T + 1500, text: "a", src: "nx" },
        { at: T + 2500, text: "b", mail: "184 red", src: "hub", id: "x1" },
      ],
      complete: true,
    }));
    const got = await fetchKakolog(URL_, "jk1", T, T + 60_000, {
      now: T + DAY,
      fetch: get,
    });
    expect(got.comments).toEqual([
      { at: T + 1500, text: "a", src: "nx" },
      {
        at: T + 2500,
        text: "b",
        src: "hub",
        id: "x1",
        style: readMail("184 red"),
      },
    ]);
    expect(got.odd).toBe(0);
    expect(got.complete).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.searchParams.get("channel")).toBe("jk1");
    expect(asked[0]!.searchParams.get("from")).toBe(String(T));
    expect(asked[0]!.searchParams.get("to")).toBe(String(T + 60_000));
  });

  test("終わりは今で切り、3 日ごとに分けて訊く", async () => {
    const { asked, get } = fake(() => ({ comments: [], complete: true }));
    await fetchKakolog(URL_, "jk1", T, T + 7 * DAY, {
      now: T + 4 * DAY,
      fetch: get,
    });
    expect(
      asked.map((u) => [u.searchParams.get("from"), u.searchParams.get("to")]),
    ).toEqual([
      [String(T), String(T + 3 * DAY)],
      [String(T + 3 * DAY), String(T + 4 * DAY)],
    ]);
  });

  test("hub が取りきれなかったら complete が false。取れた分は返す", async () => {
    const { get } = fake(() => ({
      comments: [{ at: T + 1, text: "独自", src: "hub", id: "y" }],
      complete: false,
    }));
    const got = await fetchKakolog(URL_, "jk1", T, T + 60_000, {
      now: T + DAY,
      fetch: get,
    });
    expect(got.complete).toBe(false);
    expect(got.comments).toHaveLength(1);
  });

  test("形のずれた行は飛ばして数え、運営のコメントは流さない", async () => {
    const { get } = fake(() => ({
      comments: [
        { at: T + 1, text: "ok" },
        { at: "x", text: "bad" },
        { at: T + 2, text: "/nicoad {}" },
      ],
      complete: true,
    }));
    const got = await fetchKakolog(URL_, "jk1", T, T + 60_000, {
      now: T + DAY,
      fetch: get,
    });
    expect(got.comments.map((c) => c.text)).toEqual(["ok"]);
    expect(got.odd).toBe(1);
  });

  test("届かない・形が違うときは例外", async () => {
    const down = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchKakolog(URL_, "jk1", T, T + 1000, { now: T + DAY, fetch: down }),
    ).rejects.toThrow();
    const { get } = fake(() => ({ error: "x" }));
    await expect(
      fetchKakolog(URL_, "jk1", T, T + 1000, { now: T + DAY, fetch: get }),
    ).rejects.toThrow();
  });
});
