import {
  clearWebhooks,
  expect,
  expectTokenRefused,
  goto,
  pairToken,
  syncEpg,
  test,
} from "./helpers";

/**
 * 録画の節目を外部に飛ばす。
 * 録画の失敗は画面を開くまで気づけないので、届くことをここで確かめておく。
 */
test.describe("通知", () => {
  test.beforeEach(async ({ page, request, stack }) => {
    await syncEpg(request);
    await request.post(`${stack.webhookUrl}/__control/reset`);
    // 前のテストが残した通知先を消す
    await clearWebhooks(page);
  });

  test("通知先を追加してテスト送信すると、相手に届く", async ({
    page,
    request,
    stack,
  }) => {
    await goto(page, "/settings/integrations");
    await page
      .getByTestId("webhook-url")
      .fill(`${stack.webhookUrl}/__control/webhook`);
    await page.getByTestId("webhook-add").click();

    const row = page.getByTestId("webhook-row").first();
    await expect(row).toContainText("/__control/webhook");
    // 何も選ばなければ全部送る
    await expect(row).toContainText("すべて");
    await expect(row).toContainText("未送信");

    await row.getByTestId("webhook-test").click();
    await expect(page.getByTestId("webhook-tested")).toContainText(
      "届きました",
    );
    /*
     * 通知の種類は頭のアイコンで示す (docs/design.md の「通知」)。左の縦線は「選んでいる」の印なので引かない。
     * アイコンだけが状態の色 (`--dp-ok-text`) で、地は操作の層の面 (`--dp-pop`)
     */
    const look = await page.getByTestId("webhook-tested").evaluate((el) => {
      const own = getComputedStyle(el);
      const mark = getComputedStyle(el, "::before");
      const probe = (value: string) => {
        const span = document.createElement("span");
        span.style.color = value;
        document.body.append(span);
        const color = getComputedStyle(span).color;
        span.remove();
        return color;
      };
      return {
        border: own.borderLeftWidth,
        background: own.backgroundColor,
        pop: probe("var(--dp-pop)"),
        mask: mark.maskImage,
        mark: mark.backgroundColor,
        ok: probe("var(--dp-ok-text)"),
      };
    });
    expect(look.border).toBe("0px");
    expect(look.background).toBe(look.pop);
    expect(look.mask).toContain("data:image/svg+xml");
    expect(look.mark).toBe(look.ok);

    const state = await (
      await request.get(`${stack.webhookUrl}/__control/state`)
    ).json();
    expect(state.webhookCalls).toHaveLength(1);
    expect(state.webhookCalls[0].event).toBe("recording.finished");
    expect(state.webhookCalls[0].text).toContain("テスト送信");

    // 直近の結果が残る。届いていないことに気づけるように
    await expect(page.getByTestId("webhook-row").first()).toContainText("成功");
  });

  test("送る通知を選べる", async ({ page, stack }) => {
    await goto(page, "/settings/integrations");
    await page
      .getByTestId("webhook-url")
      .fill(`${stack.webhookUrl}/__control/webhook`);
    await page
      .getByTestId("webhook-events")
      .locator('input[value="recording.failed"]')
      .check();
    await page.getByTestId("webhook-add").click();

    const row = page.getByTestId("webhook-row").first();
    await expect(row).toContainText("録画失敗");
    await expect(row).not.toContainText("すべて");
  });

  test("URL が不正なら断る", async ({ page }) => {
    await goto(page, "/settings/integrations");
    await page.getByTestId("webhook-url").fill("not-a-url");
    await page.getByTestId("webhook-add").click();
    await expect(page.getByTestId("settings-error")).toContainText(
      "http(s) で始まる URL",
    );
    await expect(page.getByTestId("webhook-row")).toHaveCount(0);
  });

  test("アクセストークンでは通知先を追加・切り替え・削除・テスト送信できない", async ({
    page,
    request,
    stack,
  }) => {
    // ブラウザ (信頼するネットワーク) からは追加できる
    await goto(page, "/settings/integrations");
    await page
      .getByTestId("webhook-url")
      .fill(`${stack.webhookUrl}/__control/webhook`);
    await page.getByTestId("webhook-add").click();
    const row = page.getByTestId("webhook-row");
    await expect(row).toHaveCount(1);
    const id = await row.locator('input[name="id"]').first().inputValue();

    const token = await pairToken(request, "E2E の通知");
    await expectTokenRefused(request, token, stack.appUrl, "addWebhook", {
      url: `${stack.webhookUrl}/__control/webhook`,
    });
    for (const action of ["toggleWebhook", "testWebhook", "deleteWebhook"])
      await expectTokenRefused(request, token, stack.appUrl, action, { id });

    // 何も変わっていない (増えない・無効にならない・消えない・送っていない)
    await goto(page, "/settings/integrations");
    await expect(row).toHaveCount(1);
    await expect(row).not.toContainText("無効");
    await expect(row).toContainText("未送信");
    const state = await (
      await request.get(`${stack.webhookUrl}/__control/state`)
    ).json();
    expect(state.webhookCalls).toHaveLength(0);
  });

  test("無効にした通知先には送らない", async ({ page, request, stack }) => {
    await goto(page, "/settings/integrations");
    await page
      .getByTestId("webhook-url")
      .fill(`${stack.webhookUrl}/__control/webhook`);
    await page.getByTestId("webhook-add").click();
    await page.getByTestId("webhook-toggle").first().click();
    await expect(page.getByTestId("webhook-row").first()).toContainText("無効");

    // 無効でもテスト送信は通る(疎通確認のため)。届かないのは自動の通知のほう
    const state = await (
      await request.get(`${stack.webhookUrl}/__control/state`)
    ).json();
    expect(state.webhookCalls).toHaveLength(0);
  });
});
