import { expect, goto, test } from "./helpers";

/**
 * **予約数ランキングに参加する** (設定の「連携」の「予約数ランキング」。`server/ranking.ts`)。
 *
 * 偽の denpa-hub (`tests/fake/denpa-hub.ts`) がトークンを出し、送られた本文を貯めるので、
 * スイッチをオンにする → トークンを受け取ってすぐ送る → 最後に送った時刻が出る → オフにするとトークンを消す、まで画面で通す。
 * 送る中身・差分・送る時刻のずらし方は単体テスト (`ranking.test.ts`)
 */
interface HubState {
  ranking: { tokens: number; votes: { v: number }[]; revoked: number };
}

test.describe("予約数ランキング", () => {
  test.beforeEach(async ({ request, stack }) => {
    await request.post(`${stack.hubUrl}/__control/ranking`, { data: "ok" });
  });

  test("既定はオフ。オンにするとすぐ送り、オフにするとトークンを消す", async ({
    page,
    request,
    stack,
  }) => {
    const state = async () =>
      (await (
        await request.get(`${stack.hubUrl}/__control/state`)
      ).json()) as HubState;
    const before = (await state()).ranking;

    await goto(page, "/settings/integrations#ranking");
    const toggle = page.getByTestId("ranking-setting");
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("ranking-state")).toHaveCount(0);

    await toggle.setChecked(true);
    await expect(
      page.locator("#ranking").getByTestId("saved-result"),
    ).toBeVisible();
    await expect(page.getByTestId("ranking-state")).toContainText(
      "最後に送った時刻: ",
    );
    const on = (await state()).ranking;
    expect(on.tokens).toBe(before.tokens + 1);
    expect(on.votes.length).toBe(before.votes.length + 1);
    expect(on.votes.at(-1)?.v).toBe(1);

    // 読み直してもオンのまま
    await goto(page, "/settings/integrations#ranking");
    await expect(page.getByTestId("ranking-setting")).toBeChecked();

    await page.getByTestId("ranking-setting").setChecked(false);
    await expect(
      page.locator("#ranking").getByTestId("saved-result"),
    ).toBeVisible();
    await expect(page.getByTestId("ranking-state")).toHaveCount(0);
    const off = (await state()).ranking;
    expect(off.tokens).toBe(before.tokens);
    expect(off.revoked).toBe(before.revoked + 1);
  });

  test("hub がランキングを受け付けていなければ、オフに戻して理由を出す", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.hubUrl}/__control/ranking`, { data: "off" });
    await goto(page, "/settings/integrations#ranking");
    const toggle = page.getByTestId("ranking-setting");
    // 断られるとすぐオフに戻るので、オンになったかは確かめずに押すだけ
    await toggle.click();
    await expect(
      page.locator("#ranking").getByTestId("settings-error"),
    ).toContainText(
      "denpa-hub が予約数ランキングを受け付けていないため、参加できませんでした",
    );
    await expect(toggle).not.toBeChecked();
    await goto(page, "/settings/integrations#ranking");
    await expect(page.getByTestId("ranking-setting")).not.toBeChecked();
  });
});
