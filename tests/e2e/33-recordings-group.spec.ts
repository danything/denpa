import { spawnSync } from "node:child_process";

import type { Page } from "@playwright/test";

import { deleteRule, expect, goto, homeTools, syncEpg, test } from "./helpers";

/**
 * ホームの1本の一覧の「まとめて表示」(issue #480) と、開いたときの位置。
 *
 * **録画と予約は DB に直に入れる。** 番組ごとに何本も要るので、本当に録ると偽の放送の
 * 番組の巡り (5秒ずつ・タイトルは数本の使い回し) を何周も待つことになる。並べ方を
 * 見たいだけなので、録り終えた行 (`finished_at` だけある = 「録画済み」) と、先の予約を足す。
 * Playwright は CI では node で動くので、`bun:sqlite` は bun を1回起こして使う
 *
 * 録画の放送日は 2099 年にして、同じワーカーの他のスペックが残した録画より必ず新しく
 * (= 「いま」の線のすぐ下に) 来るようにする。予約は 2100 年 (いちばん先 = 一覧の頭)
 */
const DAY = 86_400_000;
const BASE = new Date(2099, 0, 1, 21, 0).getTime();
const FUTURE = new Date(2100, 0, 1, 21, 0).getTime();

interface Seed {
  name: string;
  series: string;
  at: number;
  /** 観られる録画にする (エンコードしたものの置き場を持たせる。中身は無い) */
  playable?: boolean;
}

const SEEDS: Seed[] = [
  // 3本の番組。いちばん新しい回がいちばん新しい → 先頭の見出し
  {
    name: "グループ試験アニメ #1",
    series: "グループ試験アニメ",
    at: BASE + 1 * DAY,
  },
  {
    name: "グループ試験アニメ #2",
    series: "グループ試験アニメ",
    at: BASE + 2 * DAY,
  },
  {
    name: "グループ試験アニメ #3",
    series: "グループ試験アニメ",
    at: BASE + 3 * DAY,
  },
  // 1本だけの番組。まとめずに、日付の位置 (アニメとニュースの間) にふつうの行で出る
  {
    name: "グループ試験ドラマ",
    series: "グループ試験ドラマ",
    at: BASE + 2.5 * DAY,
  },
  // 2本の番組。シリーズ名を持たない行は番組名から切り出してまとめる
  { name: "グループ試験ニュース 第1回", series: "", at: BASE + 0.5 * DAY },
  { name: "グループ試験ニュース 第2回", series: "", at: BASE + 1.5 * DAY },
  // 一覧をスクロールさせるための1本ものの番組 (上の番組より古い)
  ...Array.from({ length: 14 }, (_, i) => ({
    name: `グループ試験単発${i + 1}`,
    series: `グループ試験単発${i + 1}`,
    at: BASE - (i + 1) * DAY,
  })),
];

/** これからの予約。録画と同じ番組 (アニメ) の続きの回と、1本だけの予約 */
const RESERVATIONS: Seed[] = [
  { name: "グループ試験アニメ #4", series: "", at: FUTURE + 1 * DAY },
  { name: "グループ試験アニメ #5", series: "", at: FUTURE + 2 * DAY },
  { name: "グループ試験特番", series: "", at: FUTURE + 1.5 * DAY },
];

/** bun:sqlite で DB に書く。`script` の中では `db` と `rows` (渡した行) が使える */
function sqlite(db: string, script: string, rows: unknown = []): string {
  const done = spawnSync(
    "bun",
    [
      "-e",
      `import { Database } from 'bun:sqlite';
             const db = new Database(process.env.SEED_DB);
             db.exec('PRAGMA busy_timeout = 5000');
             const rows = JSON.parse(process.env.SEED_ROWS);
             ${script}`,
    ],
    {
      env: { ...process.env, SEED_DB: db, SEED_ROWS: JSON.stringify(rows) },
      encoding: "utf8",
    },
  );
  if (done.status !== 0)
    throw new Error(`DB に書けませんでした: ${done.stderr}`);
  return done.stdout;
}

function seed(db: string, rows: Seed[]): void {
  sqlite(
    db,
    `const insert = db.prepare(
            'INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const row of rows) {
            insert.run(211, 'BS11', row.name, row.series, row.at, row.at + 1800000, row.at + 1800000,
                row.playable ? '/media/encoded/seed/' + row.name + '.mkv' : null, Date.now(), Date.now());
        }`,
    rows,
  );
}

