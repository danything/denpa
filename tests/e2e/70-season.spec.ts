import type { Page } from "@playwright/test";

import { expect, goto, test } from "./helpers";

/**
 * **季節の演出** (docs/screens.md「季節の演出」)。年越しのカウントダウン・紙吹雪・正月のロゴの飾り・「denpa の 1 年」。
 *
 * 日付はサーバの時計で決めるので、ブラウザの時計 (`page.clock`) と一緒に、サーバの時刻を渡す `GET /api/season` の `now` も
 * 同じ時刻に差し替える (サーバそのものの時計はほかのスペックと共有していて動かせない)。ライブの放送の時刻は、
 * サーバの今から放送からの遅れを引いたものなので、これで年越しの前に置ける
 */

const HOUR = 3_600_000;

/** 日本時間の日時 (unix ms) */
function jst(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour - 9, minute, second);
}

/**
 * ブラウザの時計とサーバの時刻を `at` に置く (どちらもそこから普通に進む)
 */
async function pretendNow(page: Page, at: number): Promise<void> {
  await page.clock.install({ time: at });
  const start = Date.now();
  await page.route("**/api/season", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...body, now: at + (Date.now() - start) },
    });
  });
}

/**
 * 「denpa の 1 年」のチップは閉じると世帯でその年は出さない。やり直し (retries) でも前の回に閉じた年と重ならないよう、回ごとに違う年を使う
 */
function freshYear(): number {
  return 2100 + Math.floor(Math.random() * 7000);
}

/** 世帯の設定「季節の演出」を切り替える (設定の「その他」) */
async function setSeasonal(page: Page, on: boolean): Promise<void> {
  await goto(page, "/settings/general");
  const toggle = page.getByTestId("seasonal-toggle");
  if ((await toggle.isChecked()) === on) return;
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/settings/general") && r.request().method() === "POST",
  );
  await toggle.click();
  await saved;
  await expect(toggle).toBeChecked({ checked: on });
}

test.describe("年越しのカウントダウン", () => {
  test("12/31 23:59:50 からライブの右下に秒を出し、0:00 に真ん中にあいさつを出して消える。動きを減らす設定では紙吹雪を出さない", async ({
    page,
  }) => {
    await pretendNow(page, jst(2026, 12, 31, 23, 59, 38));
    await goto(page, "/live");
    const countdown = page.getByTestId("live-new-year");
    await expect(countdown).toHaveAttribute("data-kind", "count", {
      timeout: 30_000,
    });
    await expect(countdown).toHaveText(/^\s*([1-9]|10)\s*$/);
    await expect(countdown).toHaveAttribute("data-kind", "greet", {
      timeout: 15_000,
    });
    await expect(countdown).toHaveText("あけましておめでとうございます");
    await expect(page.getByTestId("live-new-year-confetti")).toHaveCount(0);
    await expect(countdown).toHaveCount(0, { timeout: 10_000 });
  });

  test("季節の演出をオフにすると出さない", async ({ page }) => {
    await setSeasonal(page, false);
    try {
      await pretendNow(page, jst(2026, 12, 31, 23, 59, 48));
      await goto(page, "/live");
      // 0:00 を過ぎるまで待っても出ない
      await page.waitForTimeout(15_000);
      await expect(page.getByTestId("live-new-year")).toHaveCount(0);
    } finally {
      await page.unrouteAll();
      await setSeasonal(page, true);
    }
  });
});

test.describe("年越しの紙吹雪", () => {
  test.use({ reducedMotion: "no-preference" });

  test("実況を開いていなければ、0:00 に少しだけ降らせて消す", async ({
    page,
  }) => {
    await pretendNow(page, jst(2026, 12, 31, 23, 59, 45));
    await goto(page, "/live");
    const confetti = page.getByTestId("live-new-year-confetti");
    await expect(confetti).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("live-new-year")).toHaveAttribute(
      "data-kind",
      "greet",
    );
    await expect(confetti).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe("正月", () => {
  test("1 月 1 日はヘッダーのロゴに飾りが付き、録画の一覧の上の「denpa の 1 年」のチップから去年の数を開ける。閉じたらその年は出さない", async ({
    page,
  }) => {
    const year = freshYear();
    await pretendNow(page, jst(year, 1, 1, 10));
    await goto(page, "/");
    await expect(page.getByTestId("new-year-mark")).toBeVisible();
    const chip = page.getByTestId("year-chip");
    await expect(chip).toContainText(`denpa の ${year - 1} 年`);

    await page.getByTestId("year-chip-open").click();
    const dialog = page.getByTestId("year-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "あけましておめでとうございます。今年もよろしくお願いします",
    );
    await expect(dialog).toContainText(`denpa の ${year - 1} 年`);
    await page.getByTestId("year-dialog-close").click();
    await expect(dialog).toBeHidden();

    // 開き直しても、期間の間は出たまま
    await page.reload();
    await page.locator('[data-hydrated="true"]').waitFor();
    await expect(chip).toBeVisible();

    // ✕ で閉じると、開き直してももう出さない (ロゴの飾りは出たまま)
    await page.getByTestId("year-chip-close").click();
    await expect(chip).toHaveCount(0);
    const asked = page.waitForResponse((r) => r.url().endsWith("/api/season"));
    await page.reload();
    await asked;
    await page.locator('[data-hydrated="true"]').waitFor();
    await expect(page.getByTestId("new-year-mark")).toBeVisible();
    await page.waitForTimeout(2_000);
    await expect(chip).toHaveCount(0);
  });

  test("1 月 8 日からはロゴの飾りもチップも出さない", async ({ page }) => {
    await pretendNow(page, jst(freshYear(), 1, 8, 10));
    await goto(page, "/");
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("new-year-mark")).toHaveCount(0);
    await expect(page.getByTestId("year-chip")).toHaveCount(0);
  });

  test("1 月 4 日からはロゴの飾りを出さない (チップは 7 日まで)", async ({
    page,
  }) => {
    await pretendNow(page, jst(freshYear(), 1, 4, 10));
    await goto(page, "/");
    await expect(page.getByTestId("year-chip")).toBeVisible();
    await expect(page.getByTestId("new-year-mark")).toHaveCount(0);
  });

  test("季節の演出をオフにすると、ロゴの飾りもチップも出さない", async ({
    page,
  }) => {
    await setSeasonal(page, false);
    try {
      await pretendNow(page, jst(freshYear(), 1, 1, 10) + HOUR);
      await goto(page, "/");
      await page.waitForTimeout(3_000);
      await expect(page.getByTestId("new-year-mark")).toHaveCount(0);
      await expect(page.getByTestId("year-chip")).toHaveCount(0);
    } finally {
      await page.unrouteAll();
      await setSeasonal(page, true);
    }
  });
});
