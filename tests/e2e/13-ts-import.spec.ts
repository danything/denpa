import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  eitSection,
  packetize,
  patSection,
  programMap,
  sdtSection,
  stream,
  tdtPacket,
} from "@danything/arib/synth";

import { expect, expectTokenRefused, goto, pairToken, test } from "./helpers";

/**
 * 録画ファイルの取り込み (設定の「連携」)。`IMPORT_DIRS` (`tests/stack.ts`) に偽の TS を置き、下見で番組名が読めることと、
 * 指せないフォルダではその場で理由が出ることを見る。**取り込み (DB に書く) は単体テスト** (`ts-import.test.ts`)。
 * ここで録画を足すと、同じワーカーのほかのスペックの一覧が変わる
 */
test.describe("録画ファイルの取り込み", () => {
  test("アクセストークンでは始めることも中断することもできない", async ({
    request,
    stack,
  }) => {
    const token = await pairToken(request, "E2E の取り込み");
    await expectTokenRefused(request, token, stack.appUrl, "tsImport", {
      folder: stack.importDir,
      apply: "on",
    });
    await expectTokenRefused(request, token, stack.appUrl, "tsImportCancel");
  });

  test("IMPORT_DIRS の外のフォルダは始めず、理由が出る", async ({
    page,
    stack,
  }) => {
    await goto(page, "/settings/integrations#ts-import");
    await page.getByTestId("ts-import-folder").fill(stack.rawDir);
    await page.getByTestId("ts-import-run").click();
    await expect(page.getByTestId("settings-error")).toContainText(
      "IMPORT_DIRS の外のフォルダは取り込めません",
    );
  });

  test("下見で番組名が読める", async ({ page, stack }) => {
    const at = Date.now() - 2 * 60 * 60_000;
    const dir = join(stack.importDir, "e2e");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "録画.m2ts");
    writeFileSync(
      path,
      stream(
        packetize(0, patSection([[1024, 0x1f0]], 0x7fe0)),
        packetize(0x1f0, programMap(1024, 0x100, [[0x02, 0x100]])),
        packetize(
          0x11,
          sdtSection(0x7fe0, 0x7fe0, [[1024, 1, "でんぱテレビ"]]),
        ),
        packetize(
          0x12,
          eitSection({
            tableId: 0x4e,
            serviceId: 1024,
            transportStreamId: 0x7fe0,
            originalNetworkId: 0x7fe0,
            events: [
              {
                eventId: 7,
                startAt: at,
                duration: 30 * 60_000,
                name: "取り込みテスト",
              },
            ],
          }),
        ),
        tdtPacket(at + 60_000),
      ),
    );
    const old = new Date(at);
    utimesSync(path, old, old);

    await goto(page, "/settings/integrations#ts-import");
    await page.getByTestId("ts-import-folder").fill(dir);
    await page.getByTestId("ts-import-run").click();
    await expect(page.getByTestId("ts-import-progress")).toHaveAttribute(
      "data-state",
      "done",
    );
    await expect(page.getByTestId("ts-import-counts")).toContainText(
      "新規 1 件",
    );
    await page.getByTestId("ts-import-progress").getByText("ログ").click();
    await expect(page.getByTestId("ts-import-log")).toContainText(
      "取り込む(予定): 録画.m2ts → 取り込みテスト",
    );
  });
});
