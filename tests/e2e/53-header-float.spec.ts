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
