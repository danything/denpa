import { rmSync, writeFileSync } from "node:fs";

import {
  expect,
  goto,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  waitWatchable,
} from "./helpers";
import {
  clearGpus,
  encodeRuns,
  forgetGpusAfterAll,
  GPUS,
  wayOf,
} from "./hwenc";

/**
 * GPU でエンコードする (server/hwenc.ts)。GPU の偽物の作り方は `hwenc.ts`。
 * ここは VA-API の GPU を見つけて割り振るところ。Rockchip MPP と NVIDIA の GPU は `26-hwenc-vendors`
 * (1 本で CI の組の時間を押し上げていたので分けた)。
 * H.265 は `26-hwenc-hevc` (録画を 2 本エンコードするので、CI の別の組で流す)
 */

test.describe("GPU でエンコードする", () => {
  forgetGpusAfterAll();

  test("見つかった GPU は自動で使い、コーデックごとにエンコーダを選べる", async ({
    page,
    stack,
  }) => {
    clearGpus(stack.hwDir);
    await goto(page, "/settings/recording");
    // GPU が無ければ、エンコーダを選ぶ欄も無い
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "GPU が見つかりません",
    );
    await expect(page.getByTestId("hw-device")).toHaveCount(0);
    await expect(page.getByTestId("hw-av1")).toHaveCount(0);

    // 2 枚挿した → 確かめ直すと、デバイスが 2 つ。どちらも両方のコーデックを使えるので「順番に使う」
    for (const gpu of GPUS) writeFileSync(`${stack.hwDir}/${gpu}`, "1");
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "デバイスが 2 個見つかり、2 個で GPU エンコードできます",
    );
    await expect(page.getByTestId("hw-device")).toHaveCount(2);
    await expect(page.getByTestId("hw-av1")).toHaveValue("every");
    await expect(page.getByTestId("hw-h264")).toHaveValue("every");

    // デバイスごとに割り振る: AV1 は 128、H.264 は 129
    // 変えたらその場で保存する (保存のボタンは無い)。最後の保存が終わるのを待ってから読み直す
    const [d128, d129] = GPUS.map((gpu) => `${stack.hwDir}/${gpu}`);
    await page.getByTestId("hw-av1").selectOption(d128 as string);
    await page.getByTestId("hw-h264").selectOption(d129 as string);
    await expect(page.getByTestId("saved-result")).toBeVisible();
    await goto(page, "/settings/recording");
    await expect(page.getByTestId("hw-av1")).toHaveValue(d128 as string);
    await expect(page.getByTestId("hw-h264")).toHaveValue(d129 as string);

    // ライブは録画と別に選ぶ (列の見出し「ライブ」)。録画の割り振りはライブに効かない
    await expect(page.getByTestId("live-hw-av1")).toHaveValue("every");
    await expect(page.getByTestId("live-hw-h264")).toHaveValue("every");
    // H.265 のライブの欄は「ソフトウェア」の代わりに「使わない」(ライブで H.265 を出さない)
    await expect(page.getByTestId("live-hw-hevc")).toHaveValue("every");
    await expect(
      page.getByTestId("live-hw-hevc").locator('option[value="software"]'),
    ).toHaveText("使わない");
    await page.getByTestId("live-hw-av1").selectOption(d129 as string);
    await page.getByTestId("live-hw-h264").selectOption("software");
    await expect(page.getByTestId("saved-result")).toBeVisible();
    await goto(page, "/settings/recording");
    await expect(page.getByTestId("live-hw-av1")).toHaveValue(d129 as string);
    await expect(page.getByTestId("live-hw-h264")).toHaveValue("software");
    await expect(page.getByTestId("hw-av1")).toHaveValue(d128 as string);
    await expect(page.getByTestId("hw-h264")).toHaveValue(d129 as string);
  });

  test("割り振ったデバイスでエンコードし、落ちたらソフトウェアへ倒れる", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    // 上の割り振りのまま (128 = AV1、129 = H.264)
    for (const gpu of GPUS) writeFileSync(`${stack.hwDir}/${gpu}`, "1");
    await request.post("/settings/recording?/probeHw", { form: {} });
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["av1", "h264"] });

    let programId = await reserveSoon(page, request, "BS");
    let row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    let recordingId = await row.getAttribute("data-recording-id");
    // AV1 は 128、H.264 は 129 の VA-API。2 つは同時にエンコードするので、引数を書く順は決まらない
    expect(
      encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf).sort(),
    ).toEqual(["renderD128:av1_vaapi", "renderD129:h264_vaapi"]);

    /*
     * **GPU が途中で駄目になっても録画は失敗にならない。** 129 を抜いてから
     * (確かめ直さずに) H.264 をエンコードさせると、129 の方式が初期化で落ちて、
     * ソフトウェアで再エンコードされる。試す順は 方式ごとに 2 回 (先頭を捨てる分) → 次。
     * 128 は H.264 を外してあるので、そちらへは行かない
     */
    rmSync(`${stack.hwDir}/renderD129`, { force: true });
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["h264"] });
    programId = await reserveSoon(page, request, "BS");
    row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    recordingId = await row.getAttribute("data-recording-id");
    expect(encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf)).toEqual([
      "renderD129:h264_vaapi",
      "renderD129:h264_vaapi",
      "libx264",
    ]);
  });
});