function seedReservations(db: string, rows: Seed[]): void {
  sqlite(
    db,
    `const insert = db.prepare(
            "INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, created_at, updated_at) VALUES (?, (SELECT id FROM services ORDER BY id LIMIT 1), ?, ?, ?, 1, 'scheduled', ?, ?)",
        );
        rows.forEach((row, i) => insert.run(990000 + i, row.name, row.at, row.at + 1800000, Date.now(), Date.now()));`,
    rows,
  );
}

/**
 * 一覧に並んでいるもの (見出しは `group:名前`、行は番組名) を上から。
 * `zone` で「いま」の線の上 (録れたものと録画中) か下 (予約) かを選ぶ
 */
async function listed(
  page: Page,
  zone: "future" | "past" = "past",
): Promise<string[]> {
  const all = await page
    .getByTestId("timeline")
    .locator(
      '[data-testid="timeline-now"], [data-testid="recording-group"], [data-testid$="-row"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = node.getAttribute("data-testid");
        if (id === "timeline-now") return "@now";
        if (id === "recording-group") {
          return `group:${node.querySelector('[data-testid="recording-group-name"]')?.textContent?.trim()}`;
        }
        if (id?.endsWith("-row"))
          return node.querySelector(".row-name")?.textContent?.trim() ?? "";
        return "";
      }),
    );
  const now = all.indexOf("@now");
  return (zone === "past" ? all.slice(0, now) : all.slice(now + 1)).filter(
    (name) => name !== "",
  );
}

/**
 * 開き直す。**一覧を全部描かせる `goto` は使わない** — 続きを足す印を画面に
 * 入れるために一覧を送るので、開いたときの位置が分からなくなる
 */
async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator('[data-hydrated="true"]').waitFor();
}

/** まとめて表示を切り替える (「表示の切り替え」の中) */
async function toggleGrouped(page: Page): Promise<void> {
  await (await homeTools(page)).getByTestId("recordings-group-toggle").click();
}

/** その要素が窓の見えている所 (浮いたヘッダーの下から下のタブの上まで) に全部入っているか */
async function inView(page: Page, selector: string): Promise<boolean> {
  return await page.getByTestId("timeline").evaluate((list, selector) => {
    const target = list.querySelector(selector);
    if (target === null) return false;
    const box = {
      top:
        Number.parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        ) || 0,
      bottom:
        window.innerHeight -
        (document.querySelector<HTMLElement>('[data-testid="tabbar"]')
          ?.offsetHeight ?? 0),
    };
    const rect = target.getBoundingClientRect();
    return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  }, selector);
}

