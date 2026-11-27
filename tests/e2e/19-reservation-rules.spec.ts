import type { Locator, Page } from "@playwright/test";

import {
  clearRules,
  deleteRule,
  expect,
  goto,
  makeRule,
  syncEpg,
  test,
} from "./helpers";

/**
 * ルールで立った予約まわり。
 *
 * ルールが作った予約を手で取り消すと、以後ルールは作り直さない
 * (同じ番組を二度と勝手に立てないため)。気が変わったときの戻し方と、
 * ルールそのものへ辿る経路をここで見る。
 */
test.describe("ルールで立った予約", () => {
  test.beforeEach(async ({ page, request }) => {
    await syncEpg(request);
    // 前のテストが残したルールを片付ける
    await clearRules(page);
    // 偽の放送は同じタイトルを何度も流す。見たいのは予約が立つことなので、同じ回を 1 度にまとめない
    await page.setViewportSize({ width: 1440, height: 900 });
    await makeRule(page, "テストアニメ", { dedupe: false });
  });

  test.afterEach(async ({ page }) => {
    await clearRules(page);
  });

  test("取り消したあと戻せる", async ({ page }) => {
    await goto(page, "/");
    /*
     * 先に走ったテストが残した予約と混ざらないよう、いま立っているものから選ぶ。
     *
     * **いちばん先の予約** (一覧の末尾) を取る。予約は「いま」の行の下に近い順に並ぶ。偽エージェントの番組は
     * 10 秒しかないため、「いま」の行に近いものは取り消して開き直す間に放送が終わってしまう。終わった予約は
     * 戻しても意味が無いので、戻すボタン自体が出ない
     */
    const row = page
      .getByTestId("reservation-row")
      .filter({ hasText: "テストアニメ" })
      .filter({ has: page.getByTestId("cancel-button") })
      .last();
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-reservation-id");

    await row.getByTestId("cancel-button").click();
    // 進行中の一覧からは消える
    await expect(page.locator(`[data-reservation-id="${id}"]`)).toHaveCount(0);

    // ルールは作り直さないので、戻せるのはここだけ。
    // 状態の表示そのものは見ない (番組が始まっていると録画中を経由する)
    await goto(page, "/?all=1");
    const canceled = page.locator(`[data-reservation-id="${id}"]`);
    await expect(canceled.getByTestId("restore-button")).toBeVisible();
    await canceled.getByTestId("restore-button").click();

    /*
     * 進行中の一覧に戻ってくれば戻せている。
     * 状態そのものは見ない。偽エージェントの番組は 10 秒で始まるので、戻した直後に
     * 録画中へ進んでいることがある (「取り消し」でなくなっていることが要点)
     */
    await goto(page, "/");
    await expect(page.locator(`[data-reservation-id="${id}"]`)).toBeVisible();
    await expect(
      page
        .locator(`[data-reservation-id="${id}"]`)
        .getByTestId("restore-button"),
    ).toHaveCount(0);
  });

  /*
   * **実機で踏んだところ。** 取り消し済みのぶんをルールとの紐付けだけ外して残していた頃は、それが後から
   * `scheduled` に戻ると、消したはずのルールの予約が「ルール: (削除済み)」として一覧に並んだ (実機で 45 件)。
   * そのあと消すようにしたが、消すと取り消しの記録が無くなり、取り消しより前に保存したほかのルールが
   * その回を録ってしまう (後勝ち、#3239)。いまは手動予約の取り消しとして残す (「戻す」で手動予約として録れる)
   */
  test("ルールを消すと、取り消し済みのぶんは手動予約の取り消しとして残る", async ({
    page,
  }) => {
    await goto(page, "/");
    const row = page
      .getByTestId("reservation-row")
      .filter({ hasText: "テストアニメ" })
      .filter({ has: page.getByTestId("cancel-button") })
      .last();
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-reservation-id");
    await row.getByTestId("cancel-button").click();

    // 取り消し済みとしては残っている
    await goto(page, "/?all=1");
    await expect(page.locator(`[data-reservation-id="${id}"]`)).toBeVisible();

    await goto(page, "/rules");
    await deleteRule(page.getByTestId("rule-row").first());
    await expect(page.getByTestId("rule-row")).toHaveCount(0);

    await goto(page, "/?all=1");
    const kept = page.locator(`[data-reservation-id="${id}"]`);
    await expect(kept.getByTestId("rule-name")).toHaveText("手動予約");
    await expect(kept.getByTestId("restore-button")).toBeVisible();
  });

  test("ルール名からそのルールの編集に飛べる", async ({ page }) => {
    await goto(page, "/");
    const row = page
      .getByTestId("reservation-row")
      .filter({ hasText: "テストアニメ" })
      .filter({ has: ruleLink(page) })
      .first();
    // 行にボタンを足すと窮屈になるので、出しているルール名をそのまま入口にする
    await row.getByTestId("rule-name").getByRole("link").click();

    await expect(page.getByTestId("rule-mode")).toContainText("編集中");
    await expect(page.getByTestId("rule-keyword")).toHaveValue("テストアニメ");
  });

  /*
   * **録れたあとも、どのルールが当たったのかが分かる。**
   *
   * 予約の側にしか出していなかった頃は、録画一覧に要らないものが混ざっていても
   * 直す先 (どのルールの条件か) が画面から辿れなかった。予約は録り終えると
   * 一覧から消えるので、番組名からルールを推し量るしかない。
   *
   * ルールを消したあとも録画そのものは履歴として残る。紐付けだけ外れるので
   * 「(削除済み)」になる (rules の delete がそうしている)
   */
  test("録れたあとも、どのルールで録れたかが残る", async ({ page }) => {
    test.setTimeout(180_000);
    await goto(page, "/");
    /*
     * **いちばん早い予約**を取る。予約は「いま」の行の下に近い順に並ぶので、「いま」の行に近い最初のもの。
     * 先のものを選ぶと放送そのものが数分先になる (偽の番組表は 10 分ぶんある)
     */
    const reservation = page
      .getByTestId("reservation-row")
      .filter({ hasText: "テストアニメ" })
      .filter({ has: ruleLink(page) })
      .first();
    await expect(reservation).toBeVisible();
    // 番組で辿る。同じ名前の録画は他のテストも残すので、名前では絞れない
    const programId = await reservation.getAttribute("data-program-id");

    const recording = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await expect(async () => {
      await goto(page, "/");
      await expect(recording).toHaveCount(1);
    }).toPass({ timeout: 120_000 });
    await expect(recording.getByTestId("rule-name")).toContainText(
      "テストアニメ",
    );
    // ルール名はそのまま編集 (検索の画面) への入口。予約の行と同じ形
    await expect(
      recording.getByTestId("rule-name").getByRole("link"),
    ).toHaveAttribute("href", /\/search\?rule=\d+$/);

    await goto(page, "/rules");
    await deleteRule(page.getByTestId("rule-row").first());
    await expect(page.getByTestId("rule-row")).toHaveCount(0);

    await goto(page, "/");
    await expect(recording.getByTestId("rule-name")).toContainText(
      "(削除済み)",
    );
  });
});

/**
 * いまあるルールへのリンクが付いたルール名。前のテストのルールで録り始めた予約は、そのルールを消すと
 * 「ルール: (削除済み)」になって一覧に残る (`rule-actions.ts` の `deleteRule`)。ルール名だけで選ぶとそれを拾い、
 * CI では録画の行が「(削除済み)」のまま 30 秒たった
 */
function ruleLink(page: Page): Locator {
  return page.getByTestId("rule-name").getByRole("link");
}
