import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  expect,
  goto,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  waitWatchable,
} from "./helpers";

/** 残っている TS のうち、スクランブルが掛かったままのもの */
function scrambledFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => {
      const buffer = readFileSync(join(dir, name));
      for (let i = 0; i + 188 <= buffer.length; i += 188) {
        if (buffer[i] !== 0x47) return false;
        if ((buffer[i + 3]! & 0xc0) !== 0) return true;
      }
      return false;
    });
}

/**
 * カードが読めていない状態で録れてしまった TS の扱い。
 *
 * 電波は二度と戻ってこないので、スクランブルされたままでも録画は止めない。
 * 代わりにエンコードの前に見て、掛かったままならエージェントにリクエストして復号する
 * (カードを読めるのはあちらのコンテナだけ)。
 */
test.describe("スクランブルされたまま録れたとき", () => {
  test.afterEach(async ({ request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/scrambled?on=0`);
  });

  test("録画は止めず、エンコードの前に自動で復号する", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    // カードが読めていない状態にする
    await request.post(`${stack.agentUrl}/__control/scrambled?on=1`);

    const programId = await reserveSoon(page, request, "BS");
    const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

    // 録画自体は失敗しない。解除まで済んで視聴可能になる
    await waitWatchable(page, page.locator(row));

    // 失敗の理由は詳細にしか出ない。何も起きていないので 1 つも無いこと
    await page.locator(row).getByTestId("detail-button").click();
    await expect(page.getByTestId("program-detail")).toBeVisible();
    await expect(page.getByTestId("detail-error")).toHaveCount(0);
    await page.getByTestId("detail-close").click();
  });

  test("元の TS を残す設定なら、残るのは復号済みの TS だけ", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await request.post(`${stack.agentUrl}/__control/scrambled?on=1`);

    await setRecording(request, { keepOriginal: true });
    try {
      const programId = await reserveSoon(page, request, "BS");
      const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

      await waitWatchable(page, page.locator(row));

      // 掛かったままの TS を取っておいても、あとから復号できる保証は無いので置き換える
      expect(scrambledFiles(stack.rawDir)).toEqual([]);

      /*
       * 元の TS を残しているなら、その大きさも行に出す。
       * エンコード済みのぶんしか出していなかった頃は、消していいのか・
       * どれだけ空くのかが画面から分からなかった
       */
      await expect(page.locator(row).getByTestId("row-body")).toContainText(
        "元の TS",
      );

      /*
       * **名指しした側が本当に来ること** (`file?source=`)。アプリは録画の一覧の `files` から
       * 選んで名指しする。同じものが返ってきたら、選んだ意味が無い。
       * エンコードしたほうは Matroska、元は MPEG-TS で返る
       */
      const id = await page.locator(row).getAttribute("data-recording-id");
      const typeOf = async (source: string) => {
        const got = await request.get(
          `/api/recordings/${id}/file?source=${source}`,
          {
            headers: { Range: "bytes=0-99" },
          },
        );
        expect(got.status()).toBe(206);
        return got.headers()["content-type"];
      };
      expect(await typeOf("ts")).toBe("video/mp2t");
      expect(await typeOf("encoded")).toBe("video/x-matroska");
    } finally {
      await setRecording(request);
    }
  });
});

/**
 * **ライブで局がスクランブルされたまま届いたら、理由を出して止める** (`server/live.ts` の `SCRAMBLE_PACKETS`)。
 *
 * 本物のエージェントは、カードが鍵を返さなかった (未契約の) 局をスクランブルされたまま流す。それを ffmpeg に渡すと
 * `Failed to set value '0:p:201:s:0' for option 'map'` で降りて、画面は何も出ないまま止まっていた
 * (BS10プレミアムをケーブルで受けたときに実機で出た)
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
