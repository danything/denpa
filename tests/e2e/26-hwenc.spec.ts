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
 * H.265 は `26-hwenc-hevc` (録画を2本エンコードして1分ほどかかるので、CI の別の組で流す)
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

    // 2枚挿した → 確かめ直すと、デバイスが2つ。どちらも両方のコーデックを使えるので「順番に使う」
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
    // AV1 は 128、H.264 は 129 の VA-API。2つは同時にエンコードするので、引数を書く順は決まらない
    expect(
      encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf).sort(),
    ).toEqual(["renderD128:av1_vaapi", "renderD129:h264_vaapi"]);

    /*
     * **GPU が途中で駄目になっても録画は失敗にならない。** 129 を抜いてから
     * (確かめ直さずに) H.264 をエンコードさせると、129 の方式が初期化で落ちて、
     * ソフトウェアで再エンコードされる。試す順は 方式ごとに 2回 (頭を捨てる分) → 次。
     * 128 は H.264 を外してあるので、そちらへは行かない
     */
    rmSync(`${stack.hwDir}/renderD129`, { force: true });
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["h264"] });
    programId = await reserveSoon(page, request, "BS", 1);
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

  test("Rockchip MPP は別の行に出て、H.264 と H.265 だけを受け持つ", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    clearGpus(stack.hwDir);
    const mpp = `${stack.hwDir}/mpp_service`;
    writeFileSync(mpp, "1");
    await goto(page, "/settings/recording");
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "デバイスが 1 個見つかり、1 個で GPU エンコードできます",
    );
    await expect(page.getByTestId("hw-device")).toContainText(
      "mpp_service (Rockchip): Rockchip MPP: H.265 / H.264",
    );
    // AV1 をエンコードできるデバイスは無いので、AV1 のエンコーダを選ぶ欄は出ない
    await expect(page.getByTestId("hw-av1")).toHaveCount(0);
    await expect(page.getByTestId("hw-h264")).toHaveValue(mpp);

    // 両方エンコードすると、AV1 はソフトウェア、H.264 は h264_rkmpp (デバイスは引数に出ない)
    await syncEpg(request);
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["av1", "h264"] });
    const programId = await reserveSoon(page, request, "BS", 2);
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    const recordingId = await row.getAttribute("data-recording-id");
    const runs = encodeRuns(stack.encodeArgsFile, recordingId);
    // 同時にエンコードするので、引数を書く順は決まらない
    expect(runs.map(wayOf).sort()).toEqual(["h264_rkmpp", "libsvtav1"]);
    // AVBR でビットレートを渡す (hwenc.hwBitrate)
    const mppRun = runs.find((run) => wayOf(run) === "h264_rkmpp");
    expect(mppRun!.join(" ")).toMatch(
      /-rc avbr -b:v \d+ -maxrate \d+ -minrate \d+ -g 250/,
    );
  });

  test("NVIDIA の GPU は別の行に出て、GPU の番号でエンコードする", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    clearGpus(stack.hwDir);
    // 2枚目だけをコンテナに渡したときの形。番号は並びの位置なので -gpu 0 になる
    const nvidia = `${stack.hwDir}/nvidia1`;
    writeFileSync(nvidia, "1");
    writeFileSync(`${stack.hwDir}/nvidiactl`, "1");
    await goto(page, "/settings/recording");
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "デバイスが 1 個見つかり、1 個で GPU エンコードできます",
    );
    await expect(page.getByTestId("hw-device")).toContainText(
      "nvidia1 (NVIDIA): NVENC: AV1 / H.265 / H.264",
    );
    await expect(page.getByTestId("hw-av1")).toHaveValue(nvidia);
    await expect(page.getByTestId("hw-h264")).toHaveValue(nvidia);

    // H.264 を NVENC で。キーフレームの指定は NVENC の綴り (-forced-idr) で IDR にさせる
    await syncEpg(request);
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["h264"] });
    const programId = await reserveSoon(page, request, "BS", 3);
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    const recordingId = await row.getAttribute("data-recording-id");
    const runs = encodeRuns(stack.encodeArgsFile, recordingId);
    expect(runs.map(wayOf)).toEqual(["h264_nvenc"]);
    expect(runs[0]!.join(" ")).toMatch(
      /h264_nvenc -gpu 0 -preset p4 -rc vbr -b:v \d+ -maxrate \d+ -bufsize \d+ -g 250/,
    );
  });
});
