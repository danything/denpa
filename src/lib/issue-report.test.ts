import { describe, expect, test } from "bun:test";

import {
  type AgentAbout,
  agentSystem,
  browserAndOs,
  cut,
  deviceText,
  environmentText,
  fitLogs,
  fullReport,
  guessLevel,
  initialLogs,
  ISSUE_NEW,
  issueUrl,
  type LogLine,
  type LogSource,
  sameVersion,
  tunerSource,
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

  test("書き足して上限を超えたら、ログの先頭 (古いほう) から削って数を書く", () => {
    const logs = Array.from({ length: 400 }, (_, i) => `ログの行 ${i}`).join(
      "\n",
    );
    const { url, dropped } = issueUrl({ ...fields, logs });
    expect(url.length).toBeLessThanOrEqual(URL_LIMIT);
    expect(dropped).toBeGreaterThan(0);
    const got = new URL(url).searchParams.get("logs")!.split("\n");
    expect(got[0]).toBe(`(長いので先頭の ${dropped} 行を省きました)`);
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

  test("先に選ぶ見出し (再生とチューナーの記録) は、ほかの見出しの警告とエラーより先に入る", () => {
    const errors = Array.from({ length: 2000 }, (_, i) =>
      line(i, "error", `サーバの行 ${i} ${"x".repeat(80)}`),
    );
    const playback = Array.from({ length: 10 }, (_, i) =>
      line(i, "info", `再生の行 ${i}`),
    );
    const { text, omitted } = initialLogs(fields, [
      { label: "この端末の再生", tagged: true, lines: playback, first: true },
      { label: "サーバ", tagged: true, lines: errors },
    ]);
    expect(omitted).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) expect(text).toContain(`再生の行 ${i}`);
    expect(text).toContain("--- この端末の再生のログ (10 行) ---");
  });

  test("取れなかった相手は見出しの下に理由", () => {
    const { text } = fitLogs(
      [
        {
          label: "エージェント",
          tagged: false,
          lines: [],
          note: "(エージェントからログを取得できません (500))",
        },
      ],
      10_000,
    );
    expect(text).toBe(
      "--- エージェントのログ (0 行) ---\n(エージェントからログを取得できません (500))",
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

describe("環境の欄", () => {
  const linux: AgentAbout = {
    version: "v1.2.3",
    os: "linux",
    arch: "x64",
    runtime: "Linux 6.12.0 #1 SMP",
    ccidDriver: null,
  };
  const parts = {
    denpaVersion: "v1.2.3",
    server: "Linux 6.12.0 (x64)・Bun 1.4.4",
    cpu: "AMD Ryzen 7 5700G (16 コア)",
    gpu: "renderD128 (AMD): VA-API: H.264",
    device:
      "Chrome 131・Android 14・画面 412×915・窓 412×800・倍率 2.63・指で操作",
    tuners: "PX-Q3U4 (GR)",
    card: "Reader (使用中)",
    browser: "Firefox",
  };

  test("先頭の v は見ずにバージョンを比べる", () => {
    expect(sameVersion("v1.2.3", "1.2.3")).toBe(true);
    expect(sameVersion("dev", "dev")).toBe(true);
    expect(sameVersion("v1.2.3", "v1.2.4")).toBe(false);
    expect(sameVersion("dev", "v1.2.3")).toBe(false);
  });

  test("エージェントの OS はサーバと同じく <説明> (<arch>)。説明が無ければ OS の名前", () => {
    expect(agentSystem(linux)).toBe("Linux 6.12.0 #1 SMP (x64)");
    expect(agentSystem({ ...linux, runtime: null, os: "macos" })).toBe(
      "macOS (x64)",
    );
    expect(agentSystem({ ...linux, runtime: null, os: "android" })).toBe(
      "Android (x64)",
    );
    expect(agentSystem({ ...linux, runtime: null, os: null, arch: null })).toBe(
      "—",
    );
  });

  const one = (
    about: { about: AgentAbout | null; error: string | null } | undefined,
  ) => [{ name: "tuner-agent", about }];

  test("サーバ・CPU・GPU・端末・エージェント・チューナー・カードリーダー・ブラウザの順に 1 行で", () => {
    expect(
      environmentText({ ...parts, agents: one({ about: linux, error: null }) }),
    ).toBe(
      "サーバ: Linux 6.12.0 (x64)・Bun 1.4.4 / CPU: AMD Ryzen 7 5700G (16 コア) / GPU: renderD128 (AMD): VA-API: H.264 / 端末: Chrome 131・Android 14・画面 412×915・窓 412×800・倍率 2.63・指で操作 / エージェント「tuner-agent」: v1.2.3・Linux 6.12.0 #1 SMP (x64) / チューナー: PX-Q3U4 (GR) / カードリーダー: Reader (使用中) / ブラウザ: Firefox",
    );
  });

  test("エージェントは 1 台ずつ名前を付けて並べる。1 台も無ければ「—」", () => {
    const text = environmentText({
      ...parts,
      agents: [
        { name: "居間", about: { about: linux, error: null } },
        { name: "書斎", about: { about: null, error: "繋がりません" } },
      ],
    });
    expect(text).toContain(
      " / エージェント「居間」: v1.2.3・Linux 6.12.0 #1 SMP (x64) / エージェント「書斎」: — (繋がりません) / ",
    );
    expect(environmentText({ ...parts, agents: [] })).toContain(
      " / エージェント: — / ",
    );
  });

  test("macOS なら CCID ドライバも。denpa とバージョンが違えば書き添える", () => {
    const text = environmentText({
      ...parts,
      agents: one({
        about: {
          version: "v1.2.0",
          os: "macos",
          arch: "arm64",
          runtime: "Darwin 25.0.0",
          ccidDriver: "ifd-ccid",
        },
        error: null,
      }),
    });
    expect(text).toContain(
      "エージェント「tuner-agent」: v1.2.0 (denpa とバージョンが違います)・Darwin 25.0.0 (arm64)",
    );
    expect(text).toContain(
      " / CCID ドライバ「tuner-agent」: 従来のもの (useIFDCCID) / ",
    );
  });

  test("エージェントのことを取れなければ理由を、バージョンが読めなければ「不明」と書く", () => {
    expect(
      environmentText({
        ...parts,
        agents: one({
          about: null,
          error: "エージェントからバージョンを取得できません (500)",
        }),
      }),
    ).toContain(
      "エージェント「tuner-agent」: — (エージェントからバージョンを取得できません (500))",
    );
    expect(environmentText({ ...parts, agents: one(undefined) })).toContain(
      "エージェント「tuner-agent」: — / ",
    );
    expect(
      environmentText({
        ...parts,
        agents: one({ about: { ...linux, version: null }, error: null }),
      }),
    ).toContain("エージェント「tuner-agent」: 不明・");
  });
});

describe("端末", () => {
  test("UA からブラウザと OS を読む", () => {
    const cases: [string, string | null, string | null][] = [
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        "Chrome 131",
        "Android 14",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        "Safari 18.1",
        "iOS 18.1 (iPhone)",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
        "Chrome 130",
        "iOS 17.5 (iPhone)",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        "Edge 131",
        "Windows",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Firefox 133",
        "macOS",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36 Tesla/2024.44.25",
        "Chrome 79",
        "Linux (Tesla)",
      ],
      ["curl/8.0", null, null],
    ];
    for (const [ua, browser, os] of cases)
      expect(browserAndOs(ua)).toEqual({ browser, os });
  });

  test("画面と窓の大きさ・倍率・指で操作するかを添える", () => {
    expect(
      deviceText({
        userAgent: "curl/8.0",
        screen: { width: 1920, height: 1080 },
        viewport: { width: 1280, height: 720 },
        pixelRatio: 1.5,
        coarse: false,
      }),
    ).toBe(
      "ブラウザ不明・OS 不明・画面 1920×1080・窓 1280×720・倍率 1.5・マウスで操作",
    );
  });
});

describe("チューナーの記録", () => {
  const NOW = BASE + 60_000;
  const tuner = {
    name: "PX-Q3U4 1",
    agentName: "居間",
    disabled: false,
    error: null,
    signal: null,
    uses: [] as string[],
  };

  test("使っている用途・受信の状態・機材の異常を並べ、ほかの見出しより先に選ぶ", () => {
    const source = tunerSource(
      {
        list: [
          {
            ...tuner,
            uses: ["rec", "live"],
            signal: { locked: true, cn: 28.34, unit: "dB", atTune: false },
          },
          { ...tuner, name: "PX-Q3U4 2" },
          {
            ...tuner,
            name: "PX-Q3U4 3",
            uses: ["epg"],
            signal: { locked: false, cn: null, unit: "dB", atTune: true },
          },
          { ...tuner, name: "PX-Q3U4 4", error: "開けません" },
        ],
        error: null,
      },
      [{ agentName: "居間", at: BASE, text: "TS のバッファが溢れていました" }],
      NOW,
    );
    expect(source.first).toBe(true);
    expect(source.note).toBeUndefined();
    expect(source.lines.map((l) => [l.level, l.text])).toEqual([
      ["warn", "「居間」機材の異常: TS のバッファが溢れていました"],
      [
        "info",
        "「居間」PX-Q3U4 1・録画・ライブ視聴に使用中・同期しています・C/N: 28.3 dB",
      ],
      ["info", "「居間」PX-Q3U4 2・空き"],
      ["warn", "「居間」PX-Q3U4 3・番組表の取得に使用中・同期していません"],
      ["error", "「居間」PX-Q3U4 4・空き・エラー: 開けません"],
    ]);
    expect(source.lines[0]!.at).toBe(BASE);
    expect(source.lines[1]!.at).toBe(NOW);
  });

  test("取得できなかったときは理由を見出しの下に", () => {
    expect(tunerSource({ list: [], error: "繋がりません" }, [], NOW).note).toBe(
      "(チューナーを取得できません: 繋がりません)",
    );
    expect(tunerSource(undefined, [], NOW).note).toBe(
      "(チューナーを取得できませんでした)",
    );
  });
});
