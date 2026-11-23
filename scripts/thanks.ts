/**
 * README の謝辞のうち、`<!-- thanks:start -->` と `<!-- thanks:end -->` の間を GitHub の履歴から作り直す。
 * マージされた PR の作者を「手を入れてくれた人」、Issue と Discussion を立てた人を「報告や提案をくれた人」に並べる。
 * 印の外の特別協賛は手で書く。
 *
 *     GH_TOKEN=$(gh auth token) bun run thanks
 *
 * GitHub の GraphQL はトークンが無いと読めない。ふだんは .github/workflows/thanks.yml が週に 1 回回して、
 * 変わっていれば README を書き換える PR を出す
 */

import { readFileSync, writeFileSync } from "node:fs";

/** 一覧に載せない人。持ち主は自分の PR や Issue を数えない (bot は __typename で落とす) */
const EXCLUDE = new Set(["5ym"]);

export const START = "<!-- thanks:start -->";
export const END = "<!-- thanks:end -->";

type Kind = "pr" | "issue" | "discussion";
interface Item {
  kind: Kind;
  number: number;
  login: string;
}
interface Person {
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
function people(items: Item[], kinds: Kind[]): Person[] {
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

/** その人がマージされた PR の一覧 (GitHub の検索) */
const prsOf = (login: string) =>
  `https://github.com/danything/denpa/pulls?q=is%3Apr+is%3Amerged+author%3A${login}`;

/** その人が立てた Issue の一覧 (GitHub の検索)。Discussion はこの検索に出ない (`discussionsOf`) */
const issuesOf = (login: string) =>
  `https://github.com/danything/denpa/issues?q=author%3A${login}`;

/** その人が立てた Discussion の一覧 (GitHub の検索)。Issue を 1 つも立てていない人のリンク先 */
const discussionsOf = (login: string) =>
  `https://github.com/danything/denpa/discussions?discussions_q=author%3A${login}`;

/** 表の 1 行に並べる人数 */
const PER_ROW = 7;

/**
 * 1 人ぶんの表のマス。GitHub のアイコン (`<login>.png`。表示は 48px、取るのは 2 倍の 96px) の下に名前を置き、その人の
 * PR・Issue・Discussion の一覧へのリンクにする。README は GitHub が HTML の `<table>`・`<a>`・`<img>` を通すが `style` は消すので、
 * アイコンと名前を離さないために表のマスに入れる (段落に並べると、`&nbsp;` を挟んでもアイコンのあとで折り返した)
 */
const person = (login: string, link: string) =>
  `<td align="center"><a href="${link}"><img src="https://github.com/${login}.png?size=96" width="48" height="48" alt=""><br><sub>@${login}</sub></a></td>`;

/** 1 人ぶんのマスを `PER_ROW` 人ずつの行にした表 */
const table = (cells: string[]) => {
  const rows: string[] = [];
  for (let at = 0; at < cells.length; at += PER_ROW)
    rows.push(`<tr>${cells.slice(at, at + PER_ROW).join("")}</tr>`);
  return ["<table>", ...rows, "</table>"].join("\n");
};

/**
 * 印の間に入れる Markdown。1 人ぶん (`person`) を、`PER_ROW` 人ずつの表に並べる。
 * 番号は並べず、名前からその人の PR の一覧へ飛ぶ。報告や提案は、Issue を立てた人は Issue の一覧、Discussion だけの人は Discussion の一覧へ飛ぶ。
 * 誰もいない段は見出しごと出さない
 */
export function render(items: Item[]): string {
  const issuers = new Set(
    items.filter((item) => item.kind === "issue").map((item) => item.login),
  );
  const block = (
    title: string,
    list: Person[],
    link: (login: string) => string,
  ) =>
    list.length === 0
      ? []
      : [
          `**${title}** (ありがとうございます):`,
          "",
          table(list.map((p) => person(p.login, link(p.login)))),
          "",
        ];
  return [
    ...block("手を入れてくれた人", people(items, ["pr"]), prsOf),
    ...block(
      "報告や提案をくれた人",
      people(items, ["issue", "discussion"]),
      (login) => (issuers.has(login) ? issuesOf(login) : discussionsOf(login)),
    ),
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
