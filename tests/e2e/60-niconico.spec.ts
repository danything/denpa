import { expect, goto, test } from "./helpers";

/**
 * **ニコニコのアカウントとの連携** (設定の「連携」の「実況」。`server/niconico.ts`)。
 *
 * 偽の denpa-hub (`tests/fake/denpa-hub.ts`) がその場で偽のトークンを封じて戻り先へ返すので、
 * 「ニコニコと連携」→ hub → 戻り先 → 設定に「連携中」、まで画面で通す。外す・断られた・アクセストークンで断る も見る。
 * 結果の開き方・更新・暗号化の細かいところは単体テスト (`niconico.test.ts`)
 */
test.describe("ニコニコとの連携", () => {
  test.beforeEach(async ({ request, stack }) => {
    await request.post(`${stack.hubUrl}/__control/mode`, { data: "ok" });
  });

  test("連携して、ユーザー ID が出る。外すと元に戻る", async ({ page }) => {
    await goto(page, "/settings/integrations#jikkyo");
    const row = page.getByTestId("niconico");
    // 127.0.0.1 で開いているので、名前で開いたときの案内は出ない
    await expect(row.getByTestId("niconico-named")).toHaveCount(0);
    await row.getByTestId("niconico-link").click();

    // hub から戻り先を通って、設定の「実況」へ戻る
    await page.waitForURL(/\/settings\/integrations#jikkyo$/);
    await expect(page.getByTestId("niconico-state")).toContainText(
      "連携中・ユーザー ID 12345678",
    );

    await page.getByTestId("niconico-unlink").click();
    await expect(
      page.getByText("連携を外しました。ニコニコの側の許可は"),
    ).toBeVisible();
    await expect(page.getByTestId("niconico-link")).toBeVisible();
    await expect(page.getByTestId("niconico-state")).toHaveCount(0);
  });

  test("ニコニコで断ったら、戻り先に理由を出して連携しない", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.hubUrl}/__control/mode`, { data: "deny" });
    await goto(page, "/settings/integrations#jikkyo");
    await page.getByTestId("niconico-link").click();

    await page.waitForURL(/\/settings\/integrations\/niconico\/return$/);
    await expect(page.getByTestId("niconico-return")).toHaveText(
      "ニコニコで許可されなかったため、連携しませんでした",
    );
    // フラグメントは URL から消してある
    expect(new URL(page.url()).hash).toBe("");

    await goto(page, "/settings/integrations#jikkyo");
    await expect(page.getByTestId("niconico-link")).toBeVisible();
  });

  test("連携を始めずに結果だけ送っても保存しない", async ({ request }) => {
    const res = await request.post("/settings/integrations/niconico/finish", {
      data: { result: "AAAA" },
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain("時間が経ったため");
  });

  test("アクセストークン (テレビのアプリ) では連携を始められない", async ({
    request,
  }) => {
    // テレビのアプリと同じようにペアリングしてアクセストークンを貰う (31-device と同じ手順)
    const code = await (
      await request.post("/api/device/code", { data: { name: "E2E の連携" } })
    ).json();
    expect(
      (await request.post("/device", { form: { code: code.userCode } })).ok(),
    ).toBe(true);
    const { token } = await (
      await request.post("/api/device/token", {
        data: { deviceCode: code.deviceCode },
      })
    ).json();
    expect(token).toMatch(/^denpa_/);
    const res = await request.get("/settings/integrations/niconico/link", {
      headers: { authorization: `Bearer ${token}` },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    expect(res.headers()["location"]).toContain("niconico_error=");
  });
});
