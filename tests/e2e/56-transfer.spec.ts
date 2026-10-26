import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";

import type { Page } from "@playwright/test";

import { bootSpare, type Spare } from "../stack";
import {
  clearRules,
  expect,
  goto,
  makeRule,
  recordOne,
  setRecording,
  test,
} from "./helpers";

/**
 * **denpa を別の機械へ移す** (設定の「連携」。docs/migrate.md「別の機械へ移す」、transfer.ts)。
 *
 * いつもの denpa を「古い機械」、`bootSpare` で立てたまだ使っていない denpa を「新しい機械」にして、
 * 画面から書き出す → 新しい機械に送る → 置き場に無い録画で止まる → 録画のフォルダを写して確かめ直す →
 * 取り込んで再起動 → 録画・ルール・設定が戻る、を通す。新しいバージョンのファイル・壊れたファイル・
 * アクセストークンで断られることも見る。tar の読み方や入れ替えの細かいところは単体テスト (`transfer.test.ts`・`tar.test.ts`)
 */
test.describe("denpa を別の機械へ移す", () => {
  let spare: Spare;
  /** 古い機械で書き出したファイル */
  let archive = "";
  /** 古い機械で録った録画の ID (新しい機械でも同じ ID で戻る) */
  let recordingId = "";

  test.beforeAll(async ({ stack }, info) => {
    spare = await bootSpare(info.workerIndex, stack.root, stack.agentUrl);
  });
  test.afterAll(async () => {
    await spare?.shutdown();
  });

  /** 新しい機械の画面で、ファイルを選んで送る */
  async function send(
    page: Page,
    file: string | { name: string; buffer: Buffer },
  ) {
    await goto(page, `${spare.appUrl}/settings/integrations#transfer`);
    await page
      .getByTestId("transfer-file")
      .setInputFiles(
        typeof file === "string"
          ? file
          : { ...file, mimeType: "application/zstd" },
      );
    await page.getByTestId("transfer-send").click();
  }

  test("アクセストークンでは断られる", async ({ request, stack }) => {
    // テレビのアプリと同じようにペアリングしてアクセストークンを貰う (31-device と同じ手順)
    const code = await (
      await request.post("/api/device/code", { data: { name: "E2E の移す" } })
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

    const headers = {
      authorization: `Bearer ${token}`,
      origin: stack.appUrl,
      "content-type": "application/json",
    };
    for (const [method, path] of [
      ["POST", "export"],
      ["POST", "upload"],
      ["PUT", "upload?offset=0"],
      ["POST", "check"],
      ["POST", "apply"],
      ["POST", "cancel"],
    ] as const) {
      const res = await fetch(
        `${stack.appUrl}/settings/integrations/transfer/${path}`,
        { method, headers, body: "{}" },
      );
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).message).toContain(
        "アクセストークンでは使えません",
      );
    }
  });

  test("ほかのサイトからの送信は断る", async ({ stack }) => {
    const res = await fetch(
      `${spare.appUrl}/settings/integrations/transfer/cancel`,
      {
        method: "POST",
        headers: {
          origin: "http://evil.example",
          "sec-fetch-site": "cross-site",
        },
      },
    );
    expect(res.status).toBe(403);
    expect(stack.appUrl).not.toBe(spare.appUrl);
  });

  test("書き出せる", async ({ page, request, stack }) => {
    ({ id: recordingId } = await recordOne(page, request));
    await makeRule(page, "移すルール");
    await setRecording(request, { cmCut: "cut" });

    await goto(page, "/settings/integrations#transfer");
    const downloading = page.waitForEvent("download");
    await page.getByTestId("transfer-export").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(
      /^denpa-export-\d{8}-\d{4}\.tar\.zst$/,
    );
    archive = `${stack.root}/${download.suggestedFilename()}`;
    await download.saveAs(archive);
    // 書き出したあとも画面はそのまま
    await expect(page.getByTestId("transfer-export")).toBeEnabled();
  });

  test("使っている denpa には取り込めない", async ({ page }) => {
    await goto(page, "/settings/integrations#transfer");
    await expect(page.getByTestId("transfer-not-empty")).toBeVisible();
    await expect(page.getByTestId("transfer-file")).toHaveCount(0);
  });

  test("壊れたファイルは断る", async ({ page }) => {
    await send(page, {
      name: "broken.tar.zst",
      buffer: Buffer.from("これは書き出したファイルではありません"),
    });
    await expect(page.getByTestId("transfer-error")).toContainText(
      "denpa の書き出したファイルとして読めません",
    );
    await expect(page.getByTestId("transfer-result")).toHaveCount(0);
  });

  test("新しいバージョンで書き出したものは断る", async ({ page, stack }) => {
    const newer = `${stack.root}/newer.tar.zst`;
    const made = spawnSync(
      "bun",
      ["tests/fake/transfer-archive.ts", archive, newer],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    await send(page, newer);
    await expect(page.getByTestId("transfer-error")).toContainText(
      "denpa v99.0.0 以上に上げてから取り込んでください",
    );
  });

  test("置き場に無い録画で止まり、写してから取り込むと再起動のあとに戻る", async ({
    page,
    request,
    stack,
  }) => {
    await send(page, archive);
    // 同じワーカーの前のファイルが残したものも入るので、数そのものは見ない
    await expect(page.getByTestId("transfer-counts")).toContainText(
      /ルール [1-9]\d* 件 \/ 予約 \d+ 件 \/ 録画 [1-9]\d* 件/,
    );
    await expect(page.getByTestId("transfer-source")).toContainText(
      "denpa v1.0.0",
    );
    // 録画のフォルダをまだ写していない
    await expect(page.getByTestId("transfer-blocked")).toBeVisible();
    await expect(page.getByTestId("transfer-missing")).toBeVisible();
    await expect(page.getByTestId("transfer-apply")).toHaveCount(0);

    // 写して確かめ直す (送り直さない)
    cpSync(stack.encodedDir, spare.encodedDir, { recursive: true });
    cpSync(stack.rawDir, spare.rawDir, { recursive: true });
    await page.getByTestId("transfer-recheck").click();
    await expect(page.getByTestId("transfer-blocked")).toHaveCount(0);
    await expect(page.getByTestId("transfer-files")).toContainText(
      /置き場にある録画 [1-9]\d* 件/,
    );

    await page.getByTestId("transfer-apply").click();
    await expect(page.getByTestId("transfer-restarting")).toBeVisible();
    // e2e には起こし直す人がいないので、降りたら起こす
    await spare.restart();
    await expect(page.getByTestId("transfer-imported")).toBeVisible({
      timeout: 60_000,
    });

    await goto(page, `${spare.appUrl}/`);
    await expect(
      page
        .locator(
          `[data-testid="recording-row"][data-recording-id="${recordingId}"]`,
        )
        .getByTestId("recording-state"),
    ).toHaveText("視聴可能");
    await goto(page, `${spare.appUrl}/rules`);
    await expect(page.getByTestId("rule-row")).toContainText(["移すルール"]);
    await goto(page, `${spare.appUrl}/settings/recording`);
    await expect(page.getByTestId("global-cmcut")).toHaveValue("cut");

    // 古い機械を後のファイルのために戻す
    await setRecording(request);
    await clearRules(page);
  });
});
