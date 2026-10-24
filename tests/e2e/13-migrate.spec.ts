import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { clearRules, expect, goto, syncEpg, test } from "./helpers";

/**
 * EPGStation からの引き継ぎ。
 *
 * 実際の取り込みは EPGStation の MariaDB と数百GBの録画が要るので、ここでは
 * 「PVCをマウントし忘れたときに止まること」と「裏で走って結果が画面に出ること」を見る。
 * ファイルの置き場所とサムネイルは録画の通しテスト(03)と同じ処理を通る。
 *
 * Playwright と アプリは同じコンテナで動くので、マウントの有無はディレクトリを
 * 作る/消すで再現できる。
 */
test.describe("EPGStation からの引き継ぎ", () => {
  test.beforeEach(({ stack }) => {
    rmSync(stack.epgstationDir, { recursive: true, force: true });
  });

  test("引き継ぎ元が見えなければ実行させない", async ({ page }) => {
    await goto(page, "/settings/integrations");

    await expect(page.getByTestId("migrate-unavailable")).toBeVisible();
    // ボタンを出しておいて押したら失敗、では何をすればいいか分からない
    await expect(page.getByTestId("migrate-run")).toHaveCount(0);
  });

  test("引き継ぎ元が見えれば実行でき、失敗すれば理由が出る", async ({
    page,
    stack,
  }) => {
    mkdirSync(stack.epgstationDir, { recursive: true });
    await goto(page, "/settings/integrations");
    await expect(page.getByTestId("migrate-unavailable")).toHaveCount(0);

    // 既定は下見。チェックを入れない限りファイルもDBも触らない
    await expect(page.getByTestId("migrate-apply")).not.toBeChecked();
    await page.getByTestId("migrate-run").click();
    await expect(page.getByTestId("migrate-started")).toBeVisible();

    // EPGStation のDBは無いので失敗する。SSE で結果が降ってくる
    const progress = page.getByTestId("migrate-progress");
    await expect(progress).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("migrate-state")).toHaveText("失敗");
    // 何が起きたのかが画面に出ること。文面は繋がらなかった理由 (拒否/時間切れ)
    // 次第で変わるので、宛先や語句までは決め打たない
    await expect(page.getByTestId("migrate-error")).toContainText(/Error/);
    // 何をしようとしたのかが残る
    await expect(page.getByTestId("migrate-log")).toContainText("失敗");
  });
});

/**
 * EDCB からの引き継ぎ。EDCB の設定フォルダを形式どおりに作り (番組名は作り物)、
 * 下見で件数と記録が出ること、取り込むとルールが入ることを見る。
 * 細かい写し方は単体テスト (`migrate-edcb.test.ts`)
 */
test.describe("EDCB からの引き継ぎ", () => {
  /** TOKYO MX (ONID 32391 = 0x7E87、SID 23608 = 0x5C38)。TSID は denpa では使わない */
  const MX = "7E877FF05C38";

  /** `EpgAutoAdd.txt` の1行。録画フォルダ1つ・部分受信用フォルダ無し */
  function autoAdd(id: number, andKey: string, regExp = 0): string {
    return [
      id,
      andKey,
      "",
      regExp,
      1,
      "",
      "",
      MX,
      1,
      2,
      1,
      0,
      0,
      "",
      0,
      0,
      0,
      0,
      0,
      1,
      "D:\rec*Write_Default.dll*RecName_Macro.dll?$Title$.ts",
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      6,
      "",
    ].join("\t");
  }

  test("設定フォルダから下見をして、取り込める", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    const edcb = `${stack.root}/edcb`;
    const setting = `${edcb}/Setting`;
    rmSync(edcb, { recursive: true, force: true });
    mkdirSync(setting, { recursive: true });
    const bom = "\ufeff";
    // 1つ目は無効の印付き (予約を立てて他のテストを乱さない)。2つ目は正規表現なので飛ぶ
    writeFileSync(
      `${setting}/EpgAutoAdd.txt`,
      `${bom}${autoAdd(1, "^!{999}引き継ぎテスト")}\r\n${autoAdd(2, "テスト.*", 1)}\r\n;;NextID=3\r\n`,
    );
    writeFileSync(
      `${setting}/RecInfo2.txt`,
      `${bom}32391\t32753\t23608\t2026/09/01\t21:00:00\t引き継ぎテスト #1\r\n`,
    );

    await goto(page, "/settings/integrations");
    // EDCB のフォルダの上を指しても、中の Setting を読む
    await page.getByTestId("edcb-dir").fill(edcb);
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
    await expect(log).toContainText("ルール(予定): 引き継ぎテスト");
    await expect(log).toContainText("正規表現のルールは取り込めません");
    await expect(log).toContainText("Reserve.txt が無いので飛ばします");
    // 指したフォルダは欄に残る
    await expect(page.getByTestId("edcb-dir")).toHaveValue(edcb);

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
