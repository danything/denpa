import type { Page } from "@playwright/test";

import { expect, goto } from "./helpers";

/**
 * 実況のテスト (57-jikkyo・57-jikkyo-recorded) の道具
 */

/** 設定画面の「実況」を切り替えて、保存し終えるまで */
export async function setJikkyo(page: Page, on: boolean): Promise<void> {
  await goto(page, "/settings/integrations");
  await page.getByTestId("jikkyo-setting").setChecked(on);
  await expect(page.getByTestId("saved-result")).toBeVisible();
}

/** 勢いの偽物 (`fakeRanking`) を置いたページ */
export const ranked = new WeakSet<Page>();

/** 端末の ⚙ の「実況」をオンにしておく (読み込む前に) */
export async function deviceOn(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("player-jikkyo", "1"));
  /*
   * 両方オンだとライブは「実況」タブで開き、勢いを訊く。サーバから NX-Jikkyo へ行かせないよう、空の返事にしておく
   * (勢いを見るテストの `fakeRanking` が先でも後でも、そちらを使う)
   */
  if (!ranked.has(page))
    await page.route("**/api/jikkyo/ranking", (route) =>
      route.fulfill({ json: { at: Date.now(), channels: [] } }),
    );
}
