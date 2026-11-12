import { bootSecondAgent, bootSpare, type SecondAgent, type Spare } from "../stack";
import { expect, goto, test } from "./helpers";

/**
 * **設定の「受信」の「エージェント」** (docs/agent.md「エージェントを足す」、agent-admin.ts)。
 *
 * いつもの偽エージェントを `TUNER_AGENT_URL` に書いた、まだ使っていない denpa (`bootSpare`) に、2 台目の偽エージェントを画面から登録する。
 * 環境変数のエージェントは削除できないこと、登録用の URL の断り、名前の変更、チューナーの表がエージェントごとに分かれること、削除を通す。
 * 別の denpa を使うのは、ワーカーの denpa のエージェントを増やすと同じワーカーのほかのファイルの振り分けが変わるため
 */
test.describe("エージェントの登録", () => {
  test.describe.configure({ mode: "serial" });
  let spare: Spare;
  let second: SecondAgent;

  test.beforeAll(async ({ stack }, info) => {
    spare = await bootSpare(info.workerIndex, stack.root, stack.tunerAgentUrl);
    second = await bootSecondAgent(info.workerIndex, spare.rawDir, "書斎");
  });
  test.afterAll(async () => {
    await second?.shutdown();
    await spare?.shutdown();
  });

  test("環境変数のエージェントは一覧に「環境変数」と出し、削除の代わりに外し方を言う", async ({
    page,
  }) => {
    await goto(page, `${spare.appUrl}/settings/reception#agents`);
    const rows = page.getByTestId("agent-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("agent-facts")).toContainText(
      "環境変数",
    );
    await expect(rows.first().getByTestId("agent-facts")).toContainText(
      /チューナー \d+ 台/,
    );
    await rows.first().getByTestId("agent-more").click();
    await expect(page.getByTestId("agent-env-note")).toHaveText(
      "TUNER_AGENT_URL から消すと外れます",
    );
    await expect(page.getByTestId("agent-delete")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // チューナーの表は 1 台でもエージェントの名前の見出しの下に出る
    await expect(page.getByTestId("agent-tuners-name")).toHaveCount(1);
  });

  test("登録用の URL を貼って 2 台目を登録すると、チューナーの表がエージェントごとに分かれる", async ({
    page,
  }) => {
    await goto(page, `${spare.appUrl}/settings/reception#agents`);
    await page.getByTestId("agent-add").click();
    const dialog = page.getByTestId("agent-dialog");
    await expect(dialog).toBeVisible();

    // 合言葉の無い URL は、何をすればよいかを言って断る (窓は閉じない)
    await dialog
      .getByTestId("agent-url")
      .fill(second.pairUrl.replace(/#.*$/, ""));
    await dialog.getByTestId("agent-submit").click();
    await expect(dialog.getByTestId("agent-error")).toContainText(
      "合言葉 (#pair=…) が入っていません",
    );

    await dialog.getByTestId("agent-url").fill(second.pairUrl);
    await dialog.getByTestId("agent-submit").click();
    await expect(dialog).toBeHidden();

    const rows = page.getByTestId("agent-row");
    await expect(rows).toHaveCount(2);
    // 名前はエージェントの `/denpa/about` の name (AGENT_NAME)
    await expect(rows.nth(1).getByTestId("agent-name")).toHaveText("書斎");
    await expect(rows.nth(1).getByTestId("agent-facts")).not.toContainText(
      "環境変数",
    );
    await expect(page.getByTestId("agent-tuners-name")).toHaveText([
      "127.0.0.1",
      "書斎",
    ]);

    // 同じエージェントは 2 度登録しない
    await page.getByTestId("agent-add").click();
    await dialog.getByTestId("agent-url").fill(second.pairUrl);
    await dialog.getByTestId("agent-submit").click();
    await expect(dialog.getByTestId("agent-error")).toContainText(
      "このエージェントはもう登録してあります (書斎)",
    );
    await dialog.getByRole("button", { name: "閉じる" }).last().click();
  });

  test("名前を変え、削除する", async ({ page }) => {
    await goto(page, `${spare.appUrl}/settings/reception#agents`);
    const row = page.getByTestId("agent-row").nth(1);
    await row.getByTestId("agent-more").click();
    await page.getByTestId("agent-rename").click();
    await row.getByTestId("agent-name-input").fill("寝室");
    await row.getByTestId("agent-name-save").click();
    await expect(row.getByTestId("agent-name")).toHaveText("寝室");
    await expect(page.getByTestId("agent-tuners-name").nth(1)).toHaveText(
      "寝室",
    );

    await row.getByTestId("agent-more").click();
    await page.getByTestId("agent-delete").click();
    await page.getByTestId("agent-delete-confirm").click();
    await expect(page.getByTestId("agent-row")).toHaveCount(1);
    await expect(page.getByTestId("agent-tuners-name")).toHaveCount(1);
  });
});
