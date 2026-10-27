import { spawnSync } from "node:child_process";

import type { Page } from "@playwright/test";

import { expect, goto, homeFilter, syncEpg, test } from "./helpers";

/**
 * ホームの1本の一覧 (録れたもの → 録画中 → 「いま」→ 予約) と、右のサイドバー・狭い画面の絞り込みの一枚。
 * 並べ方そのものは単体テスト (`#lib/timeline.test.ts`)。ここでは画面の上で効いているかを見る。
 *
 * 行は DB に直に入れる (33 と同じ)。予約は 2100 年、録画は 2099 年にして、
 * 同じワーカーの他のスペックが残したものと混ざっても見分けが付くようにする
 */
const DAY = 86_400_000;
const BASE = new Date(2099, 2, 1, 21, 0).getTime();
const FUTURE = new Date(2100, 2, 1, 21, 0).getTime();

function sqlite(db: string, script: string): void {
  const done = spawnSync(
    "bun",
    [
      "-e",
      `import { Database } from 'bun:sqlite'; const db = new Database(process.env.SEED_DB); db.exec('PRAGMA busy_timeout = 5000'); ${script}`,
    ],
    { env: { ...process.env, SEED_DB: db }, encoding: "utf8" },
  );
  if (done.status !== 0)
    throw new Error(`DB に書けませんでした: ${done.stderr}`);
}

/** 一覧の行 (予約・録画・録り逃し) */
function rows(page: Page) {
  return page
    .getByTestId("timeline")
    .locator(
      '[data-testid="reservation-row"], [data-testid="recording-row"], [data-testid="missed-row"]',
    );
}

/** 広い画面はサイドバー、狭い画面は頭の1行の、その絞り込みに添えた件数 */
async function filterBox(page: Page) {
  const side = page.getByTestId("sidebar");
  return (await side.isVisible()) ? side : page.getByTestId("timeline-toolbar");
}
async function countOf(page: Page, id: string): Promise<number> {
  const text = await (
    await filterBox(page)
  )
    .locator(`[data-filter="${id}"] [data-testid="filter-count"]`)
    .innerText();
  return Number(text.trim());
}

