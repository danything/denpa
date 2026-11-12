import { rmSync, writeFileSync } from "node:fs";

import {
  expect,
  goto,
  openSettings,
  recordOne,
  setRecording,
  test,
  wakeControls,
} from "./helpers";
import { compatOn, expectDrawn, where } from "./watch-compat";
import { streamRequests } from "./watch-stream";

/**
 * **互換モードで録画を観る** — 観る画面も `<video>` を使わず canvas に描く (`src/lib/canvas-player.ts`)。
 *
 * テスラの車載ブラウザは停車中でも `<video>` を止める。互換モードの観る画面は `/stream` を fetch で
 * 読んで、ライブ・追っかけと同じエンジン (`raw/engine.ts`) へ流す。ここは**描くところまで**見る:
 *
 * - 本物のストリーム (偽 ffmpeg が作り置きの fMP4 を出す `fmp4-out.ts` と、偽の放送の MPEG-2 をそのまま) を描く。
 *   元の TS は `X-Denpa-Origin` で物差しに直す
 * - 飛ぶ・CM 飛ばし・字幕・止めて再開と、回線が細いときに段を下げるところは、`40-watch-compat-long` で長い録画のふりをして見る
 *   (`playback` を差し替え、`stream` は作り置きの fMP4 をリクエストされた位置から並べて返す。`fmp4-clip.ts`)。
 *   1 本で CI の組の時間を押し上げていたので分けた
 *
 * 映像は AV1 で見る (Playwright の Chromium の VideoDecoder は H.264 をデコードできないことがある。38-live-compat と同じ)
 */

test.describe("互換モードの観る画面", () => {
  test.afterEach(({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });
  test.afterAll(async ({ request }) => {
    await setRecording(request, {});
  });

  test("録画を canvas に描き、MPEG-2 は元の TS の時刻を物差しに直す", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    // エンコードしない録画 (元の TS だけ)。H.264 / AV1 は変換、MPEG-2 はそのまま流せる
    await setRecording(request, { codecs: [] });
    const { id } = await recordOne(page, request);
    writeFileSync(stack.liveFmp4File, "");
    await compatOn(page);
    const asked = streamRequests(page);

    await goto(page, `/watch/${id}`);
    // 変換させたもの (fMP4) を描く。`<video>` には流さない
    await expectDrawn(page, "fmp4");
    expect(asked[0]?.searchParams.get("codec")).toMatch(/^(h264|av1)$/);
    expect(asked[0]?.searchParams.get("from")).toBe("0.000");

    // 速さは等速だけ (切り替えを出さない)
    await wakeControls(page, "watch-stage");
    await expect(page.getByTestId("watch-speed")).toHaveCount(0);

    // MPEG-2 を選ぶと、元の TS をそのまま描く
    await openSettings(page, "watch");
    await page.getByTestId("watch-codec").click();
    // H.264 と H.265 はメニューに並ばない (`#lib/live-choice.ts` の `HIDDEN_CODECS`)
    await expect(
      page.locator('[data-testid="watch-codec-option"][data-codec="h264"]'),
    ).toHaveCount(0);
    await page
      .locator('[data-testid="watch-codec-option"][data-codec="mpeg2"]')
      .click();
    await expectDrawn(page, "ts-mpeg2");
    expect(asked.at(-1)?.searchParams.get("codec")).toBe("mpeg2");
    /*
     * **物差しに直せている。** 元の TS の PTS のままなら何時間にもなる。偽の番組は数秒なので、
     * 位置は先頭からの数秒に収まる
     */
    await expect
      .poll(() => where(page), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await where(page)).toBeLessThan(30);
    // 選んだものは覚える
    expect(await page.evaluate(() => localStorage.getItem("watch-codec"))).toBe(
      "mpeg2",
    );
  });

  /*
   * **デコーダの読み込みが遅くても描ける** (遅い回線)。偽の録画は数秒しかなく、読み込みの間に尻まで
   * 読み切る。「尻まで読んだのに音が来ない」を 2 秒で終わりと見なしていた頃は、デコーダが 2 秒より
   * 遅れると 1 コマも出さずに「観終わった」になっていた (`RawEngine.finish`)
   */
  test("デコーダの読み込みが遅くても、短い録画を描く", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await setRecording(request, { codecs: [] });
    const { id } = await recordOne(page, request);
    writeFileSync(stack.liveFmp4File, "");
    await compatOn(page);
    await page.route("**/api/live/mpeg2/decoder.wasm", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });

    await goto(page, `/watch/${id}`);
    await expectDrawn(page, "fmp4");
  });
});
