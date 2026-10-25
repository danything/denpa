import { readFileSync } from "node:fs";

import { expect, goto, syncEpg, test } from "./helpers";

/**
 * 設定の「その他」の「バージョンと環境」と「ログ」(前の「診断」)。サーバとエージェントのログを読み、伏せた報告から GitHub の Issue を開く。
 *
 * 偽のエージェントのログ (`tests/fake/agent.ts` の `/denpa/logs`) には、カードの番号・IP アドレス・
 * ホスト名と、伏せない番組名 (でんぱニュース) を混ぜてある
 */
test.describe("設定のバージョンと環境・ログ", () => {
  test.afterEach(async ({ request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/logs?mode=normal`);
    await request.post(`${stack.agentUrl}/__control/about?mode=normal`);
  });

  test("サーバとエージェントのログを並べ、絞り込める", async ({
    page,
    request,
  }) => {
    // 番組表を集めるとサーバがログを出す
    await syncEpg(request);
    await goto(page, "/settings/general");
    await expect(page).toHaveTitle("その他 - 設定 - denpa");

    await expect(page.getByTestId("diag-version")).not.toBeEmpty();
    await expect(page.getByTestId("diag-tuners")).toContainText("(GR");
    await expect(page.getByTestId("diag-card")).toContainText(
      "Fake Card Reader (usb 1-1) (使用中)",
    );
    // エージェントのバージョンと OS (`/denpa/about`)。denpa と同じバージョンなら何も言わない
    await expect(page.getByTestId("diag-agent-version")).toHaveText("v1.0.0");
    await expect(page.getByTestId("diag-version-mismatch")).toHaveCount(0);
    await expect(page.getByTestId("diag-agent-system")).toHaveText(
      "Linux 6.12.0-fake #1 SMP (x64)",
    );
    // CCID ドライバは macOS のエージェントだけ
    await expect(page.getByTestId("diag-ccid-driver")).toHaveCount(0);

    const lines = page.getByTestId("log-line");
    await expect(
      lines.and(page.locator('[data-source="server"]')).first(),
    ).toBeVisible();
    // 画面ではそのまま出す (伏せるのは Issue に貼るときだけ)
    const agentLine = lines.filter({ hasText: "でんぱニュース" });
    await expect(agentLine).toHaveAttribute("data-source", "agent");
    await expect(lines.filter({ hasText: "0123456789012345" })).toHaveCount(1);

    // 警告とエラーだけ (エージェントの行は字から見分ける)
    await page.getByTestId("logs-problems").check();
    await expect(agentLine).toHaveAttribute("data-level", "error");
    await expect(lines.and(page.locator('[data-level="info"]'))).toHaveCount(0);
    await page.getByTestId("logs-problems").uncheck();

    await page.getByTestId("logs-search").fill("でんぱニュース");
    await expect(lines).toHaveCount(1);
    await page.getByTestId("logs-search").fill("");

    // エージェントだけ外す
    await page.getByTestId("logs-agent").uncheck();
    await expect(lines.and(page.locator('[data-source="agent"]'))).toHaveCount(
      0,
    );
  });

  test("Issue にする前に伏せた報告を見せ、入力済みのフォームを開く", async ({
    page,
  }) => {
    await goto(page, "/settings/general");
    await expect(
      page.getByTestId("log-line").filter({ hasText: "でんぱニュース" }),
    ).toBeVisible();
    await page.getByTestId("issue-start").click();
    const dialog = page.getByTestId("issue-dialog");
    await expect(dialog).toBeVisible();

    const logs = dialog.getByTestId("issue-field-logs");
    // カードの番号・IP・ホスト名は伏せ、番組名は残す
    await expect(logs).toHaveValue(/\[カード番号\]/);
    await expect(logs).toHaveValue(/\[IP\]/);
    await expect(logs).toHaveValue(/\[ホスト名\]:40773/);
    await expect(logs).toHaveValue(/でんぱニュース/);
    await expect(logs).not.toHaveValue(/0123456789012345/);
    await expect(logs).not.toHaveValue(/192\.168\.10\.20/);
    await expect(logs).not.toHaveValue(/card-host/);
    await expect(logs).toHaveValue(/--- サーバのログ/);
    await expect(logs).toHaveValue(/--- エージェントのログ/);
    const environment = dialog.getByTestId("issue-field-environment");
    await expect(environment).toHaveValue(/チューナー: /);
    await expect(environment).toHaveValue(/ブラウザ: /);
    await expect(environment).toHaveValue(
      /エージェント: v1\.0\.0・Linux 6\.12\.0-fake #1 SMP \(x64\)/,
    );

    // 欄を直したものがそのまま URL に入る
    await dialog.getByTestId("issue-field-title").fill("録画が止まる");
    const href = await dialog.getByTestId("issue-open").getAttribute("href");
    const url = new URL(href!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/danything/denpa/issues/new",
    );
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("title")).toBe("録画が止まる");
    expect(url.searchParams.get("version")).toBe(
      await dialog.getByTestId("issue-field-version").inputValue(),
    );
    expect(url.searchParams.get("environment")).toBe(
      await environment.inputValue(),
    );
    expect(url.searchParams.get("logs")).toBe(await logs.inputValue());
    await expect(dialog.getByTestId("issue-open")).toHaveAttribute(
      "target",
      "_blank",
    );

    // ダウンロードは全部入りで、同じく伏せてある
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByTestId("issue-download").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^denpa-report-.+\.txt$/);
    const text = readFileSync((await download.path())!, "utf8");
    expect(text.split("\n")[0]).toBe("録画が止まる");
    expect(text).toContain("[カード番号]");
    expect(text).toContain("でんぱニュース");
    expect(text).not.toContain("0123456789012345");

    await dialog.getByTestId("issue-close").click();
    await expect(dialog).toBeHidden();
  });

  test("ログが長くても URL は 8000 字に収め、警告とエラーを先に入れる", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.agentUrl}/__control/logs?mode=many`);
    await goto(page, "/settings/general");
    await page.getByTestId("issue-start").click();
    const dialog = page.getByTestId("issue-dialog");
    await expect(dialog.getByTestId("issue-length")).toContainText(
      "行を省きました",
    );
    const href = (await dialog.getByTestId("issue-open").getAttribute("href"))!;
    expect(href.length).toBeLessThanOrEqual(8000);
    const logs = new URL(href).searchParams.get("logs")!;
    expect(logs).toMatch(/\(長いので \d+ 行を省きました/);
    // 選べない長さでも、エラーの行 (50 行ごと) はふつうの行より先に入る
    expect(logs).toContain("偽チューナー1950: 選局できません");

    // 書き足して上限を超えたら、頭から削って収める
    await dialog
      .getByTestId("issue-field-logs")
      .fill(
        `${await dialog.getByTestId("issue-field-logs").inputValue()}\n${"う".repeat(2000)}`,
      );
    const longer = (await dialog
      .getByTestId("issue-open")
      .getAttribute("href"))!;
    expect(longer.length).toBeLessThanOrEqual(8000);
    await expect(dialog.getByTestId("issue-length")).toContainText(
      "ログの頭の",
    );
  });

  test("macOS のエージェントなら CCID ドライバを出し、バージョンが違えば知らせる", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.agentUrl}/__control/about?mode=mac`);
    await goto(page, "/settings/general");
    await expect(page.getByTestId("diag-agent-version")).toContainText(
      "v0.9.0",
    );
    await expect(page.getByTestId("diag-version-mismatch")).toContainText(
      "denpa (v1.0.0) とバージョンが違います",
    );
    await expect(page.getByTestId("diag-agent-system")).toContainText(
      "Darwin 25.0.0",
    );
    await expect(page.getByTestId("diag-ccid-driver")).toHaveText(
      "macOS の標準のもの",
    );

    await page.getByTestId("issue-start").click();
    const environment = page
      .getByTestId("issue-dialog")
      .getByTestId("issue-field-environment");
    await expect(environment).toHaveValue(
      /エージェント: v0\.9\.0 \(denpa とバージョンが違います\)・Darwin 25\.0\.0 .*\(arm64\)/,
    );
    await expect(environment).toHaveValue(/CCID ドライバ: macOS の標準のもの/);
  });

  test("ログを返さないエージェントでも、一言出して画面は止めない", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.agentUrl}/__control/logs?mode=off`);
    await request.post(`${stack.agentUrl}/__control/about?mode=off`);
    await goto(page, "/settings/general");
    await expect(page.getByTestId("agent-logs-error")).toContainText(
      "前のバージョン",
    );
    // バージョンと OS を返さないエージェントでも、理由を1行出す
    await expect(page.getByTestId("diag-agent-version")).toContainText(
      "前のバージョン",
    );
    await expect(page.getByTestId("diag-agent-system")).toHaveCount(0);
    await expect(
      page.getByTestId("log-line").and(page.locator('[data-source="agent"]')),
    ).toHaveCount(0);
    await page.getByTestId("issue-start").click();
    await expect(
      page.getByTestId("issue-dialog").getByTestId("issue-field-logs"),
    ).toHaveValue(
      /--- エージェントのログ \(0 行\) ---\n\(このエージェントはログを返しません/,
    );
  });
});