test.describe("ホームの1本の一覧", () => {
  test.beforeAll(async ({ playwright, stack }) => {
    // 予約は局が要る (一覧は局と突き合わせて出す)。番組表を集めて局を作っておく
    const request = await playwright.request.newContext({
      baseURL: stack.appUrl,
      extraHTTPHeaders: { Origin: stack.appUrl },
    });
    await syncEpg(request);
    await request.dispose();
    const now = Date.now();
    sqlite(
      `${stack.root}/denpa.db`,
      `
            db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, created_at, updated_at) VALUES (980001, (SELECT id FROM services ORDER BY id LIMIT 1), '一覧試験の予約', ${FUTURE}, ${FUTURE + 1800000}, 1, 'scheduled', ${now}, ${now})");
            const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, error, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now}, ${now})');
            rec.run('BS11', '一覧試験の未視聴', '一覧試験の未視聴', ${BASE}, ${BASE + 1800000}, ${BASE + 1800000}, '/media/encoded/seed/a.mkv', null, null);
            rec.run('BS11', '一覧試験の視聴済み', '一覧試験の視聴済み', ${BASE - DAY}, ${BASE - DAY + 1800000}, ${BASE - DAY + 1800000}, '/media/encoded/seed/b.mkv', null, ${now});
            rec.run('BS11', '一覧試験の失敗', '一覧試験の失敗', ${BASE - 2 * DAY}, ${BASE - 2 * DAY + 1800000}, ${BASE - 2 * DAY + 1800000}, null, 'チューナーが見つかりませんでした', null);
            `,
    );
  });
  test.afterAll(({ stack }) => {
    sqlite(
      `${stack.root}/denpa.db`,
      `db.run("DELETE FROM reservations WHERE program_id = 980001"); db.run("DELETE FROM recordings WHERE name LIKE '一覧試験%'");`,
    );
  });

  test("録れたものは「いま」の線の上、予約は下に、日付の見出しを挟んで時刻の順に並ぶ", async ({
    page,
  }) => {
    await goto(page, "/");
    const names = await rows(page).locator(".row-name").allInnerTexts();
    const order = [
      "一覧試験の失敗",
      "一覧試験の視聴済み",
      "一覧試験の未視聴",
      "一覧試験の予約",
    ].map((n) => names.findIndex((name) => name.trim() === n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // 予約と「いま」の線の上下
    const now = await page.getByTestId("timeline-now").boundingBox();
    const reservation = await rows(page)
      .filter({ hasText: "一覧試験の予約" })
      .boundingBox();
    const recording = await rows(page)
      .filter({ hasText: "一覧試験の未視聴" })
      .boundingBox();
    expect(reservation!.y).toBeGreaterThan(now!.y);
    expect(recording!.y).toBeLessThan(now!.y);

    // 「いま」の線と日付の見出しは見出しなので、読み上げの見出し移動で辿れる。
    // 線には次の録画までを添える (隠した読み点の前後に空白が入ることがある)
    await expect(
      page.getByRole("heading", {
        name: /^いま \d{1,2}:\d{2}\s*、\s*次の録画まで \d/,
      }),
    ).toHaveCount(1);
    await expect(page.getByTestId("timeline-day").first()).toHaveRole(
      "heading",
    );

    // 行は指で押せる高さ (48px) がある
    const box = await rows(page)
      .filter({ hasText: "一覧試験の視聴済み" })
      .boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(47.5);
  });

  /*
   * **「いま」の時刻は地に置き、左端は日付のカプセルの字にそろう。** 線は引かず、一言は時刻のすぐ後ろに続く。
   * 狭い画面でも1行のまま (一言は短い形に替わるか「…」で切れ、折り返さない)
   */
  test("「いま」の時刻は日付のカプセルと左端がそろい、一言がすぐ後ろに続き、狭い画面でも1行のまま", async ({
    page,
  }) => {
    for (const width of [1366, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await goto(page, "/");
      const line = page.getByTestId("timeline-now");
      await expect(line).toContainText(/次の録画まで|次まで/);
      const time = (await line.locator(".now-time").boundingBox())!;
      const day = (await page
        .getByTestId("timeline-day")
        .first()
        .boundingBox())!;
      expect(Math.abs(time.x - day.x)).toBeLessThan(1);
      const status = (await line.locator(".now-status").boundingBox())!;
      expect(status.x - (time.x + time.width)).toBeLessThan(12);
      expect((await line.boundingBox())!.height).toBeLessThan(32);
    }
  });

  /*
   * **1000px 未満の頭の1行は、スマホと同じく下のタブのすぐ上に浮かぶ** (上のヘッダーは出さない)。
   * 768px からは一覧が余白の外まで広がるので、窓の端から下のタブと同じだけ離す。日付の見出しは上に貼り付く
   */
  test("広めの画面でも頭の1行は下のタブのすぐ上に浮かぶ", async ({ page }) => {
    for (const size of [
      { width: 700, height: 600 },
      { width: 900, height: 360 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/");
      // 開くと観ていない録画まで送り、下のタブが引っ込んでいることがあるので、頭に戻してから測る
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const at = `${size.width}px`;
      await expect(page.locator(".navbar"), at).toBeHidden();
      const tabbar = page.getByTestId("tabbar");
      const bar = page.getByTestId("timeline-toolbar");
      await expect
        .poll(async () => {
          const tabs = (await tabbar.boundingBox())!;
          const box = (await bar.boundingBox())!;
          return Math.round(tabs.y - (box.y + box.height));
        }, at)
        .toBe(6);
      const tabs = (await tabbar.boundingBox())!;
      const box = (await bar.boundingBox())!;
      expect(Math.abs(box.x - tabs.x), `${at} の左`).toBeLessThan(1);
      expect(
        Math.abs(box.x + box.width - (tabs.x + tabs.width)),
        `${at} の右`,
      ).toBeLessThan(1);
    }
  });

  /*
   * **録画中の行は「いま」の線のすぐ上。** 並びは始まった時刻の順で、いまより前に始まったものは線の上に来る。
   * あと何分かは行の3段目が言い、線は次の録画までを言う (録画中とは言わない)。
   * **録画中は線を目に見せず** (読み上げの見出しには残す)、いまの時刻はいちばん上の録画中の行の進み具合のバーの先に出す。
   * 開いたときにその行が見えている
   */
  test("録画中の行は線のすぐ上にあり、あと何分かは行の3段目が言う", async ({
    page,
    stack,
  }) => {
    const now = Date.now();
    const MIN = 60_000;
    /*
     * **同じワーカーの他のスペックが残した観ていない録画は、いったん観終えたことにする** (足し試験と同じ。終わったら戻す)。
     * ホームは観ていない録画のいちばん古いものを映すので、それが残っていると頭まで戻り、録画中の行が窓の外に出る。
     * ここで映るのは、このファイルが入れた観ていない録画 (録画中の行のすぐ上) か「いま」の線
     */
    const unwatched = spawnSync(
      "bun",
      [
        "-e",
        `import { Database } from 'bun:sqlite'; const db = new Database(process.env.SEED_DB); const ids = db.query("SELECT id FROM recordings WHERE watched_at IS NULL AND name NOT LIKE '一覧試験%'").all().map((r) => r.id); const s = db.prepare('UPDATE recordings SET watched_at = ? WHERE id = ?'); for (const id of ids) s.run(Date.now(), id); console.log(JSON.stringify(ids));`,
      ],
      {
        env: { ...process.env, SEED_DB: `${stack.root}/denpa.db` },
        encoding: "utf8",
      },
    ).stdout.trim();
    // 録画中の録画は DB に直に置く (終わった時刻が無ければ録画中)。終わりの時刻まで片付け (`failStrayRecordings`) は触らない
    sqlite(
      `${stack.root}/denpa.db`,
      `const res = db.prepare("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, started_at, created_at, updated_at) VALUES (980200, (SELECT id FROM services ORDER BY id LIMIT 1), '録画中試験', ${now - 10 * MIN}, ${now + 21 * MIN}, 1, 'scheduled', ${now - 10 * MIN}, ${now}, ${now})").run().lastInsertRowid;
            db.prepare("INSERT INTO recordings (reservation_id, service_id, service_name, name, series, start_at, end_at, created_at, updated_at) VALUES (?, 211, 'BS11', '録画中試験', '録画中試験', ${now - 10 * MIN}, ${now + 21 * MIN}, ${now}, ${now})").run(res);`,
    );
    try {
      for (const viewport of [
        { width: 1366, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        // 開いたときの位置を見るので、一覧を全部描かせる `goto` は使わない
        await page.goto("/");
        await page.locator('[data-hydrated="true"]').waitFor();
        const row = page
          .getByTestId("reservation-row")
          .filter({ hasText: "録画中試験" });
        // 番組名の下に「● 録画中・あと21分」。番組名の行には何も足さない。狭い画面でも縮めずに入りきる
        const status = row.getByTestId("row-activity");
        await expect(status).toHaveCount(1);
        await expect(status).toHaveAttribute("data-kind", "recording");
        await expect(status).toHaveText(/録画中・あと\d+分/);
        await expect(row.getByTestId("reservation-state")).toHaveText("録画中");
        await expect(status.locator(".rec-dot")).toBeVisible();
        await expect(
          row.locator(".title-line .rec-dot, .title-line .tag"),
        ).toHaveCount(0);
        expect(
          await status.evaluate((node) =>
            [
              ...node.querySelectorAll(".act-text, .act-label, .act-detail"),
            ].every(
              (span) =>
                span.scrollWidth <= span.clientWidth &&
                span.scrollHeight <= span.clientHeight,
            ),
          ),
          "「録画中・あと21分」が縮んでいる",
        ).toBe(true);
        // 点とバーは画面の外では描かない (動き続けない)。行ではなく、それぞれの小さな箱に付ける
        await expect(status.locator(".act-mark")).toHaveCSS(
          "content-visibility",
          "auto",
        );
        await expect(row.getByTestId("recording-progress")).toHaveCSS(
          "content-visibility",
          "auto",
        );
        await expect(row.getByTestId("recording-progress")).toBeVisible();
        // 進み具合のバーは面の下端いっぱいに付く
        const rowBox = (await row.boundingBox())!;
        const barBox = (await row
          .getByTestId("recording-progress")
          .boundingBox())!;
        expect(Math.abs(barBox.x - rowBox.x)).toBeLessThan(1);
        expect(Math.abs(barBox.width - rowBox.width)).toBeLessThan(1);
        expect(
          Math.abs(barBox.y + barBox.height - (rowBox.y + rowBox.height)),
        ).toBeLessThan(1);
        // 「いま」の時刻は 3 段目と同じ高さで、字の右に置く (行の高さを増やさない)
        const now = (await row.getByTestId("recording-now").boundingBox())!;
        const activity = (await status.boundingBox())!;
        expect(
          Math.abs(now.y + now.height / 2 - (activity.y + activity.height / 2)),
        ).toBeLessThan(2);
        const label = (await status.locator(".act-text").boundingBox())!;
        expect(now.x).toBeGreaterThan(label.x + label.width);

        // 線のすぐ上 (線の手前の行がこの行)
        const before = await page.getByTestId("timeline").evaluate((list) => {
          const all = [
            ...list.querySelectorAll<HTMLElement>(
              '[data-key], [data-testid="timeline-now"]',
            ),
          ];
          const at = all.findIndex(
            (node) => node.dataset["testid"] === "timeline-now",
          );
          return all[at - 1]?.textContent ?? "";
        });
        expect(before).toContain("録画中試験");

        // 線は次の録画までを言い、録画中とは言わない。目には見せず、時刻は行のバーの先に出る
        const line = page.getByTestId("timeline-now");
        await expect(line).toContainText(/次の録画まで|次まで/);
        await expect(line).not.toContainText("録画中");
        await expect(line).toHaveClass(/visually-hidden/);
        await expect(row.getByTestId("recording-now")).toHaveText(
          /^\d{1,2}:\d{2}$/,
        );

        // 開いたときに、録画中の行 (とバーの先の時刻) が見えている
        const seen = await page.getByTestId("timeline").evaluate((list) => {
          // 窓の見えている所 (浮いたヘッダーの下から下のタブの上まで)
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
          const inside = (node: Element | null) => {
            const rect = node?.getBoundingClientRect();
            return (
              rect !== undefined &&
              rect.top >= box.top - 1 &&
              rect.bottom <= box.bottom + 1
            );
          };
          const live = [
            ...list.querySelectorAll('[data-testid="reservation-row"]'),
          ].find((node) => (node.textContent ?? "").includes("録画中試験"));
          return {
            row: inside(live ?? null),
            now: inside(list.querySelector('[data-testid="recording-now"]')),
          };
        });
        expect(seen).toEqual({ row: true, now: true });
      }

      // 「録画中」に絞っても、行は線の上に残る
      await homeFilter(page, "recording");
      const row = page
        .getByTestId("reservation-row")
        .filter({ hasText: "録画中試験" });
      await expect(row.getByTestId("recording-now")).toBeVisible();
      expect(
        await row.evaluate(
          (node) =>
            !!(
              node.compareDocumentPosition(
                document.querySelector('[data-testid="timeline-now"]')!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
      ).toBe(true);
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM recordings WHERE name = '録画中試験'"); db.run("DELETE FROM reservations WHERE program_id = 980200"); const s = db.prepare('UPDATE recordings SET watched_at = NULL WHERE id = ?'); for (const id of ${unwatched || "[]"}) s.run(id);`,
      );
    }
  });

  /*
   * **止まっている問題も3段目に、理由と1段で。** 番組名の行は時刻と番組名だけ。
   * 競合は「競合・チューナーが足りません」(前は番組名の横のバッジと、理由の段が別だった)
   */
  test("競合の行は、状態と理由を番組名の下の1段に出す", async ({
    page,
    stack,
  }) => {
    const now = Date.now();
    const HOUR = 3_600_000;
    sqlite(
      `${stack.root}/denpa.db`,
      `db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, conflict_reason, created_at, updated_at) VALUES (980201, (SELECT id FROM services ORDER BY id LIMIT 1), '競合試験', ${now + 5 * HOUR}, ${now + 6 * HOUR}, 1, 'conflict', 'チューナーが足りません', ${now}, ${now})");`,
    );
    try {
      await goto(page, "/");
      const row = page
        .getByTestId("reservation-row")
        .filter({ hasText: "競合試験" });
      const status = row.getByTestId("row-activity");
      await expect(status).toHaveCount(1);
      await expect(status).toHaveText("競合・チューナーが足りません");
      await expect(row.getByTestId("reservation-state")).toHaveText("競合");
      await expect(row.locator(".title-line .tag")).toHaveCount(0);
      await expect(row.getByTestId("recording-progress")).toHaveCount(0);
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM reservations WHERE program_id = 980201");`,
      );
    }
  });

  test("絞り込みのボタンは件数どおりの行に絞る", async ({ page }) => {
    await goto(page, "/");
    for (const id of ["reservations", "unfinished", "failed"]) {
      const count = await countOf(page, id);
      await homeFilter(page, id);
      await expect(
        (await filterBox(page)).locator(`[data-filter="${id}"]`),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(rows(page)).toHaveCount(count);
    }
    // 入れた行がそれぞれの絞り込みに入る
    await homeFilter(page, "unfinished");
    await expect(
      rows(page).filter({ hasText: "一覧試験の未視聴" }),
    ).toHaveCount(1);
    await expect(
      rows(page).filter({ hasText: "一覧試験の視聴済み" }),
    ).toHaveCount(0);
    await homeFilter(page, "failed");
    await expect(rows(page).filter({ hasText: "一覧試験の失敗" })).toHaveCount(
      1,
    );
    await homeFilter(page, "reservations");
    await expect(rows(page).filter({ hasText: "一覧試験の予約" })).toHaveCount(
      1,
    );
    await expect(page.getByTestId("timeline-matched")).toBeVisible();
    await homeFilter(page, "all");
    await expect(page.getByTestId("timeline-matched")).toHaveCount(0);
  });

  /*
   * **行は一覧の幅いっぱいの2段。** 広い幅では右にサイドバー (今日のまとめもそこ)。
   * 行は 2 段で、2段目に局と尺と説明の頭が入る
   */
  test("一覧は幅いっぱいの2段の行で、まとめは右のサイドバーに出る", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await goto(page, "/");
    // 広い幅では右にサイドバー (上からカレンダー・状態・絞り込み・表示)。頭の1行は出さず、一覧はいちばん上から
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("timeline-toolbar")).toBeHidden();
    // 次の録画は「いま」の線に出し、状態には残さない
    await expect(page.getByTestId("summary")).toContainText("空き");
    await expect(page.getByTestId("summary")).not.toContainText("次の録画");

    const row = rows(page).filter({ hasText: "一覧試験の視聴済み" });
    await row.scrollIntoViewIfNeeded();
    const list = (await page.getByTestId("timeline").boundingBox())!;
    const box = (await row.boundingBox())!;
    // 一覧の幅のほとんどを行が使う (右に欄が並んでいない)
    expect(box.width).toBeGreaterThan(list.width * 0.9);
    expect(box.height).toBeGreaterThanOrEqual(63.5);
    // 1段目に時刻と番組名、2段目に局
    await expect(row.locator(".t-time")).toHaveText(
      /\d{1,2}:\d{2}–\d{1,2}:\d{2}/,
    );
    await expect(row.locator(".row-meta")).toContainText("BS11");
    // 行を押すと再生、詳細は ⓘ から
    await expect(row.getByTestId("row-open")).toHaveAttribute(
      "href",
      /\/watch\/\d+$/,
    );
    await expect(row.getByTestId("detail-button")).toBeVisible();
  });

  /*
   * **競合・失敗などは絞り込みの並びの続き。** 見出しは分けず、件数のあるものだけ出て、押すと一覧がそれで絞られ、
   * もう一度押すと「すべて」に戻る。「続きから観る」「録画中」はサイドバーに置かない
   */
  test("絞り込みの続きの失敗は一覧を絞り、もう一度押すと戻る", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await goto(page, "/");
    const side = page.getByTestId("sidebar");
    await expect(side.getByTestId("continue-item")).toHaveCount(0);
    const failed = side.locator(
      '[data-testid="attention-item"][data-filter="failed"]',
    );
    // よく使うものほど上: カレンダー・状態・絞り込み・表示。失敗は絞り込みと同じ並びの、未視聴より後ろ
    await expect(side.locator("h2.side-label")).toHaveText([
      /\d+年\d+月/,
      "状態",
      "絞り込み",
      "表示",
    ]);
    const filters = side.getByRole("group", { name: "絞り込み" });
    await expect(filters.locator("button").nth(3)).toHaveAttribute(
      "data-filter",
      "unfinished",
    );
    await expect(
      filters.locator('[data-testid="attention-item"][data-filter="failed"]'),
    ).toHaveCount(1);
    await expect(failed).toContainText(/失敗\s*\d+/);
    await failed.click();
    await expect(failed).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page).filter({ hasText: "一覧試験の失敗" })).toHaveCount(
      1,
    );
    await expect(
      rows(page).filter({ hasText: "一覧試験の未視聴" }),
    ).toHaveCount(0);
    await failed.click();
    await expect(
      side.locator('[data-testid="filter"][data-filter="all"]'),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      rows(page).filter({ hasText: "一覧試験の未視聴" }),
    ).toHaveCount(1);
    // 状態 (空き) もサイドバーに出る
    await expect(side.getByTestId("summary")).toContainText("空き");
    // まとめて表示ではカレンダーが消え、残りは同じ順
    await side.getByTestId("recordings-group-toggle").click();
    await expect(side.getByTestId("home-calendar")).toHaveCount(0);
    await expect(side.locator("h2.side-label")).toHaveText([
      "状態",
      "絞り込み",
      "表示",
    ]);
  });

  test("狭い画面は頭の細い1行のチップで1回で絞る", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, "/");
    await homeFilter(page, "failed");
    await expect(rows(page).filter({ hasText: "一覧試験の失敗" })).toHaveCount(
      1,
    );
    await expect(
      rows(page).filter({ hasText: "一覧試験の未視聴" }),
    ).toHaveCount(0);
    // 選んだチップが押された印になる。頭の1行は 44px に収まる
    await expect(
      page.locator('[data-testid="filter-chip"][data-filter="failed"]'),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      (await page.getByTestId("timeline-toolbar").boundingBox())!.height,
    ).toBeLessThanOrEqual(44);
    // スマホでは下のタブのすぐ上に貼り付く (押すものは下に)。上には何も被さらない
    const bar = (await page.getByTestId("timeline-toolbar").boundingBox())!;
    const tabs = (await page.getByTestId("tabbar").boundingBox())!;
    expect(Math.abs(bar.y + bar.height - tabs.y)).toBeLessThanOrEqual(8);
    expect(bar.y).toBeGreaterThan(tabs.y - 100);
    await homeFilter(page, "all");

    // 番組名で探す欄はホームには無い (全体の検索)
    await expect(
      page.getByTestId("timeline-toolbar").getByRole("searchbox"),
    ).toHaveCount(0);
    // チップに件数が出る
    await expect(
      page.locator('[data-testid="filter-chip"][data-filter="all"]'),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator('[data-testid="filter-chip"][data-filter="failed"]'),
    ).toContainText(/失敗\s*\d+/);
  });

  /*
   * **狭い画面では録画の行の操作を「⋯」1つにまとめる。** 詳細と削除のアイコンを並べると番組名が数文字で切れた。
   * 中身は詳細と削除 (削除は1回目で聞き返す)
   */
  test("狭い画面の録画の行は「⋯」から詳細と削除", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, "/");
    const row = rows(page).filter({ hasText: "一覧試験の視聴済み" });
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByTestId("detail-button")).toBeHidden();
    await expect(row.getByTestId("delete-button")).toBeHidden();

    await row.getByTestId("row-more").click();
    const menu = row.getByTestId("row-menu");
    await expect(menu).toBeVisible();
    await menu.getByTestId("row-menu-delete").click();
    // 1回目は聞き返すだけ。メニューは開いたまま
    await expect(menu.getByTestId("row-menu-delete-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await row.getByTestId("row-more").click();
    await menu.getByTestId("row-menu-detail").click();
    await expect(page.getByTestId("program-detail")).toContainText(
      "一覧試験の視聴済み",
    );
  });

  /*
   * **絞り込みを替えても、見ていた行はその場に残る。** 「すべて」に戻したとき一覧の頭まで跳んでいた。
   * 途中まで送り、未視聴に絞って「すべて」に戻すと、同じ行が同じあたりに見えている
   */
  test("絞り込みを外しても、見ていた行のところに留まる", async ({
    page,
    stack,
  }) => {
    const now = Date.now();
    const at = (i: number) => new Date(2098, 0, 1, 21, 0).getTime() - i * DAY;
    sqlite(
      `${stack.root}/denpa.db`,
      `const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, NULL, ${now}, ${now})');
            for (let i = 0; i < 30; i++) rec.run('BS11', 'ずれ試験' + i, 'ずれ試験' + i, ${at(0)} - i * ${DAY}, ${at(0)} - i * ${DAY} + 1800000, ${at(0)} - i * ${DAY} + 1800000, '/media/encoded/seed/p' + i + '.mkv');`,
    );
    try {
      await page.setViewportSize({ width: 1366, height: 768 });
      await goto(page, "/");
      const target = rows(page).filter({ hasText: /^.*ずれ試験15(?!\d)/ });
      await target.scrollIntoViewIfNeeded();
      await page.getByTestId("timeline").evaluate((list, name) => {
        const row = [...list.querySelectorAll<HTMLElement>("[data-key]")].find(
          (r) => (r.textContent ?? "").includes(name),
        );
        // 浮いたヘッダーの下から 80px ほどの所に置く (ページごと巻く)
        const header =
          Number.parseFloat(
            getComputedStyle(document.documentElement).scrollPaddingTop,
          ) || 0;
        if (row)
          window.scrollTo({
            top: window.scrollY + row.getBoundingClientRect().top - header - 80,
          });
      }, "ずれ試験15");
      const before = (await target.boundingBox())!.y;

      await homeFilter(page, "unfinished");
      await expect(target).toBeInViewport();
      await homeFilter(page, "all");
      await expect(target).toBeInViewport();
      expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThan(
        80,
      );
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM recordings WHERE name LIKE 'ずれ試験%'");`,
      );
    }
  });

  /*
   * **古い録画は一覧の頭に足し、足しても読んでいる所は動かない。** 録れたものは線の側 (新しいほう) から
   * 描き、頭の「残り N 件」が見えたら古いほうを上へ足す。広い画面ではページの位置合わせを自分でするので
   * (`overflow-anchor: none`)、何もしないと足したぶん中身が下へずれる
   */
  test("古い録画は上へ足し、足しても見ていた行は動かない", async ({
    page,
    stack,
  }) => {
    const now = Date.now();
    // ほかのスペックが残した未視聴の録画は、いったん観終えたことにする (開いたときにそこまで描かれてしまう。終わったら戻す)
    const unwatched = spawnSync(
      "bun",
      [
        "-e",
        `import { Database } from 'bun:sqlite'; const db = new Database(process.env.SEED_DB); const ids = db.query('SELECT id FROM recordings WHERE watched_at IS NULL').all().map((r) => r.id); db.run('UPDATE recordings SET watched_at = ? WHERE watched_at IS NULL', [Date.now()]); console.log(JSON.stringify(ids));`,
      ],
      {
        env: { ...process.env, SEED_DB: `${stack.root}/denpa.db` },
        encoding: "utf8",
      },
    ).stdout.trim();
    sqlite(
      `${stack.root}/denpa.db`,
      `const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, ${now}, ${now}, ${now})');
            for (let i = 0; i < 90; i++) rec.run('BS11', '足し試験' + i, '足し試験' + i, ${BASE} - (40 + i) * ${DAY}, ${BASE} - (40 + i) * ${DAY} + 1800000, ${BASE} - (40 + i) * ${DAY} + 1800000, '/media/encoded/seed/q' + i + '.mkv');`,
    );
    try {
      await page.setViewportSize({ width: 1366, height: 768 });
      // 全部描かせる `goto` は使わない (足すところを見る)
      await page.goto("/");
      await page.locator('[data-hydrated="true"]').waitFor();
      const more = page.getByTestId("recording-more");
      await expect(more).toBeVisible();
      const list = page.getByTestId("timeline");
      // 開いたときは線のあたり (頭の印は画面の外)
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
      // 描いているうちでいちばん古い行を覚え、頭まで戻して印を画面に入れる。戻した直後の行の高さを覚えておく
      const first = list.locator("[data-key]").first();
      const key = await first.getAttribute("data-key");
      const count = await rows(page).count();
      const y = await first.evaluate((row) => {
        const at = row.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: 0 });
        return at;
      });
      await expect.poll(() => rows(page).count()).toBeGreaterThan(count);
      // 足したぶんは上に入り、見ていた行は同じ高さのまま
      await expect(list.locator("[data-key]").first()).not.toHaveAttribute(
        "data-key",
        key!,
      );
      const row = list.locator(`[data-key="${key}"]`);
      await expect
        .poll(async () => Math.abs((await row.boundingBox())!.y - y))
        .toBeLessThan(2);
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM recordings WHERE name LIKE '足し試験%'"); const s = db.prepare('UPDATE recordings SET watched_at = NULL WHERE id = ?'); for (const id of ${unwatched || "[]"}) s.run(id);`,
      );
    }
  });

  /*
   * **「完了した予約も表示」で、終わった予約とその録画を 1 本にまとめる。** 同じ放送が予約の行と録画の行の
   * 2 本で並んでいた。録画の行が代わりに立ち、録画の名前に無い副題は予約の名前から持ってくる。
   * 録画の無い終わった予約 (取消など) は状態のバッジ付きで残る
   */
  test("完了した予約と、その録画は1本にまとめる", async ({ page, stack }) => {
    const now = Date.now();
    // 終わった予約にするため過去 (ほかの行と紛れないよう 2001 年)
    const at = new Date(2001, 5, 1, 21, 0).getTime();
    sqlite(
      `${stack.root}/denpa.db`,
      `db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, started_at, created_at, updated_at) VALUES (970001, (SELECT id FROM services ORDER BY id LIMIT 1), 'まとめ試験 #3「エルマ」', ${at}, ${at + 1800000}, 1, 'done', ${at}, ${now}, ${now})");
            const id = db.query('SELECT last_insert_rowid() AS id').get().id;
            db.run("INSERT INTO recordings (reservation_id, program_id, service_id, service_name, name, series, start_at, end_at, finished_at, library_path, created_at, updated_at) VALUES (?, 970001, 211, 'BS11', 'まとめ試験', 'まとめ試験', ${at}, ${at + 1800000}, ${at + 1800000}, '/media/encoded/seed/m.mkv', ${now}, ${now})", [id]);
            db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, created_at, updated_at) VALUES (970002, (SELECT id FROM services ORDER BY id LIMIT 1), 'まとめ試験の取消', ${at - DAY}, ${at - DAY + 1800000}, 1, 'canceled', ${now}, ${now})");`,
    );
    try {
      await goto(page, "/?all=1");
      const same = rows(page).filter({ hasText: "まとめ試験 #3" });
      await expect(same).toHaveCount(1);
      await expect(same).toHaveAttribute("data-testid", "recording-row");
      await expect(same.getByTestId("row-open")).toContainText(
        "まとめ試験 #3「エルマ」",
      );
      const canceled = rows(page).filter({ hasText: "まとめ試験の取消" });
      await expect(canceled).toHaveCount(1);
      await expect(canceled.getByTestId("reservation-state")).toHaveText(
        "取り消し済み",
      );
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM recordings WHERE name LIKE 'まとめ試験%'"); db.run("DELETE FROM reservations WHERE name LIKE 'まとめ試験%'");`,
      );
    }
  });

  /*
   * **途中まで観た録画には、ポスターの下端に観たぶんのバーが見える** (4px。地は暗く透かし、観たぶんを主の色で)。
   * 3px の白く透かしたバーは明るいポスターや行の地に溶けて、無いように見えていた
   */
  test("途中まで観た録画は、ポスターの下端に観たぶんのバーが見える", async ({
    page,
    stack,
  }) => {
    const now = Date.now();
    const at = new Date(2098, 5, 1, 21, 0).getTime();
    sqlite(
      `${stack.root}/denpa.db`,
      `db.run("INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, duration_ms, resume_ms, created_at, updated_at) VALUES (211, 'BS11', '続き試験', '続き試験', ${at}, ${at + 1800000}, ${at + 1800000}, '/media/encoded/seed/r.mkv', 1800000, 660000, ${now}, ${now})");`,
    );
    try {
      await page.setViewportSize({ width: 1366, height: 768 });
      await goto(page, "/");
      const row = rows(page).filter({ hasText: "続き試験" });
      await row.scrollIntoViewIfNeeded();
      const bar = row.getByTestId("resume");
      await expect(bar).toBeVisible();
      const track = (await bar.boundingBox())!;
      const fill = (await bar.locator(".resume-fill").boundingBox())!;
      expect(track.height).toBeGreaterThanOrEqual(3);
      // 30 分のうち 11 分観た = 4 割ほど埋まっている
      expect(fill.width).toBeGreaterThan(0);
      expect(fill.width / track.width).toBeGreaterThan(0.3);
      expect(fill.width / track.width).toBeLessThan(0.5);
      await expect(row.locator(".row-meta")).toContainText("残り");
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM recordings WHERE name = '続き試験'");`,
      );
    }
  });

  /*
   * **指で押す端末は行を高くする。** 低い行は押したつもりの隣が開いた。行は 72px 以上、
   * 行の操作は 44px 四方以上。タブレットの縦でも右に欄は出さず、同じ形の行
   */
  /*
   * **今日の見出しは線をまたいで1つ。** 今日の録画、「いま」の線、今日の予約が1つの「今日」の下に並び、
   * 見出しに予約か録画かは書かない。見出しは日ごとの包みの中で貼り付くので、線を越えて今日の予約を
   * 読んでいる間も「今日」が頭に残る (広い画面は一覧の枠、スマホはページごと動く)
   */
  test("今日の見出しは線をまたいで1つで、今日を読む間は頭に貼り付いたまま", async ({
    page,
    stack,
  }) => {
    const now = Date.now();
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    // 今日の中に録画と予約を前後 6 分ずつ置く。0 時の前後で今日に収まらないときは見送る
    test.skip(
      now - midnight < 10 * 60_000 || midnight + DAY - now < 10 * 60_000,
      "0 時の前後",
    );
    const MIN = 60_000;
    // 日付が先の録画 (ほかのテストが見分けに使う 2099 年) は、時計のずれと同じく線の上に別の見出しを立てる。
    // この間だけ消したことにして隠す (`deleted_at = 1` を印に、終わったら戻す)
    sqlite(
      `${stack.root}/denpa.db`,
      `const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, ${now}, ${now}, ${now})');
            const res = db.prepare("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, created_at, updated_at) VALUES (?, (SELECT id FROM services ORDER BY id LIMIT 1), ?, ?, ?, 1, 'scheduled', ${now}, ${now})");
            for (let i = 0; i < 6; i++) {
                rec.run('BS11', '今日試験の録画' + i, '今日試験の録画' + i, ${now} - (7 - i) * ${MIN}, ${now} - (6 - i) * ${MIN}, ${now} - (6 - i) * ${MIN}, '/media/encoded/seed/t' + i + '.mkv');
                res.run(980100 + i, '今日試験の予約' + i, ${now} + (i + 1) * ${MIN}, ${now} + (i + 2) * ${MIN});
            }
            db.run("UPDATE recordings SET deleted_at = 1 WHERE deleted_at IS NULL AND start_at > ?", [${now}]);`,
    );
    try {
      for (const viewport of [
        { width: 1366, height: 560 },
        { width: 390, height: 700 },
      ]) {
        await page.setViewportSize(viewport);
        await goto(page, "/");
        const today = page
          .getByTestId("timeline-day")
          .filter({ hasText: /^今日/ });
        await expect(today).toHaveCount(1);
        // 予約か録画かは書かない (線の上下で分かる)
        await expect(today).toHaveText(/^今日\s*\d{1,2}\/\d{1,2}\(.\)$/);
        // 今日の録画・線・今日の予約が、同じ見出しの包みに入る
        const block = page.locator(".t-block").filter({ has: today });
        await expect(block.getByTestId("timeline-now")).toHaveCount(1);
        await expect(
          block.locator("[data-key]").filter({ hasText: "今日試験の録画0" }),
        ).toHaveCount(1);
        await expect(
          block.locator("[data-key]").filter({ hasText: "今日試験の予約5" }),
        ).toHaveCount(1);

        // 今日の頭の録画から、線を越えて今日の最後の予約まで送る。包みの頭が上へ流れたあとも「今日」は頭に貼り付いている
        const pinned = async (name: string) => {
          const row = rows(page).filter({ hasText: name });
          await row.evaluate((node) =>
            node.scrollIntoView({ block: "center" }),
          );
          return today.evaluate((node, key) => {
            const list = node.closest<HTMLElement>('[data-testid="timeline"]')!;
            // 見出しが貼り付く線 (広い画面は浮いたヘッダーの下端)
            const top = Number.parseFloat(getComputedStyle(node).top) || 0;
            const head = node.getBoundingClientRect();
            const line = [
              ...list.querySelectorAll<HTMLElement>("[data-key]"),
            ].find((r) => (r.textContent ?? "").includes(key))!;
            return {
              head: head.top - top,
              block: node.parentElement!.getBoundingClientRect().top - top,
              row: line.getBoundingClientRect().top - head.bottom,
            };
          }, name);
        };
        for (const name of [
          "今日試験の録画2",
          "今日試験の予約1",
          "今日試験の予約5",
        ]) {
          const at = await pinned(name);
          expect(at.row, `${name} は見出しより下`).toBeGreaterThan(0);
          expect(at.head, `${name} のとき見出しは見えている`).toBeGreaterThan(
            -1,
          );
          if (at.block < -1)
            expect(
              Math.abs(at.head),
              `${name} のとき見出しは頭に`,
            ).toBeLessThan(2);
        }
        // 今日の最後の予約まで送ると、包みの頭 (今日の録画) は上へ流れ、見出しだけが頭に残る
        expect((await pinned("今日試験の予約5")).block).toBeLessThan(-1);
      }
    } finally {
      sqlite(
        `${stack.root}/denpa.db`,
        `db.run("DELETE FROM recordings WHERE name LIKE '今日試験%'"); db.run("DELETE FROM reservations WHERE name LIKE '今日試験%'"); db.run("UPDATE recordings SET deleted_at = NULL WHERE deleted_at = 1");`,
      );
    }
  });

  /*
   * **サイドバーのカレンダーで日を押すと、その日の見出しへ送る。** まだ描いていない古い日 (一覧の頭の「残り N 件」より先) は、
   * そこまで描いてから送る。カレンダーは頭に貼り付いた日を薄く塗り、送った先に付いてくる
   */
  test.describe("サイドバーのカレンダー", () => {
    /** カレンダーをその日の月まで ‹ › で送る (行のある月だけを行き来する) */
    async function showMonth(page: Page, day: number): Promise<void> {
      const calendar = page.getByTestId("home-calendar");
      const want = await page.evaluate((at) => {
        const d = new Date(at);
        return d.getFullYear() * 12 + d.getMonth();
      }, day);
      for (let i = 0; i < 60; i++) {
        const label = await calendar.getByTestId("calendar-month").innerText();
        const [, y, m] = label.match(/(\d+)年(\d+)月/) ?? [];
        const at = Number(y) * 12 + Number(m) - 1;
        if (at === want) return;
        await calendar
          .getByTestId(at > want ? "calendar-prev" : "calendar-next")
          .click();
      }
      throw new Error("その日の月まで行けませんでした");
    }
    /** その日の 0 時 (画面と同じ時刻帯で数える) */
    const startOf = (page: Page, at: number) =>
      page.evaluate((t) => new Date(t).setHours(0, 0, 0, 0), at);

    test("まだ描いていない古い日を押すと、そこまで描いて見出しを頭に出す", async ({
      page,
      stack,
    }) => {
      const now = Date.now();
      // 開いたときに古い未視聴の録画まで描かれないよう、いったん観終えたことにする (足し試験と同じ。終わったら戻す)
      const unwatched = spawnSync(
        "bun",
        [
          "-e",
          `import { Database } from 'bun:sqlite'; const db = new Database(process.env.SEED_DB); const ids = db.query('SELECT id FROM recordings WHERE watched_at IS NULL').all().map((r) => r.id); db.run('UPDATE recordings SET watched_at = ? WHERE watched_at IS NULL', [Date.now()]); console.log(JSON.stringify(ids));`,
        ],
        {
          env: { ...process.env, SEED_DB: `${stack.root}/denpa.db` },
          encoding: "utf8",
        },
      ).stdout.trim();
      sqlite(
        `${stack.root}/denpa.db`,
        `const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, ${now}, ${now}, ${now})');
                for (let i = 0; i < 90; i++) rec.run('BS11', '暦試験' + i, '暦試験' + i, ${BASE} - (40 + i) * ${DAY}, ${BASE} - (40 + i) * ${DAY} + 1800000, ${BASE} - (40 + i) * ${DAY} + 1800000, '/media/encoded/seed/c' + i + '.mkv');`,
      );
      try {
        await page.setViewportSize({ width: 1366, height: 768 });
        // 全部描かせる `goto` は使わない (描いていない日を押す)
        await page.goto("/");
        await page.locator('[data-hydrated="true"]').waitFor();
        await expect(page.getByTestId("recording-more")).toBeVisible();
        const oldest = rows(page).filter({ hasText: /暦試験89(?!\d)/ });
        await expect(oldest).toHaveCount(0);

        const day = await startOf(page, BASE - 129 * DAY);
        await showMonth(page, day);
        const cell = page
          .getByTestId("calendar-day")
          .and(page.locator(`[data-day="${day}"]`));
        await expect(cell).toHaveAttribute("aria-disabled", "false");
        await expect(cell).toHaveAttribute("aria-label", /録画 1件/);
        await cell.click();

        const head = page
          .getByTestId("timeline-day")
          .and(page.locator(`[data-day="${day}"]`));
        await expect(head).toBeInViewport();
        await expect(oldest).toBeInViewport();
        // 見出しは一覧の頭にあり、カレンダーはその日を頭の日として塗る
        // 頭は見出しが貼り付く線 (浮いたヘッダーの下端)
        const top = await head.evaluate(
          (node) => Number.parseFloat(getComputedStyle(node).top) || 0,
        );
        expect(Math.abs((await head.boundingBox())!.y - top)).toBeLessThan(2);
        await expect(cell).toHaveClass(/pinned/);
        // 行の無い日 (いちばん古い日の前の日) は押せない
        const before = await startOf(page, BASE - 129 * DAY - DAY);
        const muted = page.locator(
          `[data-testid="calendar-day"][data-day="${before}"]`,
        );
        if ((await muted.count()) > 0)
          await expect(muted).toHaveAttribute("aria-disabled", "true");
      } finally {
        sqlite(
          `${stack.root}/denpa.db`,
          `db.run("DELETE FROM recordings WHERE name LIKE '暦試験%'"); const s = db.prepare('UPDATE recordings SET watched_at = NULL WHERE id = ?'); for (const id of ${unwatched || "[]"}) s.run(id);`,
        );
      }
    });

    test("先の日を押すと、その日の予約の見出しを頭に出す", async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await goto(page, "/");
      const day = await startOf(page, FUTURE);
      await showMonth(page, day);
      const cell = page
        .getByTestId("calendar-day")
        .and(page.locator(`[data-day="${day}"]`));
      await expect(cell).toHaveAttribute("aria-label", /予約 \d+件/);
      await cell.click();
      const head = page
        .getByTestId("timeline-day")
        .and(page.locator(`[data-day="${day}"]`));
      await expect(head).toBeInViewport();
      await expect(
        rows(page).filter({ hasText: "一覧試験の予約" }),
      ).toBeInViewport();
    });
  });

  test.describe("タブレットの縦", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 820, height: 1180 },
    });

    test("行は幅いっぱいで、行と押すものは指の大きさ", async ({ page }) => {
      await goto(page, "/");
      await expect(page.getByTestId("sidebar")).toBeHidden();
      const row = rows(page).filter({ hasText: "一覧試験の視聴済み" });
      await row.scrollIntoViewIfNeeded();
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(71.5);
      for (const id of ["detail-button", "delete-button"]) {
        const box = (await row.getByTestId(id).boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      }
    });
  });
});
