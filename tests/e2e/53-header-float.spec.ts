import type { Page } from "@playwright/test";

import { expect, goto, test } from "./helpers";

/**
 * **広い画面のヘッダーは、巻くと浮き、上端と巻けない画面では平ら** (docs/design.md の「浮かせ方」)。
 *
 * 面と影は窓の巻いた量で進むアニメーション (`+layout.svelte`)。巻けない画面へ移ると時間の軸が止まり、
 * Chrome は止まる前の値を残すので、長いページで巻いてから短いページへ移ると浮いたままになっていた。
 * ほかのスペックは動きを止めて流す (いつも浮いた形になる) ので、ここだけ動きを許す
 */
test.use({
  viewport: { width: 1280, height: 720 },
  reducedMotion: "no-preference",
});

/** ヘッダーの面が透明か */
function flat(page: Page) {
  return page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".navbar")!).backgroundColor ===
      "rgba(0, 0, 0, 0)",
  );
}

test("巻くと浮き、巻けない画面へ移ると平らに戻る", async ({ page }) => {
  await goto(page, "/settings");
  const scrollable = await page.evaluate(
    () =>
      document.scrollingElement!.scrollHeight -
      document.scrollingElement!.clientHeight,
  );
  // 浮くのを見るには、設定の画面がヘッダーの浮く量 (1.5rem) より長く巻ける必要がある
  expect(scrollable).toBeGreaterThan(24);
  await expect.poll(() => flat(page)).toBe(true);

  await page.mouse.wheel(0, 2000);
  await expect.poll(() => flat(page)).toBe(false);

  // ルールが空なら巻けない画面。巻けるときは上端に戻した姿を見る
  await page.locator('.navbar a[href="/rules"]').first().click();
  await page.waitForURL("**/rules");
  await expect.poll(() => flat(page)).toBe(true);
});

/** 番組表の時の列と左上の角の面の濃さ (透明度で出し入れする。`guide/+page.svelte`) */
function guideFloat(page: Page) {
  return page.evaluate(() => ({
    corner: Number(
      getComputedStyle(document.querySelector(".corner")!).opacity,
    ),
    hour: Number(
      getComputedStyle(document.querySelector(".hour")!, "::before").opacity,
    ),
  }));
}

/*
 * **番組表の時の列は、横に送ってマスが裏に入ったときだけ浮く** (docs/design.md の「浮かせ方」)。
 * 左上の角は、横に送ると局名が、縦に巻くと時の数字が裏に来るので、どちらを巻いても浮く
 */
test("番組表の時の列は横に送ると浮き、角は横か縦に巻くと浮く", async ({
  page,
}) => {
  // 合成のデータは局が少ないので、横に送れる狭い幅にする (面の出し方は幅によらず同じ)
  await page.setViewportSize({ width: 320, height: 700 });
  await goto(page, "/guide?type=GR");
  const grid = page.getByTestId("guide-grid");
  await expect(page.getByTestId("guide-service").first()).toBeVisible();
  const scroll = (left: number, top: number) =>
    grid.evaluate(
      (el, [l, t]) => el.scrollTo({ left: l!, top: t!, behavior: "instant" }),
      [left, top],
    );

  await scroll(0, 0);
  await expect.poll(() => guideFloat(page)).toEqual({ corner: 0, hour: 0 });

  await scroll(60, 0);
  await expect.poll(() => guideFloat(page)).toEqual({ corner: 1, hour: 1 });

  // 縦だけ巻くと、時の列の裏にマスは来ない。角の裏には時の数字が来る
  await scroll(0, 400);
  await expect.poll(() => guideFloat(page)).toEqual({ corner: 1, hour: 0 });
});

test.describe("動きを減らす設定", () => {
  test.use({ reducedMotion: "reduce" });

  test("番組表の時の列と角は、上端でも浮いた形のまま", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await goto(page, "/guide?type=GR");
    await expect(page.getByTestId("guide-service").first()).toBeVisible();
    await page
      .getByTestId("guide-grid")
      .evaluate((el) => el.scrollTo({ left: 0, top: 0, behavior: "instant" }));
    await expect.poll(() => guideFloat(page)).toEqual({ corner: 1, hour: 1 });
  });
});
