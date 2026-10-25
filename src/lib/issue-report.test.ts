import { describe, expect, test } from "bun:test";

import {
  cut,
  fitLogs,
  fullReport,
  guessLevel,
  initialLogs,
  ISSUE_NEW,
  issueUrl,
  type LogLine,
  type LogSource,
  URL_LIMIT,
} from "./issue-report";

const BASE = 1_761_300_000_000;
const line = (i: number, level: LogLine["level"] = "info", text = `行 ${i}`) =>
  ({ at: BASE + i * 1000, level, text }) satisfies LogLine;

const fields = {
  title: "録画が止まる",
  version: "v1.2.3",
  environment: "Linux",
};

describe("Issue の URL", () => {
  test("Issue のフォームの欄の名前で埋める (bug_report.yml の id)", () => {
    const { url, dropped } = issueUrl({ ...fields, logs: "a\nb" });
    expect(dropped).toBe(0);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(ISSUE_NEW);
    expect(parsed.searchParams.get("template")).toBe("bug_report.yml");
    expect(parsed.searchParams.get("title")).toBe("録画が止まる");
    expect(parsed.searchParams.get("version")).toBe("v1.2.3");
    expect(parsed.searchParams.get("environment")).toBe("Linux");
    expect(parsed.searchParams.get("logs")).toBe("a\nb");
    // 何が起きたか・再現手順はその人が GitHub で書く
    expect(parsed.searchParams.has("what")).toBe(false);
    expect(parsed.searchParams.has("steps")).toBe(false);
  });

  test("書き足して上限を超えたら、ログの頭 (古いほう) から削って数を書く", () => {
    const logs = Array.from({ length: 400 }, (_, i) => `ログの行 ${i}`).join(
      "\n",
    );
    const { url, dropped } = issueUrl({ ...fields, logs });
    expect(url.length).toBeLessThanOrEqual(URL_LIMIT);
    expect(dropped).toBeGreaterThan(0);
    const got = new URL(url).searchParams.get("logs")!.split("\n");
    expect(got[0]).toBe(`(長いので頭の ${dropped} 行を省きました)`);
    // 新しいほうは残る
    expect(got.at(-1)).toBe("ログの行 399");
    expect(got[1]).toBe(`ログの行 ${dropped}`);
  });

  test("絵文字の途中で切れても、URL を作れる (片割れのサロゲートを残さない)", () => {
    // 「🎬」は UTF-16 で 2 単位。上限がちょうどその間に当たるように並べる
    const title = `${"a".repeat(254)}🎬🎬`;
    const { url } = issueUrl({
      ...fields,
      title,
      logs: "壊れた字 \ud83c まで",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toBe(`${"a".repeat(254)}…`);
    expect(parsed.searchParams.get("logs")).toBe("壊れた字 � まで");
  });

  test("切るときはサロゲートの間で切らない", () => {
    expect(cut("ab🎬", 3)).toBe("ab");
    expect(cut("ab🎬", 4)).toBe("ab🎬");
    expect(cut("abc", 2)).toBe("ab");
  });

  test("タイトルと環境は上限で切る", () => {
    const { url } = issueUrl({
      ...fields,
      title: "あ".repeat(1000),
      environment: "い".repeat(5000),
      logs: "",
    });
    expect(url.length).toBeLessThanOrEqual(URL_LIMIT);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toStartWith("あああ");
    expect(parsed.searchParams.get("title")!.length).toBeLessThanOrEqual(256);
    expect(parsed.searchParams.get("environment")).toEndWith("い…");
    // 英数字なら字数の上限まで入る
    const ascii = new URL(
      issueUrl({ ...fields, title: "a".repeat(1000), logs: "" }).url,
    );
    expect(ascii.searchParams.get("title")!.length).toBe(256);
  });
});

describe("最初に入れるログ", () => {
  test("入りきるなら全部、見出しごとに古い順", () => {
    const sources: LogSource[] = [
      { label: "サーバ", tagged: true, lines: [line(1), line(2, "warn")] },
      { label: "エージェント", tagged: false, lines: [line(3, "error")] },
    ];
    const { text, omitted } = fitLogs(sources, 100_000);
    expect(omitted).toBe(0);
    const rows = text.split("\n");
    expect(rows[0]).toBe("--- サーバのログ (2 行) ---");
    expect(rows[1]).toEndWith(" 行 1");
    expect(rows[2]).toEndWith(" [warn] 行 2");
    expect(rows[3]).toBe("--- エージェントのログ (1 行) ---");
    // 重さが推し量ったものなら印を付けない
    expect(rows[4]).not.toContain("[error]");
    expect(rows[4]).toEndWith(" 行 3");
  });

  test("入りきらなければ警告とエラーを先に、新しいほうから選ぶ", () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      line(i, i % 100 === 0 ? "error" : "info", `行 ${i} ${"x".repeat(80)}`),
    );
    const sources: LogSource[] = [{ label: "サーバ", tagged: true, lines }];
    const { text, omitted } = initialLogs(fields, sources);
    expect(omitted).toBeGreaterThan(0);
    const rows = text.split("\n");
    // エラーの 20 行は全部入る
    expect(rows.filter((row) => row.includes("[error]"))).toHaveLength(20);
    // ふつうの行は新しいほうから
    expect(text).toContain("行 1999 ");
    expect(text).not.toContain("行 1 x");
    expect(rows.at(-1)).toBe(
      `(長いので ${omitted} 行を省きました。全部はコピーかダウンロードしたものにあります)`,
    );
    // 出すときは古い順
    const ats = rows
      .filter((row) => /^\d{4}-/.test(row))
      .map((row) => Number(/行 (\d+)/.exec(row)![1]));
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    // そのまま URL にしても上限に収まり、削られない
    const { url, dropped } = issueUrl({ ...fields, logs: text });
    expect(url.length).toBeLessThanOrEqual(URL_LIMIT);
    expect(dropped).toBe(0);
  });

  test("取れなかった相手は見出しの下に理由", () => {
    const { text } = fitLogs(
      [
        {
          label: "エージェント",
          tagged: false,
          lines: [],
          note: "(このエージェントはログを返しません)",
        },
      ],
      10_000,
    );
    expect(text).toBe(
      "--- エージェントのログ (0 行) ---\n(このエージェントはログを返しません)",
    );
  });

  test("長すぎる 1 行は切る", () => {
    const { text } = fitLogs(
      [
        {
          label: "サーバ",
          tagged: true,
          lines: [line(1, "info", "z".repeat(5000))],
        },
      ],
      100_000,
    );
    expect(text.split("\n")[1]!.length).toBeLessThanOrEqual(400);
    expect(text).toEndWith("…");
  });
});

describe("全部入りの報告 (コピー・ダウンロード)", () => {
  test("ログを 1 行も削らない", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => line(i));
    const report = fullReport(fields, [
      { label: "サーバ", tagged: true, lines },
    ]);
    expect(report.split("\n")[0]).toBe("録画が止まる");
    expect(report).toContain("denpa のバージョン: v1.2.3");
    expect(report).toContain("--- サーバのログ (2000 行) ---");
    expect(report).toContain("行 0\n");
    expect(report).toContain("行 1999\n");
  });
});

describe("エージェントの行の重さ", () => {
  test.each([
    ["[agent] T16: 選局できません", "error"],
    ["[agent] open failed: EBUSY", "error"],
    ["[agent] warning: 遅れています", "warn"],
    ["[agent] listening on :25252", "info"],
    ["[agent] チャンネルを保存しました: 12 件", "info"],
  ] as const)("%s", (text, level) => {
    expect(guessLevel(text)).toBe(level);
  });
});
