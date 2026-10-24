import { rmSync } from "node:fs";

import { expect, goto, homeTools, recordOne, test } from "./helpers";

/**
 * 録画ファイルを denpa の外から消したときに、一覧からも消えることを確認する。
 * ファイルマネージャや別のマシンから消されることがあるので、
 * ここでも同じようにファイルを消して、denpa がそれに気づけるかを見る。
 */
test.describe("外で消された録画の反映", () => {
  test("外で消した録画が一覧から消え、削除済みとして残る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    const { id: recordingId, libraryPath } = await recordOne(page, request);
    expect(libraryPath).toContain(stack.encodedDir);

    // ファイルが在るうちは照合しても何も起きない
    await (await homeTools(page)).getByTestId("reconcile-button").click();
    await expect(page.getByTestId("reconcile-result")).toContainText(
      "削除済みにした 0 件",
    );
    await expect(
      page.locator(`[data-recording-id="${recordingId}"]`),
    ).toHaveCount(1);

    // 外から消されたのと同じことをする
    rmSync(libraryPath);

    await (await homeTools(page)).getByTestId("reconcile-button").click();
    await expect(page.getByTestId("reconcile-result")).toContainText(
      "削除済みにした 1 件",
    );

    // 現存一覧からは消え、「削除済みも表示」にすると履歴として残っている
    await goto(page, "/");
    await expect(
      page.locator(`[data-recording-id="${recordingId}"]`),
    ).toHaveCount(0);

    await goto(page, "/?deleted=1");
    const row = page.locator(`[data-recording-id="${recordingId}"]`);
    await expect(row).toContainText("削除済み");

    // 消えた理由は行ではなく詳細に出す (生の文言で行が分厚くならないように)。
    // 観られない行に詳細ボタンは無い — 行そのものが詳細の入口
    await row.click();
    await expect(page.getByTestId("detail-error")).toContainText(
      "保存先から消えていました",
    );

    // 消した録画の観る画面 (410) は、理由のカードと一覧へ戻るリンクを出す (`+error.svelte`)
    await goto(page, `/watch/${recordingId}`);
    const card = page.getByTestId("error-page");
    await expect(card).toContainText("この録画は削除されています");
    await expect(card).toContainText("410");
    await card.getByTestId("error-home").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("timeline")).toBeVisible();
  });
});
