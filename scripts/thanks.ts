/**
 * README の謝辞のうち、`<!-- thanks:start -->` と `<!-- thanks:end -->` の間を GitHub の履歴から作り直す。
 * マージされた PR の作者を「手を入れてくれた人」、Issue と Discussion を立てた人を「報告や提案をくれた人」に並べる。
 * 印の外 (特別協賛・土台にしている仕事) は手で書く。
 *
 *     GH_TOKEN=$(gh auth token) bun run thanks
 *
 * GitHub の GraphQL はトークンが無いと読めない。ふだんは .github/workflows/thanks.yml が週に 1 回回して、
 * 変わっていれば README を書き換える PR を出す
 */

import { readFileSync, writeFileSync } from "node:fs";

/** 一覧に載せない人。持ち主は自分の PR や Issue を数えない (bot は __typename で落とす) */
export const EXCLUDE = new Set(["5ym"]);

export const START = "<!-- thanks:start -->";
export const END = "<!-- thanks:end -->";

export type Kind = "pr" | "issue" | "discussion";
export interface Item {
  kind: Kind;
  number: number;
  login: string;
}
export interface Person {
  login: string;
  numbers: number[];
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** GraphQL の接続の名前と絞り込み。PR はマージされたものだけ */
const CONNECTIONS: Record<Kind, string> = {
  pr: "pullRequests(states: MERGED, first: 100, after: $after)",
  issue: "issues(first: 100, after: $after)",
  discussion: "discussions(first: 100, after: $after)",
};

interface Page {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    number: number;
    author: { __typename: string; login: string } | null;
  }[];
}

/** PR・Issue・Discussion を全部読む。作者が消えたもの (ghost) と bot は落とす */
export async function fetchItems(
  repo: string,
  token: string,
  fetchFn: Fetch = fetch,
): Promise<Item[]> {
  const [owner, name] = repo.split("/");
  const items: Item[] = [];
  for (const kind of Object.keys(CONNECTIONS) as Kind[]) {
    const query = `query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        ${CONNECTIONS[kind]} {
          pageInfo { hasNextPage endCursor }
          nodes { number author { __typename login } }
        }
      }
    }`;
    let after: string | null = null;
    do {
      const res = await fetchFn("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables: { owner, name, after } }),
      });
      // 502 などでは本文が JSON でないので、読めなければ空として下で止める (何が読めなかったかを出す)
      const json = (await res.json().catch(() => ({}))) as {
        data?: { repository: Record<string, Page> | null };
        errors?: { message: string }[];
      };
      if (!res.ok || json.errors || !json.data?.repository) {
        throw new Error(
          `thanks: ${kind} を読めませんでした (${res.status}): ${json.errors?.map((e) => e.message).join(" / ") ?? ""}`,
        );
      }
      const page = Object.values(json.data.repository)[0]!;
      for (const node of page.nodes) {
        if (!node.author || node.author.__typename === "Bot") continue;
        items.push({ kind, number: node.number, login: node.author.login });
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return items;
}

/** 人ごとにまとめる。並びは最初に関わった順 (いちばん小さい番号の順)、番号は小さい順 */
export function people(items: Item[], kinds: Kind[]): Person[] {
  const map = new Map<string, number[]>();
  for (const item of items) {
    if (!kinds.includes(item.kind) || EXCLUDE.has(item.login)) continue;
    map.set(item.login, [...(map.get(item.login) ?? []), item.number]);
  }
  return [...map]
    .map(([login, numbers]) => ({
      login,
      numbers: numbers.sort((a, b) => a - b),
    }))
    .sort((a, b) => a.numbers[0]! - b.numbers[0]!);
}

/** 印の間に入れる Markdown。誰もいない段は見出しごと出さない */
export function render(items: Item[]): string {
  const block = (title: string, list: Person[]) =>
    list.length === 0
      ? []
      : [
          `**${title}** (ありがとうございます):`,
          "",
          ...list.map(
            (p) =>
              `- [@${p.login}](https://github.com/${p.login}) (${p.numbers.map((n) => `[#${n}](https://github.com/danything/denpa/issues/${n})`).join(" ")})`,
          ),
          "",
        ];
  return [
    ...block("手を入れてくれた人", people(items, ["pr"])),
    ...block("報告や提案をくれた人", people(items, ["issue", "discussion"])),
  ]
    .join("\n")
    .trim();
}

/** README の印の間を差し替える。印が無い・順が逆なら止める (黙って何も書かないと気づけない) */
export function replaceBlock(readme: string, body: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) {
    throw new Error(`thanks: README に ${START} と ${END} が揃っていません`);
  }
  return `${readme.slice(0, start + START.length)}\n\n${body}\n\n${readme.slice(end)}`;
}

if (import.meta.main) {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    console.error(
      "thanks: GH_TOKEN が要ります (GH_TOKEN=$(gh auth token) bun run thanks)",
    );
    process.exit(1);
  }
  const repo = process.env["GITHUB_REPOSITORY"] ?? "danything/denpa";
  const readme = readFileSync("README.md", "utf8");
  const next = replaceBlock(readme, render(await fetchItems(repo, token)));
  writeFileSync("README.md", next);
  console.log(
    next === readme
      ? "thanks: 変わりなし"
      : "thanks: README の謝辞を書き換えました",
  );
}