test.describe("ホームの一覧のまとめて表示", () => {
  test.beforeAll(async ({ playwright, stack }) => {
    // 予約は局が要る (一覧は局と突き合わせて出す)。番組表を集めて局を作っておく
    const request = await playwright.request.newContext({
      baseURL: stack.appUrl,
      extraHTTPHeaders: { Origin: stack.appUrl },
    });
    await syncEpg(request);
    await request.dispose();
    seed(`${stack.root}/denpa.db`, SEEDS);
    seedReservations(`${stack.root}/denpa.db`, RESERVATIONS);
  });
  test.afterAll(({ stack }) => {
    // 予約は後続のスペック (予約を数えるもの) に残さない
    sqlite(
      `${stack.root}/denpa.db`,
      'db.run("DELETE FROM reservations WHERE program_id >= 990000")',
    );
  });

  test("番組ごとにまとまり、番組は古い順・中は放送順、1本だけの番組はふつうの行", async ({
    page,
  }) => {
    await goto(page, "/");
    const tools = await homeTools(page);
    const toggle = tools.getByTestId("recordings-group-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAccessibleName("まとめて表示");
    // 入っていないときは「表示の切り替え」にオンの印が付かない
    await expect(page.getByTestId("view-toggle")).not.toHaveAttribute(
      "data-on",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("view-toggle")).toHaveAttribute("data-on");

    // 閉じた見出しと1本ものが、いちばん新しい回の日付で並ぶ (線のすぐ上がいちばん新しい)
    expect((await listed(page)).slice(-4)).toEqual([
      "グループ試験単発1",
      "group:グループ試験ニュース",
      "グループ試験ドラマ",
      "group:グループ試験アニメ",
    ]);

    const anime = page.locator(
      '[data-testid="recording-group"][data-zone="past"][data-group="グループ試験アニメ"]',
    );
    await expect(anime).toHaveAttribute("aria-expanded", "false");
    await expect(anime.getByTestId("recording-group-count")).toHaveText("3本");

    // 押すと見出しのすぐ下に、第1話から順に開く
    await anime.click();
    await expect(anime).toHaveAttribute("aria-expanded", "true");
    expect((await listed(page)).slice(-5)).toEqual([
      "グループ試験ドラマ",
      "group:グループ試験アニメ",
      "グループ試験アニメ #1",
      "グループ試験アニメ #2",
      "グループ試験アニメ #3",
    ]);

    // キーボードでも開ける (本物の button なので Enter で押せる)
    const news = page.locator(
      '[data-testid="recording-group"][data-zone="past"][data-group="グループ試験ニュース"]',
    );
    await news.focus();
    await page.keyboard.press("Enter");
    await expect(news).toHaveAttribute("aria-expanded", "true");
    expect(await listed(page)).toContain("グループ試験ニュース 第1回");

    // もう一度押せば閉じる
    await anime.click();
    await expect(anime).toHaveAttribute("aria-expanded", "false");
    expect(await listed(page)).not.toContain("グループ試験アニメ #1");
  });

  /**
   * **予約もまとめる。** 同じ番組でも、録画は「いま」の線の上、予約は線の下と側ごとに別の見出しを立てる
   * (1つにすると、見出しの位置が時間の並びから外れ、開くと中身が線をまたぐ)。予約の番組は次の回の位置
   */
  test("予約もまとめ、同じ番組でも線の上と下で別の見出しになる", async ({
    page,
  }) => {
    await goto(page, "/");
    await toggleGrouped(page);
    const future = await listed(page, "future");
    // 2100 年の予約はいちばん先なので、一覧の末尾に来る。番組は次の回が早い順
    // (アニメの次の回 #4 は特番より早いので、線の側 = 上に来る)
    expect(future.slice(-2)).toEqual([
      "group:グループ試験アニメ",
      "グループ試験特番",
    ]);
    const ahead = page.locator(
      '[data-testid="recording-group"][data-zone="future"][data-group="グループ試験アニメ"]',
    );
    const behind = page.locator(
      '[data-testid="recording-group"][data-zone="past"][data-group="グループ試験アニメ"]',
    );
    await expect(ahead.getByTestId("recording-group-count")).toHaveText("2本");
    await expect(behind.getByTestId("recording-group-count")).toHaveText("3本");

    // 開くのは側ごと。予約の見出しを開いても、録画の見出しは閉じたまま
    await ahead.click();
    await expect(ahead).toHaveAttribute("aria-expanded", "true");
    await expect(behind).toHaveAttribute("aria-expanded", "false");
    expect(await listed(page, "future")).toEqual(
      expect.arrayContaining([
        "グループ試験アニメ #4",
        "グループ試験アニメ #5",
      ]),
    );
    // 予約の番組からもルールを作れる (次の回の番組から)
    await expect(page.getByTestId("group-rule")).toHaveCount(1);

    // 戻す
    await toggleGrouped(page);
    await expect(page.getByTestId("recording-group")).toHaveCount(0);
  });

  test("まとめて表示は端末に覚える", async ({ page }) => {
    await open(page);
    await toggleGrouped(page);

    // 開き直してもまとめたまま。覚えはサーバが読む (cookie)。描いた時点でもうまとまっている
    await open(page);
    await expect(page.getByTestId("recording-group").first()).toBeVisible();
    expect(await page.context().cookies()).toContainEqual(
      expect.objectContaining({ name: "denpa_recordings_grouped", value: "1" }),
    );

    // 戻すと次に開いたときもまとめない
    await toggleGrouped(page);
    await expect(page.getByTestId("recording-group")).toHaveCount(0);
    await open(page);
    await expect(page.getByTestId("recording-group")).toHaveCount(0);
  });

  /** **JS を待たずに描く。** まとめて表示の覚えはサーバが読むので、JS が無くてもまとまった形で出る */
  test("JS が無くても一覧が描かれ、まとめて表示の覚えも効く", async ({
    browser,
    stack,
  }) => {
    const context = await browser.newContext({
      baseURL: stack.appUrl,
      javaScriptEnabled: false,
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByTestId("timeline-now")).toBeVisible();
      await expect(page.getByTestId("recording-group")).toHaveCount(0);

      await context.addCookies([
        { name: "denpa_recordings_grouped", value: "1", url: stack.appUrl },
      ]);
      await page.goto("/");
      await expect(page.getByTestId("recording-group").first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  /**
   * **録画からルールを作る。** シリーズ名を入れた下書きを持ってルールの画面へ行き、
   * 確かめてから保存する。作ったあとに同じ番組から来れば、作らずにそのルールを案内する
   */
  test("番組の見出しと録画の詳細から、その番組のルールを作れる", async ({
    page,
  }) => {
    await goto(page, "/");
    await toggleGrouped(page);
    const anime = page.locator(
      '[data-testid="recording-group"][data-zone="past"][data-group="グループ試験アニメ"]',
    );
    // 閉じている番組には出さない (見出しが並ぶだけの一覧を押すもので埋めない)
    await expect(page.getByTestId("group-rule")).toHaveCount(0);
    await anime.click();
    await page.getByTestId("group-rule").click();

    // 検索の画面の「ルールとして保存」へ。シリーズ名を言葉にして出直し、同じ回は最初の放送だけ、が入っている
    await expect(page).toHaveURL(/\/search\?.*from=recording%3A\d+/);
    await page.locator('[data-hydrated="true"]').waitFor();
    await expect(page.getByTestId("rule-keyword")).toHaveValue(
      "グループ試験アニメ",
    );
    await expect(page.getByTestId("rule-dedupe")).toBeChecked();
    await expect(page.getByTestId("rule-origin")).toContainText(
      "シリーズ名から始めました",
    );

    try {
      const open = page.getByTestId("rule-draft-open");
      if (await open.isVisible()) await open.click();
      await page.getByTestId("rule-submit").click();
      // 作ったら、この番組はそのルールで録っていると出る
      await expect(page.getByTestId("rule-origin")).toContainText(
        "で録っています",
      );
      await expect(page.getByTestId("rule-origin-link")).toHaveText(
        "グループ試験アニメ",
      );

      // 録画の詳細からも同じ入口。もうルールがあるので、そちらを案内する
      await goto(page, "/");
      await anime.click();
      await page
        .getByTestId("timeline")
        .getByText("グループ試験アニメ #2")
        .click();
      const detail = page.getByTestId("program-detail");
      await detail.getByTestId("detail-rule").click();
      await expect(page).toHaveURL(/\/search\?.*from=recording%3A\d+/);
      await expect(page.getByTestId("rule-origin")).toContainText(
        "で録っています",
      );
    } finally {
      // 後続に残さない
      await goto(page, "/rules");
      const made = page
        .getByTestId("rule-row")
        .filter({ hasText: "グループ試験アニメ" });
      if ((await made.count()) > 0) {
        await deleteRule(made.first());
        await expect(made).toHaveCount(0);
      }
      await goto(page, "/");
      if ((await page.getByTestId("recording-group").count()) > 0)
        await toggleGrouped(page);
    }
  });

  /**
   * **開いたときの位置。** 観終えていない録画があれば、いちばん古いものを映す (溜まったぶんを古い順に
   * 片付けられるように)。描いていない所 (60 件より先) にあっても、そこまで描いてから送る。
   * 無ければ「いま」の線
   */
  test("観終えていない録画のうち、いちばん古いものを映して開く。無ければ「いま」の線", async ({
    page,
    stack,
  }) => {
    const db = `${stack.root}/denpa.db`;
    // ほかのスペックが残した録画は、いったん観終えたことにする (終わったら戻す)
    const before = JSON.parse(
      sqlite(
        db,
        `const ids = db.query('SELECT id FROM recordings WHERE watched_at IS NULL').all().map((r) => r.id);
                 db.run('UPDATE recordings SET watched_at = ? WHERE watched_at IS NULL', [Date.now()]);
                 console.log(JSON.stringify(ids));`,
      ),
    ) as number[];
    try {
      // 観終えていないものが無ければ「いま」の線
      await open(page);
      await expect
        .poll(() => inView(page, '[data-testid="timeline-now"]'))
        .toBe(true);

      // 80 本の古い回を足し、いちばん古い回だけ観られる・観ていないものにする (60 件より先)
      const old = Array.from({ length: 80 }, (_, i) => ({
        name: `位置試験${i + 1}`,
        series: `位置試験${i + 1}`,
        at: BASE - (30 + i) * DAY,
        playable: i === 79,
      }));
      seed(db, old);
      await open(page);
      const target = page
        .getByTestId("recording-row")
        .filter({ hasText: "位置試験80" });
      await expect(target).toHaveCount(1);
      const id = await target.getAttribute("data-recording-id");
      await expect
        .poll(() =>
          inView(
            page,
            `[data-testid="recording-row"][data-recording-id="${id}"]`,
          ),
        )
        .toBe(true);
      // 線は見えていない (ずっと下)
      expect(await inView(page, '[data-testid="timeline-now"]')).toBe(false);
    } finally {
      sqlite(
        db,
        "db.run(\"DELETE FROM recordings WHERE name LIKE '位置試験%'\")",
      );
      sqlite(
        db,
        'const s = db.prepare("UPDATE recordings SET watched_at = NULL WHERE id = ?"); for (const id of rows) s.run(id);',
        before,
      );
    }
  });
});
