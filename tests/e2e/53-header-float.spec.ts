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

/**
 * **本文へ移動のリンクは、キーボードで Tab を押したときだけ左上に出る** (`+layout.svelte` の `.skip`)。
 * 押すと本文 (`main`) に焦点が移り、次の Tab は本文の中から始まる。設定の画面が `#` を節の名前として読むので、URL は変えない
 */
test("Tab で「本文へ移動」が出て、Enter で本文へ焦点が移る", async ({
  page,
}) => {
  await goto(page, "/rules");
  const skip = page.getByTestId("skip-to-main");
  const box = async () => (await skip.boundingBox())!;
  // ふだんは画面の上の外
  expect((await box()).y + (await box()).height).toBeLessThanOrEqual(0);

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toHaveText("本文へ移動");
  expect((await box()).y).toBeGreaterThanOrEqual(0);

  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("");
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.querySelector("main")!.contains(document.activeElement),
    ),
  ).toBe(true);
  // 焦点が離れたら、また画面の外へ
  expect((await box()).y + (await box()).height).toBeLessThanOrEqual(0);
});

/**
 * **明暗を選び直すと、画面全体が前の色から次の色へ移る** (`theme.svelte.ts` の `crossfade`。View Transitions の種類 `theme`)。
 * 開いたときは `app.html` が描く前に色を当てるので、移り変わりは走らない (白から黒へ一瞬見えない)
 */
test("明暗を選び直したときだけ画面全体が移り、開いたときは移らない", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { kinds: string[][] };
    w.kinds = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((
      arg: Parameters<Document["startViewTransition"]>[0],
    ) => {
      w.kinds.push(
        typeof arg === "object" && arg !== null ? [...(arg.types ?? [])] : [],
      );
      return start(arg);
    }) as Document["startViewTransition"];
  });
  const kinds = () =>
    page.evaluate(() => (window as unknown as { kinds: string[][] }).kinds);
  const html = page.locator("html");

  await goto(page, "/");
  await expect(html).toHaveAttribute("data-theme", "dark");
  // 開いた直後は写しを取らない
  expect(await kinds()).toEqual([]);

  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await kinds()).toEqual([["theme"]]);

  // 読み直しても、選んだ色で描かれ、移り変わりは走らない
  await goto(page, "/");
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await kinds()).toEqual([]);

  // 動きを減らす設定では写しを取らず、すぐ替える
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await kinds()).toEqual([]);
});
