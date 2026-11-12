import { readFileSync } from "node:fs";

import { clipFrom, readClip } from "../fake/fmp4-clip";
import {
  expect,
  goto,
  openSettings,
  recordOne,
  setRecording,
  test,
  wakeControls,
} from "./helpers";
import { streamRequests } from "./watch-stream";

/**
 * **観る画面で、回線が細いと画質の段を下げて流す** (`watch-adapt.ts`・`handoff.ts`)。
 * 何をどの位置からリクエストするかの基本は `39-watch-stream`
 */

test.describe("観る画面でその場で流す", () => {
  /**
   * **回線が細ければ、「自動」は画質の段を下げて流す** (`watch-adapt.ts`)。エンコード済みのファイルが届かない
   * (回線を絞った) まま詰まって 3 秒たつと、ファイルの直再生から段 1 (720p) の変換へ移る (裏の `<video>` で用意して入れ替える)。
   * 段を下げた変換のコーデックはサーバが端末の再生できるもの (`playable`) から選び、応答のヘッダで返す。
   *
   * ファイルは届かないままにし、ストリームは作り置きの fMP4 (`fmp4-clip.ts`) をリクエストされた位置から返す
   */
  test("回線が細いと、自動はファイルの直再生から画質を下げた変換に移る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    await page.addInitScript(() => {
      const real = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type: string) {
        return type.includes("avc1") ? "probably" : real.call(this, type);
      };
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
              codec: "h264",
              way: "file",
              source: "encoded",
              codecs: "avc1.640028,opus",
            },
            { codec: "h264", way: "stream", codecs: "avc1.640028,mp4a.40.2" },
            { codec: "av1", way: "stream", codecs: "av01.0.08M.08,opus" },
            { codec: "mpeg2", way: "raw" },
          ],
        },
      }),
    );
    // 回線を絞る。ファイルは 1 バイトも届かない
    await page.route(`**/api/recordings/${id}/file?**`, () => undefined);
    const clip = readClip(
      new Uint8Array(
        readFileSync(new URL("../fake/live-av1.mp4", import.meta.url)),
      ),
    );
    await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
      const from = Number(
        new URL(route.request().url()).searchParams.get("from") ?? 0,
      );
      return route.fulfill({
        status: 200,
        contentType: "video/mp4",
        headers: { "X-Denpa-Codec": "av1", "X-Denpa-Rung": "1" },
        body: Buffer.from(clipFrom(clip, from, 60)),
      });
    });
    const asked = streamRequests(page);

    await goto(page, `/watch/${id}`);
    const video = page.getByTestId("watch-video");
    await expect(video).toHaveAttribute(
      "src",
      `/api/recordings/${id}/file?source=encoded`,
    );
    // 再生を始めておく (音を消した自動再生はブラウザが断らない)
    await video.evaluate((v) => {
      const media = v as HTMLVideoElement;
      media.muted = true;
      void media.play().catch(() => undefined);
    });

    await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1);
    const first = asked[0]!;
    expect(first.searchParams.get("rung")).toBe("1");
    expect(first.searchParams.get("playable")?.split(",")).toContain("av1");
    expect(first.searchParams.get("from")).toBe("0.000");
    await expect(page.getByTestId("watch-adapt")).toHaveText(
      "回線が細いため、720p に下げました",
    );
    await expect(video).not.toHaveAttribute("src", /file/);

    // メニューの「自動」の行に、サーバが選んだ形式と高さを添える
    await wakeControls(page, "watch-stage");
    await openSettings(page, "watch");
    await expect(page.getByTestId("watch-codec")).toContainText(
      "自動 (AV1 720p)",
    );
  });

  /**
   * **段を替えるときは、いまの映像を映したまま裏の `<video>` で用意して入れ替える** (`handoff.ts`)。
   * ファイルの直再生から段を下げた変換へ移っても、黒く塗った覆いを出さず、観ていない先頭の CM を飛ばず
   * (「CM を飛ばしました」を出さない)、観ていた位置から続ける。同じ `<video>` を作り直していた頃は、
   * 位置が 0 に戻った一瞬に先頭の CM を飛び、映像も黒くなっていた。
   *
   * ファイルは先頭の 12 秒ぶんだけにし (届いたぶんを観終えそうになる)、映像は作り置きの fMP4 (`fmp4-clip.ts`) を使う
   */
  test("段を下げても黒くならず、先頭の CM を飛ばず、観ていた位置から続ける", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    // エンコードしない録画にする (CM 検出が走らず、観はじめの CM 飛ばしがオンのまま。40-watch-compat-long と同じ)
    await setRecording(request, { codecs: [] });
    try {
      const { id } = await recordOne(page, request);
      const clip = readClip(
        new Uint8Array(
          readFileSync(new URL("../fake/live-av1.mp4", import.meta.url)),
        ),
      );
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
              { codec: "av1", way: "stream", codecs: "av01.0.08M.08,opus" },
            ],
          },
        }),
      );
      // ファイルは先頭の 12 秒ぶんしか無い。先のバッファが減り続けて 2 秒を切ると、段を下げる
      const file = Buffer.from(clipFrom(clip, 0, 12));
      await page.route(`**/api/recordings/${id}/file?**`, (route) =>
        route.fulfill({ status: 200, contentType: "video/mp4", body: file }),
      );
      // リクエストされた位置から 60 秒ぶん (時刻はページの物差しのまま)
      await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
        const from = Number(
          new URL(route.request().url()).searchParams.get("from") ?? 0,
        );
        return route.fulfill({
          status: 200,
          contentType: "video/mp4",
          headers: { "X-Denpa-Codec": "av1", "X-Denpa-Rung": "1" },
          body: Buffer.from(clipFrom(clip, from, 60)),
        });
      });
      // 先頭の 1 秒が CM
      await page.route(`**/api/recordings/${id}/chapters`, (route) =>
        route.fulfill({
          json: {
            chapters: [
              { start: 0, end: 1, title: "CM" },
              { start: 1, end: 1800, title: "本編" },
            ],
          },
        }),
      );
      const asked = streamRequests(page);

      await goto(page, `/watch/${id}`);
      const video = page.getByTestId("watch-video");
      await expect(video).toHaveAttribute(
        "src",
        `/api/recordings/${id}/file?source=encoded`,
      );
      await video.evaluate((v) => {
        const media = v as HTMLVideoElement;
        media.muted = true;
        void media.play().catch(() => undefined);
      });
      const where = (): Promise<number> =>
        video.evaluate((v) => (v as HTMLVideoElement).currentTime);
      // 先頭の CM を飛んで本編を観る (ここで出る「CM を飛ばしました」は本当に飛んだもの)
      await expect.poll(where, { timeout: 30_000 }).toBeGreaterThan(2);
      await expect(page.getByTestId("watch-skipped")).toHaveCount(0, {
        timeout: 10_000,
      });
      expect(asked).toHaveLength(0);

      // ここから、黒く塗った覆いと「CM を飛ばしました」が 1 コマでも出たかを控える
      await page.evaluate(() => {
        const seen = { skipped: 0, blank: 0 };
        (globalThis as { seen?: typeof seen }).seen = seen;
        const look = (): void => {
          if (document.querySelector('[data-testid="watch-skipped"]'))
            seen.skipped++;
          const cover = document.querySelector<HTMLCanvasElement>(
            '[data-testid="watch-cover"]',
          );
          if (
            cover !== null &&
            !cover.hidden &&
            cover.dataset["blank"] === "true"
          )
            seen.blank++;
          requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });

      // 段を下げた変換へ移る。観ている位置の先から用意する
      await expect.poll(() => asked.length, { timeout: 60_000 }).toBe(1);
      const first = asked[0]!;
      expect(first.searchParams.get("rung")).not.toBeNull();
      const from = Number(first.searchParams.get("from"));
      expect(from).toBeGreaterThan(2);
      await expect(page.getByTestId("watch-adapt")).toContainText(
        "に下げました",
        { timeout: 30_000 },
      );
      await expect(video).not.toHaveAttribute("src", /file/);
      // 入れ替えた側は観ていた位置から続ける (先頭へ戻らない)
      await expect.poll(where).toBeGreaterThan(from);
      const seen = await page.evaluate(
        () => (globalThis as { seen?: unknown }).seen,
      );
      expect(seen).toEqual({ skipped: 0, blank: 0 });
    } finally {
      await setRecording(request);
    }
  });
});
