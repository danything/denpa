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
 * GPU で H.265 をエンコードする (server/hwenc.ts)。GPU の偽物の作り方は `hwenc.ts`。
 * ほかの GPU のことは `26-hwenc` (1本で CI の組の時間を押し上げていたので分けた)
 */

test.describe("GPU で H.265 をエンコードする", () => {
  forgetGpusAfterAll();

  test("H.265 は GPU があるときだけ選べ、1本目に GPU でエンコードして [H265] の名前で置く", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(300_000);
    clearGpus(stack.hwDir);
    await goto(page, "/settings/recording");
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "GPU が見つかりません",
    );
    // GPU が無ければ H.265 の行ごと出さない (ソフトウェアではエンコードしない)
    await expect(page.getByTestId("codec-hevc")).toHaveCount(0);

    writeFileSync(`${stack.hwDir}/renderD128`, "1");
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-device")).toContainText(
      "VA-API: AV1 / H.265 / H.264",
    );
    await expect(page.getByTestId("codec-hevc")).toBeVisible();
    // エンコーダに「ソフトウェア」を置かない
    await expect(
      page.getByTestId("hw-hevc").locator('option[value="software"]'),
    ).toHaveCount(0);

    // 3つ選ぶと、H.265 を1本目に GPU で。主は AV1、H.265 と H.264 はもう一方
    await syncEpg(request);
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["av1", "hevc", "h264"] });
    let programId = await reserveSoon(page, request, "BS", 4);
    let row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    let recordingId = await row.getAttribute("data-recording-id");
    const runs = encodeRuns(stack.encodeArgsFile, recordingId);
    expect(runs).toHaveLength(3);
    /*
     * 1本目は CM 検出の材料を一緒に取るもの (書き出しを `denpa-scan-…` に置く)。**引数を書いた順では見ない** —
     * 3本は同時に立ち上がるので、どれが先に書くかは決まらない (CI で AV1 が先に来て落ちていた)
     */
    const lead = runs.filter((run) =>
      run.some((a) => a.includes("denpa-scan-")),
    );
    expect(lead.map(wayOf)).toEqual(["renderD128:hevc_vaapi"]);
    const main = (await row.getAttribute("data-library-path")) ?? "";
    expect(main).toMatch(/\.mkv$/);
    expect(main).not.toMatch(/\[H26[45]\]/);
    expect(await row.getAttribute("data-hevc-path")).toMatch(/ \[H265\]\.mkv$/);
    expect(await row.getAttribute("data-alt-path")).toMatch(/ \[H264\]\.mkv$/);

    // GPU が無くなったら H.265 は飛ばし、ほかのコーデックだけエンコードする
    clearGpus(stack.hwDir);
    await request.post("/settings/recording?/probeHw", { form: {} });
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["hevc", "h264"] });
    programId = await reserveSoon(page, request, "BS", 5);
    row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    recordingId = await row.getAttribute("data-recording-id");
    expect(encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf)).toEqual([
      "libx264",
    ]);
    expect(await row.getAttribute("data-library-path")).toMatch(
      / \[H264\]\.mkv$/,
    );
    expect(await row.getAttribute("data-hevc-path")).toBeNull();
  });
});
