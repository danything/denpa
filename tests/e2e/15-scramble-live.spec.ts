import { expect, goto, test } from "./helpers";

/**
 * **ライブで局がスクランブルされたまま届いたら、理由を出して止める** (`server/live.ts` の `SCRAMBLE_PACKETS`)。
 *
 * 本物のエージェントは、カードが鍵を返さなかった (未契約の) 局をスクランブルされたまま流す。それを ffmpeg に渡すと
 * `Failed to set value '0:p:201:s:0' for option 'map'` で降りて、画面は何も出ないまま止まっていた
 * (BS10プレミアムをケーブルで受けたときに実機で出た)。
 * 録画がスクランブルされたまま録れたときは `15-scramble`
 */
test.describe("ライブで局がスクランブルされたまま届いたとき", () => {
  test.afterEach(async ({ request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/unentitled?on=0`);
    await request.post(`${stack.agentUrl}/__control/scrambled?on=0`);
  });

  test("カードを読めていれば、契約されていないためと言う", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.agentUrl}/__control/unentitled?on=1`);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-status")).toContainText(
      "この局は契約されていないため、スクランブルを復号できませんでした",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("live-retry")).toBeVisible();
  });

  test("カードを読めなければ、そう言う", async ({ page, request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/scrambled?on=1`);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-status")).toContainText(
      "B-CAS カードを読めないため、スクランブルを復号できませんでした",
      { timeout: 20_000 },
    );
  });
});
