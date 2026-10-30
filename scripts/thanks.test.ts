import { describe, expect, test } from "bun:test";

import { END, fetchItems, render, replaceBlock, START } from "./thanks";

type Node = {
  number: number;
  author: { __typename: string; login: string } | null;
};

/** GraphQL の偽物。接続の名前ごとに、ページの並びを返す */
function fakeGraphql(pages: Record<string, Node[][]>) {
  const calls: { connection: string; after: string | null }[] = [];
  const fetchFn = async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string;
      variables: { after: string | null };
    };
    const connection = /(pullRequests|issues|discussions)\(/.exec(query)![1]!;
    calls.push({ connection, after: variables.after });
    const list = pages[connection] ?? [[]];
    const i = variables.after ? Number(variables.after) : 0;
    const page = {
      pageInfo: { hasNextPage: i + 1 < list.length, endCursor: String(i + 1) },
      nodes: list[i],
    };
    return Response.json({ data: { repository: { [connection]: page } } });
  };
  return { fetchFn, calls };
}

const user = (login: string) => ({ __typename: "User", login });

describe("GitHub から読む", () => {
  test("ページを最後まで辿り、bot と消えた人を落とす", async () => {
    const { fetchFn, calls } = fakeGraphql({
      pullRequests: [
        [
          { number: 188, author: user("Khronos31") },
          { number: 189, author: { __typename: "Bot", login: "renovate" } },
        ],
        [
          { number: 431, author: user("unlimish") },
          { number: 432, author: null },
        ],
      ],
      issues: [[{ number: 195, author: user("Khronos31") }]],
      discussions: [[{ number: 1617, author: user("eggplants") }]],
    });
    const items = await fetchItems("danything/denpa", "t", fetchFn);
    expect(items).toEqual([
      { kind: "pr", number: 188, login: "Khronos31" },
      { kind: "pr", number: 431, login: "unlimish" },
      { kind: "issue", number: 195, login: "Khronos31" },
      { kind: "discussion", number: 1617, login: "eggplants" },
    ]);
    expect(calls).toEqual([
      { connection: "pullRequests", after: null },
      { connection: "pullRequests", after: "1" },
      { connection: "issues", after: null },
      { connection: "discussions", after: null },
    ]);
  });

  test("JSON でない返事でも、何が読めなかったかを出して止める", async () => {
    const fetchFn = async () => new Response("Bad Gateway", { status: 502 });
    await expect(fetchItems("danything/denpa", "t", fetchFn)).rejects.toThrow(
      "pr を読めませんでした (502)",
    );
  });

  test("エラーが返れば止める (半端な一覧で書き換えない)", async () => {
    const fetchFn = async () =>
      Response.json({
        errors: [{ message: "Resource not accessible by integration" }],
      });
    await expect(fetchItems("danything/denpa", "t", fetchFn)).rejects.toThrow(
      "Resource not accessible by integration",
    );
  });
});

describe("一覧の形", () => {
  test("最初に関わった順に並べ、番号は小さい順。持ち主は載せない", () => {
    const text = render([
      { kind: "pr", number: 662, login: "fetburner" },
      { kind: "pr", number: 188, login: "Khronos31" },
      { kind: "pr", number: 700, login: "5ym" },
      { kind: "issue", number: 377, login: "Khronos31" },
      { kind: "issue", number: 668, login: "fetburner" },
      { kind: "discussion", number: 184, login: "Khronos31" },
      { kind: "issue", number: 1, login: "5ym" },
    ]);
    expect(text).toBe(
      [
        "**手を入れてくれた人** (ありがとうございます):",
        "",
        "- [@Khronos31](https://github.com/Khronos31) ([#188](https://github.com/danything/denpa/issues/188))",
        "- [@fetburner](https://github.com/fetburner) ([#662](https://github.com/danything/denpa/issues/662))",
        "",
        "**報告や提案をくれた人** (ありがとうございます):",
        "",
        "- [@Khronos31](https://github.com/Khronos31) ([#184](https://github.com/danything/denpa/issues/184) [#377](https://github.com/danything/denpa/issues/377))",
        "- [@fetburner](https://github.com/fetburner) ([#668](https://github.com/danything/denpa/issues/668))",
      ].join("\n"),
    );
  });

  test("誰もいない段は見出しごと出さない", () => {
    expect(render([{ kind: "issue", number: 5, login: "a" }])).toBe(
      [
        "**報告や提案をくれた人** (ありがとうございます):",
        "",
        "- [@a](https://github.com/a) ([#5](https://github.com/danything/denpa/issues/5))",
      ].join("\n"),
    );
  });
});

describe("README の印の間を差し替える", () => {
  test("印の外は触らない。何度やっても同じ", () => {
    const readme = `## 謝辞\n\n手で書く\n\n${START}\n\n古い\n\n${END}\n\n**土台**\n`;
    const once = replaceBlock(readme, "新しい");
    expect(once).toBe(
      `## 謝辞\n\n手で書く\n\n${START}\n\n新しい\n\n${END}\n\n**土台**\n`,
    );
    expect(replaceBlock(once, "新しい")).toBe(once);
  });

  test("印が欠けていれば止める", () => {
    expect(() => replaceBlock(`${START}\n`, "x")).toThrow();
    expect(() => replaceBlock(`${END}\n${START}\n`, "x")).toThrow();
  });
});
