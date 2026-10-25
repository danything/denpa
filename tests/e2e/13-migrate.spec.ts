import { clearRules, expect, goto, syncEpg, test } from "./helpers";

/**
 * EPGStation からの引き継ぎ。偽の EPGStation (`tests/fake/epgstation.ts`。v3、番組名は作り物) に向けて、
 * 下見 → 取り込みで録画とルールが入ること、繋がらない URL ではその場で理由が出ることを見る。
 * 続きから取る・長さを確かめる・空きが足りないときなどの細かいところは単体テスト (`migrate-import.test.ts`)
 */
test.describe("EPGStation からの引き継ぎ", () => {
  test.beforeEach(async ({ request, stack }) => {
    // 偽 EPGStation の振る舞いを既定 (v3・切らない) に戻す
    await request.post(`${stack.epgstationUrl}/__control/mode`, { data: {} });
  });

  test("繋がらない URL では始めず、理由が出る", async ({ page }) => {
    await goto(page, "/settings/integrations");
    await page.getByTestId("epgstation-url").fill("http://127.0.0.1:1");
    await page.getByTestId("migrate-run").click();

    // 裏で走らせてから失敗にしない。押した結果としてその場で出る
    await expect(page.getByTestId("settings-error")).toContainText(
      "EPGStation (http://127.0.0.1:1) に繋がりません",
    );
    // 入れた URL は欄に残る
    await expect(page.getByTestId("epgstation-url")).toHaveValue(
      "http://127.0.0.1:1",
    );
  });

  test("下見をして、取り込める", async ({ page, request, stack }) => {
    await syncEpg(request);
    await goto(page, "/settings/integrations");
    await page.getByTestId("epgstation-url").fill(stack.epgstationUrl);
    // 既定は下見。チェックを入れない限りファイルもDBも触らない
    await expect(page.getByTestId("migrate-apply")).not.toBeChecked();
    await page.getByTestId("migrate-run").click();
    await expect(page.getByTestId("migrate-started")).toBeVisible();

    const progress = page.getByTestId("migrate-progress");
    await expect(progress).toHaveAttribute("data-state", "done");
    // 正規表現と時刻指定のルールは飛ぶ
    await expect(page.getByTestId("migrate-rules")).toContainText(
      "ルール 2 件 / 対象外 2 件",
    );
    // ルールで録った録画 (録画中のものも) を履歴に入れる
    await expect(page.getByTestId("migrate-history")).toContainText(
      "録画の履歴 2 件",
    );
    const log = page.getByTestId("migrate-log");
    await expect(log).toContainText("EPGStation 3.0.0-beta4");
    await expect(log).toContainText("取り込む(予定): 引き継ぎテスト #1");
    await expect(log).toContainText("正規表現のルールは取り込めません");
    await expect(log).toContainText(
      "BS4K は denpa に無いので種別から外しました",
    );
    // 取ってくる大きさと置き場の空き
    await expect(log).toContainText("取り込む 3 件");
    await expect(log).toContainText("空き");
    await expect(page.getByTestId("epgstation-url")).toHaveValue(
      stack.epgstationUrl,
    );

    await page.getByTestId("migrate-apply").check();
    await page.getByTestId("migrate-run").click();
    await expect(log).toContainText("取り込む: 引き継ぎテスト #1");
    await expect(progress).toHaveAttribute("data-state", "done");
    // ファイルの無いものと、取りに行くと 404 のものは「ファイル無し」
    await expect(page.getByTestId("migrate-recordings")).toContainText(
      "新規 2 件 / 取り込み済み 0 件 / ファイル無し 2 件 / 失敗 0 件",
    );

    // もう一度回しても増えない
    await page.getByTestId("migrate-apply").check();
    await page.getByTestId("migrate-run").click();
    await expect(page.getByTestId("migrate-recordings")).toContainText(
      "新規 0 件 / 取り込み済み 2 件",
    );
    await expect(progress).toHaveAttribute("data-state", "done");

    await goto(page, "/rules");
    await expect(
      page.getByTestId("rule-row").filter({ hasText: "引き継ぎテスト" }),
    ).toHaveCount(1);
    await clearRules(page);

    // 入った録画を消しておく (同じワーカーのほかのテストが数える録画を乱さない)
    const list = (await (await request.get("/api/recordings")).json()) as {
      id: number;
      name: string;
    }[];
    const imported = list.filter((item) =>
      item.name.startsWith("引き継ぎテスト"),
    );
    expect(imported.map((item) => item.name).sort()).toEqual([
      "引き継ぎテスト #1",
      "引き継ぎテスト #2",
    ]);
    for (const item of imported) {
      const res = await request.delete(`/api/recordings/${item.id}`, {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status()).toBe(204);
    }
  });
});

/**
 * EDCB からの引き継ぎ。偽の EpgTimerSrv (`tests/fake/edcb.ts`。番組名は作り物) に TCP で繋いで、
 * 下見で件数と記録が出ること、取り込むとルールが入ること、アクセス制御で切られたらその場で理由が出ることを見る。
 * 細かい読み方と写し方は単体テスト (`edcb-ctrlcmd.test.ts`・`migrate-edcb.test.ts`)
 */
test.describe("EDCB からの引き継ぎ", () => {
  test.beforeEach(async ({ request, stack }) => {
    await request.post(`${stack.edcbControlUrl}/__control/mode`, { data: {} });
  });

  test("受けてすぐ切られたら始めず、アクセス制御を見るよう出る", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.edcbControlUrl}/__control/mode`, {
      data: { deny: true },
    });
    await goto(page, "/settings/integrations");
    await page.getByTestId("edcb-target").fill(stack.edcbTarget);
    await page.getByTestId("edcb-run").click();
    await expect(page.getByTestId("settings-error")).toContainText(
      "アクセス制御 (TCPAccessControlList)",
    );
    // 入れた宛先は欄に残る
    await expect(page.getByTestId("edcb-target")).toHaveValue(stack.edcbTarget);
  });

  test("EpgTimerSrv から下見をして、取り込める", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    await goto(page, "/settings/integrations");
    await page.getByTestId("edcb-target").fill(stack.edcbTarget);
    await expect(page.getByTestId("edcb-apply")).not.toBeChecked();
    await page.getByTestId("edcb-run").click();
    await expect(page.getByTestId("migrate-started")).toBeVisible();

    const progress = page.getByTestId("migrate-progress");
    await expect(progress).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("migrate-rules")).toContainText(
      "ルール 1 件 / 対象外 1 件",
    );
    await expect(page.getByTestId("migrate-history")).toContainText(
      "録画の履歴 1 件",
    );
    const log = page.getByTestId("migrate-log");
    await expect(log).toContainText("録画済み 1 件・ルール 2 件・予約 1 件");
    await expect(log).toContainText("ルール(予定): 引き継ぎテスト");
    await expect(log).toContainText("正規表現のルールは取り込めません");
    await expect(log).toContainText("ルールが作った予約 1 件は");
    await expect(page.getByTestId("edcb-target")).toHaveValue(stack.edcbTarget);

    await page.getByTestId("edcb-apply").check();
    await page.getByTestId("edcb-run").click();
    await expect(log).toContainText("ルール: 引き継ぎテスト");
    await expect(progress).toHaveAttribute("data-state", "done");

    await goto(page, "/rules");
    await expect(
      page.getByTestId("rule-row").filter({ hasText: "引き継ぎテスト" }),
    ).toHaveCount(1);
    await clearRules(page);
  });
});
