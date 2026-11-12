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
import { clearGpus, encodeRuns, forgetGpusAfterAll, wayOf } from "./hwenc";

/**
 * Rockchip MPP と NVIDIA の GPU でエンコードする (server/hwenc.ts)。GPU の偽物の作り方は `hwenc.ts`。
 * VA-API の GPU は `26-hwenc`、H.265 は `26-hwenc-hevc`
 */

test.describe("GPU でエンコードする", () => {
  forgetGpusAfterAll();

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
    const programId = await reserveSoon(page, request, "BS");
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
    // 2 枚目だけをコンテナに渡したときの形。番号は並びの位置なので -gpu 0 になる
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

    // H.264 を NVENC で
    await syncEpg(request);
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["h264"] });
    const programId = await reserveSoon(page, request, "BS");
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
