import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  encodeSpans,
  expect,
  goto,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  waitRowState,
} from "./helpers";

/**
 * エンコードが失敗したときの見え方と後始末。
 * 失敗の表示が消せないと、直したあとも延々と残って邪魔になる。
 */
test.describe("エンコードの失敗", () => {
  test.afterAll(({ stack }) => {
    if (existsSync(stack.failFile)) rmSync(stack.failFile);
  });

  test("失敗したエンコードは行の状態に出て、理由は詳細で見られる", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    // ここから先のエンコードを失敗させる
    writeFileSync(stack.failFile, "1");

    await reserveSoon(page, request, "BS");

    /*
     * 失敗したものは進み具合を出さない。行に残るのは状態だけ。
     *
     * 出るのは「エンコード失敗」であって「失敗」ではない。落ちたのは再エンコードの
     * ほうなので、録画そのものの状態 (録画済み) には手を付けない
     */
    await waitRowState(
      page,
      "/",
      page.locator('[data-testid="recording-row"]').last(),
      "エンコード失敗",
    );
    await goto(page, "/");
    await expect(page.getByTestId("encode-progress")).toHaveCount(0);
    const failed = page
      .getByTestId("recording-row")
      .filter({
        has: page.getByTestId("recording-state").getByText("エンコード失敗"),
      })
      .first();
    await expect(failed.getByTestId("recording-state")).toHaveText(
      "エンコード失敗",
    );

    /*
     * **観られる。** エンコードできていなくても元のTSは無事で、追っかけ再生の画面 (/chase) が
     * サーバで再エンコードして運ぶ (25-chase)。行には再生の印が出て、押すと追っかけへ。
     * 以前は「エンコードできていない = 観られない」で印を消していたが、元のTSがある限り観られる
     */
    await expect(failed.getByTestId("play-hint")).toBeVisible();

    // 理由は行の「詳細」から。ffmpeg の出力は長いので一覧には貼らない
    // (観られる行は押すと再生に行くので、詳細は別のボタン)
    await failed.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    // 理由は1つだけ。録画そのものは失敗していないので、出るのはジョブ側の理由だけ
    const note = detail.getByTestId("detail-error");
    await expect(note).toHaveCount(1);
    await expect(note).toContainText("エンコードに失敗しました");
    await expect(note).toContainText("Error initializing the encoder");
    // 警告に埋もれず、止まった理由だけが出ていること
    await expect(note).not.toContainText("has not been used for any stream");
    await page.getByTestId("detail-close").click();
    await expect(detail).toHaveCount(0);

    // 削除は2回押させる。1回目は聞き返すだけで、まだ消えない
    await failed.getByTestId("delete-button").click();
    await expect(failed.getByTestId("delete-confirm")).toBeVisible();
    await expect(failed).toHaveCount(1);

    /*
     * **他所を触ったら取り下げる。**
     *
     * 時間で戻すだけだと、間違えて押したことに気付いて別のところを触っても
     * まだ構えたままで、その数秒のうちに同じ場所をもう一度押すと消える
     */
    // 画面から出ない場所を触る (行を押すと再生・詳細に行ってしまう)
    await page.getByTestId("timeline-now").click();
    await expect(failed.getByTestId("delete-confirm")).toHaveCount(0);
    await expect(failed.getByTestId("delete-button")).toBeVisible();

    await failed.getByTestId("delete-button").click();
    await expect(failed.getByTestId("delete-confirm")).toBeVisible();

    const id = await failed.getAttribute("data-recording-id");
    await failed.getByTestId("delete-confirm").click();
    await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);

    rmSync(stack.failFile);
  });
});

/**
 * コーデックをいくつも選んだときは、コーデックごとに ffmpeg を1本ずつ同時に走らせる。
 * **1本が落ちても、ほかは止めずに置く** (観られるものを捨てない)。ジョブは失敗にして理由を残し、
 * 元のTSは消さない (再エンコードすれば全部作り直せる)
 */
test.describe("コーデックの片方だけ失敗する", () => {
  test.afterAll(async ({ request, stack }) => {
    if (existsSync(stack.failEncoderFile)) rmSync(stack.failEncoderFile);
    await setRecording(request);
  });

  test("H.264 が落ちても AV1 は置かれて観られ、理由は H.264 のぶんとして出る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await setRecording(request, { codecs: ["av1", "h264"] });
    // H.264 (libx264) を使うエンコードだけ失敗させる
    writeFileSync(stack.failEncoderFile, "libx264");

    const programId = await reserveSoon(page, request, "BS");
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitRowState(page, "/", row, "エンコード失敗");
    await goto(page, "/");

    // AV1 は置かれている (H.264 が落ちても止めていない)。H.264 は置かれない
    const av1 = (await row.getAttribute("data-library-path")) ?? "";
    expect(av1).toMatch(/\.mkv$/);
    expect(existsSync(av1)).toBe(true);
    expect(await row.getAttribute("data-alt-path")).toBeFalsy();
    await expect(row.getByTestId("play-hint")).toBeVisible();

    // AV1 は最後までエンコードしている (落ちた H.264 に巻き込まれて止められていない)
    const id = (await row.getAttribute("data-recording-id")) ?? "";
    const spans = encodeSpans(stack.encodeSpansFile, id);
    const done = spans.filter((s) => s.output.endsWith(".av1.encoding"));
    expect(done).toHaveLength(1);
    expect(done[0]!.end).not.toBeNull();

    // 理由はどのコーデックが落ちたかを添えて出る
    await row.getByTestId("detail-button").click();
    const note = page.getByTestId("program-detail").getByTestId("detail-error");
    await expect(note).toContainText("H.264:");
    await expect(note).toContainText("libx264");
    await page.getByTestId("detail-close").click();

    // 落ちた H.264 の作業ファイルは残さない
    expect(
      readdirSync(dirname(av1)).filter((name) => name.endsWith(".encoding")),
    ).toEqual([]);
  });
});
