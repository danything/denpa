import { readFileSync } from "node:fs";

import { clipFrom, readClip } from "../fake/fmp4-clip";
import {
  expect,
  FAKE_CAPTION,
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
 * **互換モードで長い録画を観る** (`src/lib/canvas-player.ts`)。飛ぶ・CM 飛ばし・字幕・止めて再開と、回線が細いときに
 * 段を下げるところを、長い録画のふりをして見る (`playback` を差し替え、`stream` は作り置きの fMP4 を
 * リクエストされた位置から並べて返す。`fmp4-clip.ts`)。
 * 本物のストリームを描くところは `40-watch-compat`
 *
 * 映像は AV1 で見る (Playwright の Chromium の VideoDecoder は H.264 をデコードできないことがある。38-live-compat と同じ)
 */

test.describe("互換モードの観る画面", () => {
  test.afterAll(async ({ request }) => {
    await setRecording(request, {});
  });

  test("飛ぶ・CM 飛ばし・字幕・止めて再開が、canvas でも <video> と同じに効く", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    /*
     * **エンコードしない録画にする** (流すものは下で差し替えるので、中身は使わない)。エンコードすると CM 検出が
     * 走り、偽の録画ではロゴの判定に失敗したと覚え書きに残るので、観はじめの CM 飛ばしが切れる
     * (`skipCmAtStart`)。設定はワーカーのアプリに残るので、前のテストに任せず自分で決める
     */
    await setRecording(request, { codecs: [] });
    const { id } = await recordOne(page, request);
    const clip = readClip(
      new Uint8Array(
        readFileSync(new URL("../fake/live-av1.mp4", import.meta.url)),
      ),
    );
    // 30 分の録画のふり。AV1 でエンコードしてある (互換モードは同じ形の詰め替えを選ぶ)
    await page.route(`**/api/recordings/${id}/playback`, (route) =>
      route.fulfill({
        json: {
          duration: 1800,
          axis: "encoded",
          audios: [{ id: "0", label: "" }],
          offers: [
            {
              codec: "av1",
              way: "file",
              source: "encoded",
              codecs: "av01.0.08M.08,opus",
            },
            { codec: "h264", way: "stream", codecs: "avc1.640028,mp4a.40.2" },
            { codec: "av1", way: "stream", codecs: "av01.0.08M.08,opus" },
          ],
        },
      }),
    );
    // リクエストされた位置から 60 秒ぶん (時刻はページの物差しのまま)
    await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
      const from = Number(
        new URL(route.request().url()).searchParams.get("from") ?? 0,
      );
      return route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: Buffer.from(clipFrom(clip, from, 60)),
      });
    });
    // 604〜640 秒が CM
    await page.route(`**/api/recordings/${id}/chapters`, (route) =>
      route.fulfill({
        json: {
          chapters: [
            { start: 0, end: 604, title: "本編" },
            { start: 604, end: 640, title: "CM" },
            { start: 640, end: 1800, title: "本編" },
          ],
        },
      }),
    );
    // 字幕は 645 秒から
    await page.route(`**/api/recordings/${id}/captions.json`, (route) =>
      route.fulfill({
        json: { v: 1, pages: [{ at: 645, page: FAKE_CAPTION }] },
      }),
    );
    // 続きの位置 (10 分)
    expect(
      (
        await request.post(`/api/recordings/${id}/resume`, {
          data: { at: 600, length: 1800 },
        })
      ).ok(),
    ).toBe(true);
    await compatOn(page);
    const asked = streamRequests(page);

    await goto(page, `/watch/${id}`);
    await expectDrawn(page, "fmp4");
    expect(asked[0]?.searchParams.get("codec")).toBe("av1");
    expect(asked[0]?.searchParams.get("from")).toBe("600.000");
    await expect(page.getByTestId("watch-resumed")).toBeVisible();
    expect(await where(page)).toBeGreaterThanOrEqual(600);

    // **CM 飛ばしで飛ぶ。** 観はじめから入っていて、CM の手前まで来たら、CM の終わりからリクエストし直す
    await expect(page.getByTestId("watch-skip-cm")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect
      .poll(() => asked.length, { timeout: 30_000 })
      .toBeGreaterThan(1);
    expect(asked[1]?.searchParams.get("from")).toBe("640.000");
    await expect(page.getByTestId("watch-skipped")).toBeVisible();
    await expect
      .poll(() => where(page), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(640);

    // **飛ぶ** (→ で 10 秒先)。飛んだ先からリクエストし直し、位置と字幕がそこに合う
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    const before = await where(page);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => asked.length).toBeGreaterThan(2);
    const jumped = Number(asked[2]?.searchParams.get("from"));
    expect(jumped).toBeGreaterThanOrEqual(before + 9);
    expect(jumped).toBeLessThan(before + 12);
    await expect
      .poll(() => where(page), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(Math.floor(jumped));
    expect(await where(page)).toBeLessThan(jumped + 10);
    await expect(page.getByTestId("watch-captions-canvas")).toHaveAttribute(
      "data-drawn",
      "",
      {
        timeout: 15_000,
      },
    );
    await expectDrawn(page, "fmp4");

    // **止めて再開しても位置が保たれる** (止めている間も進まず、再開は止めた所から。リクエストし直さない)
    const play = page.getByTestId("watch-play");
    await wakeControls(page, "watch-stage");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "再生");
    const paused = await where(page);
    const requests = asked.length;
    await page.waitForTimeout(2_500);
    expect(await where(page)).toBe(paused);
    await wakeControls(page, "watch-stage");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect
      .poll(() => where(page), { timeout: 15_000 })
      .toBeGreaterThan(paused);
    expect(await where(page)).toBeLessThan(paused + 5);
    expect(asked.length).toBe(requests);
  });

  /*
   * **互換モードでも、回線が細ければ「自動」は段を下げる** (`+page.svelte` の `canvasStep`)。canvas のプレイヤーには
   * 継ぎ目なく替える経路が無いので、いまの位置から段を下げた変換で作り直す。サーバが塊を捨てたと返す送り出しの具合
   * (`pace`) で下げさせる。GPU が無ければ下げた先はソフトウェアの H.264 なので、H.264 を描ける端末のふりをする
   * (流すものは AV1 に差し替えるので、H.264 はデコードしない)
   */
  test("回線が細いと、互換モードでも段を下げた変換で作り直して描き続ける", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await setRecording(request, { codecs: [] });
    const { id } = await recordOne(page, request);
    const clip = readClip(
      new Uint8Array(
        readFileSync(new URL("../fake/live-av1.mp4", import.meta.url)),
      ),
    );
    await page.addInitScript(() => {
      const real = VideoDecoder.isConfigSupported.bind(VideoDecoder);
      VideoDecoder.isConfigSupported = (config) =>
        config.codec.startsWith("avc1")
          ? Promise.resolve({ supported: true, config })
          : real(config);
    });
    await page.route(`**/api/recordings/${id}/playback`, (route) =>
      route.fulfill({
        json: {
          duration: 1800,
          axis: "encoded",
          audios: [{ id: "0", label: "" }],
          // 元の TS も置く。H.264 はメニューに並ばないので、無いとメニューが AV1 だけになって出ない
          offers: [
            {
              codec: "av1",
              way: "file",
              source: "encoded",
              codecs: "av01.0.08M.08,opus",
            },
            { codec: "h264", way: "stream", codecs: "avc1.640028,mp4a.40.2" },
            { codec: "av1", way: "stream", codecs: "av01.0.08M.08,opus" },
            { codec: "mpeg2", way: "raw" },
          ],
        },
      }),
    );
    // 段 0 (詰め替え) は「捨てた」と返す具合の id を付ける。段を下げたものはサーバが AV1 を選んだことにする
    await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
      const url = new URL(route.request().url());
      const rung = url.searchParams.get("rung") ?? "0";
      return route.fulfill({
        status: 200,
        contentType: "video/mp4",
        headers: {
          "X-Denpa-Codec": "av1",
          "X-Denpa-Rung": rung,
          "X-Denpa-Pace": rung === "0" ? "thin" : "fine",
        },
        body: Buffer.from(
          clipFrom(clip, Number(url.searchParams.get("from") ?? 0), 60),
        ),
      });
    });
    await page.route("**/api/playback/pace?**", (route) =>
      route.fulfill({
        json: {
          backlog: 0,
          dropped:
            new URL(route.request().url()).searchParams.get("id") === "thin"
              ? 3
              : 0,
          speed: null,
        },
      }),
    );
    await compatOn(page);
    const asked = streamRequests(page);

    await goto(page, `/watch/${id}`);
    await expectDrawn(page, "fmp4");
    expect(asked[0]?.searchParams.get("rung")).toBeNull();

    await expect(page.getByTestId("watch-adapt")).toHaveText(
      "回線が細いため、720p に下げました",
      { timeout: 30_000 },
    );
    const lowered = asked.find((url) => url.searchParams.has("rung"));
    expect(lowered?.searchParams.get("rung")).toBe("1");
    const playable = lowered?.searchParams.get("playable")?.split(",") ?? [];
    expect(playable).toContain("h264");
    expect(playable).not.toContain("hevc");
    // いまの位置から作り直す (先頭からではない)
    expect(Number(lowered?.searchParams.get("from"))).toBeGreaterThan(0);
    await expectDrawn(page, "fmp4");

    // メニューの「自動」の行に、サーバが選んだ形式と高さを添える
    await wakeControls(page, "watch-stage");
    await openSettings(page, "watch");
    await expect(page.getByTestId("watch-codec")).toContainText(
      "自動 (AV1 720p)",
    );
  });
});
