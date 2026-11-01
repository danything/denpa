import { existsSync, rmSync, writeFileSync } from "node:fs";

import {
  encodeSpans,
  expect,
  goto,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
} from "./helpers";

/**
 * エンコードの中止。
 *
 * **押したその場で行が変わること**を見る。中止をリクエストするだけで返していた頃は、
 * 押した直後の読み直しが ffmpeg の死ぬ前に届くので、**同じ「エンコード中 60.9%」が
 * そのまま出た** (実機、2026-09-10)。行が変わるのは畳み終わりの通知 (SSE) が
 * 来たときで、その繋ぎが切れている端末では**リロードするまで永久に変わらない**。
 *
 * 「走っている最中」を作るために偽 ffmpeg を長引かせる (`stack.slowFile`)。
 */
test.describe("エンコードの中止", () => {
  test.afterAll(({ stack }) => {
    if (existsSync(stack.slowFile)) rmSync(stack.slowFile);
  });

  test("中止を押すと、その場で録画済みに戻る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    // ここから先のエンコードを長引かせる (中止を押す間を作る)
    writeFileSync(stack.slowFile, "1");
    const programId = await reserveSoon(page, request, "BS");
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );

    // エンコードし始めるまで待つ (行に「エンコード中」と進み具合が出る)
    await expect(async () => {
      await goto(page, "/");
      await expect(row.getByTestId("recording-state")).toHaveText(
        "エンコード中",
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 120_000, intervals: [500] });
    await expect(row.getByTestId("encode-cancel")).toBeVisible();

    /*
     * **画面ではなくサーバの答えで見る。** 押した結果が返ってきた時点で
     * 畳み終わっていること自体を確かめたいので、通知 (SSE) の届かない
     * 経路で押して、返ってきた直後の画面を読み直す
     */
    const jobId = await row.locator('input[name="id"]').inputValue();
    const res = await request.post("/?/cancelEncode", { form: { id: jobId } });
    expect(res.ok()).toBe(true);

    /*
     * **読み直しは1回だけ、待たない。** ここで待ってしまうと、直っていなくても
     * 畳み終わりの通知が追いついて通ってしまう
     */
    await goto(page, "/");
    await expect(row.getByTestId("recording-state")).toHaveText("録画済み", {
      timeout: 1_000,
    });
    // 中止のボタンは消え、再エンコードできる状態に戻っている
    await expect(row.getByTestId("encode-cancel")).toHaveCount(0);
  });

  /*
   * コーデックをいくつも選ぶと、コーデックごとの ffmpeg が同時に走る。**中止はその全部を止める** —
   * 1本だけ止めて返すと、残りが走り続けて作業ファイルを書き続ける
   */
  test("コーデックを同時にエンコードしていても、中止で全部止まって片付く", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await setRecording(request, { codecs: ["av1", "h264"] });
    writeFileSync(stack.slowFile, "1");
    try {
      const programId = await reserveSoon(page, request, "BS");
      const row = page.locator(
        `[data-testid="recording-row"][data-program-id="${programId}"]`,
      );
      await expect(async () => {
        await goto(page, "/");
        await expect(row.getByTestId("recording-state")).toHaveText(
          "エンコード中",
          { timeout: 1_000 },
        );
      }).toPass({ timeout: 120_000, intervals: [500] });
      const id = (await row.getAttribute("data-recording-id")) ?? "";

      // 2本とも走り出すまで待つ (同時に走っている)
      await expect
        .poll(
          () =>
            encodeSpans(stack.encodeSpansFile, id).filter((s) => s.end === null)
              .length,
          { timeout: 30_000 },
        )
        .toBe(2);
      const working = encodeSpans(stack.encodeSpansFile, id).map(
        (s) => s.output,
      );

      const jobId = await row.locator('input[name="id"]').inputValue();
      const res = await request.post("/?/cancelEncode", {
        form: { id: jobId },
      });
      expect(res.ok()).toBe(true);
      await goto(page, "/");
      await expect(row.getByTestId("recording-state")).toHaveText("録画済み", {
        timeout: 1_000,
      });

      // どちらも最後まで走らずに止まり (終わりが無い)、作業ファイルも残っていない
      const spans = encodeSpans(stack.encodeSpansFile, id);
      expect(spans).toHaveLength(2);
      expect(spans.every((s) => s.end === null)).toBe(true);
      for (const file of working) expect(existsSync(file)).toBe(false);
      expect(await row.getAttribute("data-library-path")).toBeFalsy();
    } finally {
      rmSync(stack.slowFile);
      await setRecording(request);
    }
  });
});
