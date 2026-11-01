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
import { clearGpus, encodeRuns, resetGpus, wayOf } from "./hwenc";

/**
 * GPU で H.265 をエンコードする (server/hwenc.ts)。GPU は偽物 (置き方は `./hwenc.ts`)。
 *
 * 26-hwenc から分けたもの。録画を2本待つので1本で1分を超える。別のファイルにして並べて流す
 */

test.describe("GPU でエンコードする", () => {
  test.afterAll(async ({ stack, request }) => {
    await resetGpus(stack.hwDir, request);
  });

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
    const ways = encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf);
    expect(ways).toHaveLength(3);
    expect(ways[0]).toMatch(/^renderD128:hevc_vaapi$/);
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
