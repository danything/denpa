import { readFileSync } from "node:fs";

import { clipFrom, readClip } from "../fake/fmp4-clip";
import {
  expect,
  goto,
  recordOne,
  setRecording,
  test,
  wakeControls,
} from "./helpers";
import { playMuted } from "./watch-stream";

/**
 * **CM を自動で飛ばすとき、CM の区間のコマを 1 枚も映さない** (観る画面の `hopCm`・`follow`)。
 *
 * `<video>` が映したコマの時刻 (`requestVideoFrameCallback` の `mediaTime`) を 1 枚ずつ控え、そのとき覆い
 * (`watch-cover`) が出ていたかと組にする。CM の区間のコマが覆いの無いまま映っていたら落とす。
 * 控える側の呼び出しは画面の呼び出しより先に登録するので、画面がそのコマを見てから覆ったものも漏れとして数える
 * (そのコマはもう画面に渡っている)。
 *
 * 先読みは実時間で決める (`ts/watch.ts` の `cmLead`)。早送りでは速さを掛け、画面の処理が詰まって呼び出しが
 * 間遠なら伸ばす。物差しの 0.1 秒のままだった頃は、詰まっている間に CM の最初のコマが映った (下の `busy` で再現した)。
 * 早く飛びすぎて本編の末尾を削っていないことも見る。
 *
 * 映像は作り置きの fMP4 (`fmp4-clip.ts`) をその場の変換に見立てて、リクエストされた位置から返す
 */
const CM = { start: 3, end: 5 };

test.describe("CM のコマを映さずに飛ぶ", () => {
  /*
   * `busy` は画面の処理を詰まらせる (物差しの 0.25 秒ごとに 120 ms 塞ぐ)。データ放送や実況を描く処理が長いと、
   * 映したコマごとの呼び出しが間遠になり、そのあいだも映像は進む。最後に塞ぐのは、等速の先読み 0.1 秒に
   * まだ入らないコマの直後で、先読みを伸ばさなければ塞いでいる間に CM のコマが映る
   */
  for (const { rate, busy } of [
    { rate: 2, busy: false },
    { rate: 1, busy: true },
  ]) {
    const name = busy ? "画面の処理が詰まっていても" : `${rate} 倍速でも`;
    test(`${name}、CM の区間のコマを覆いの無いまま映さない`, async ({
      page,
      request,
    }) => {
      test.setTimeout(180_000);
      // エンコードしない録画にする (CM 検出が走らず、観はじめの CM 飛ばしがオンのまま。39-watch-adapt と同じ)
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
              duration: 60,
              axis: "encoded",
              audios: [{ id: "0", label: "" }],
              offers: [
                { codec: "av1", way: "stream", codecs: "av01.0.08M.08,opus" },
              ],
            },
          }),
        );
        await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
          const from = Number(
            new URL(route.request().url()).searchParams.get("from") ?? 0,
          );
          return route.fulfill({
            status: 200,
            contentType: "video/mp4",
            headers: { "X-Denpa-Codec": "av1" },
            body: Buffer.from(clipFrom(clip, from, 30)),
          });
        });
        await page.route(`**/api/recordings/${id}/chapters`, (route) =>
          route.fulfill({
            json: {
              chapters: [
                { start: 0, end: CM.start, title: "本編" },
                { start: CM.start, end: CM.end, title: "CM" },
                { start: CM.end, end: 60, title: "本編" },
              ],
            },
          }),
        );
        /*
         * 映したコマの時刻と、そのとき覆いが出ていたか。画面の処理が塞がっている間に映ったコマは呼び出しが来ないので、
         * 映したコマの数 (`presentedFrames`) の差から間のコマの時刻を起こす。その間の覆いは、次の呼び出しで見たもの
         * (控える側が先に呼ばれるので、画面がまだ触っていない)。
         *
         * `busy` なら、CM の先頭の 0.135 秒手前まで、物差しの 0.25 秒ごとに画面の処理を 120 ms 塞ぐ (呼び出しのあと、
         * 画面の呼び出しも済んでから)。最後に塞ぐのは、等速の先読み 0.1 秒にまだ入らないコマの直後
         */
        await page.addInitScript(
          ({ busy, start }) => {
            const frames: { at: number; covered: boolean }[] = [];
            (globalThis as { shownFrames?: typeof frames }).shownFrames =
              frames;
            let block = start - 0.135 - 0.25 * 8;
            const watch = (): void => {
              const video = document.querySelector<HTMLVideoElement>(
                '[data-testid="watch-video"]',
              );
              if (video === null) {
                requestAnimationFrame(watch);
                return;
              }
              let last: { at: number; count: number } | null = null;
              const next = (
                _: number,
                meta: { mediaTime: number; presentedFrames: number },
              ): void => {
                const cover = document.querySelector<HTMLCanvasElement>(
                  '[data-testid="watch-cover"]',
                );
                const covered = cover !== null && !cover.hidden;
                const skipped =
                  last === null ? 0 : meta.presentedFrames - last.count - 1;
                if (last !== null && skipped > 0 && meta.mediaTime > last.at) {
                  const step = (meta.mediaTime - last.at) / (skipped + 1);
                  for (let i = 1; i <= skipped; i++)
                    frames.push({ at: last.at + step * i, covered });
                }
                frames.push({ at: meta.mediaTime, covered });
                last = { at: meta.mediaTime, count: meta.presentedFrames };
                if (busy && meta.mediaTime >= block && meta.mediaTime < start) {
                  block += 0.25;
                  setTimeout(() => {
                    const until = performance.now() + 120;
                    while (performance.now() < until) {
                      // 塞ぐ
                    }
                  }, 0);
                }
                video.requestVideoFrameCallback(next);
              };
              video.requestVideoFrameCallback(next);
            };
            requestAnimationFrame(watch);
          },
          { busy, start: CM.start },
        );

        await goto(page, `/watch/${id}`);
        if (rate !== 1) {
          await wakeControls(page, "watch-stage");
          await page.getByTestId("watch-speed").click();
          await page
            .getByTestId("watch-speed-option")
            .filter({ hasText: `×${rate}` })
            .click();
          await expect(page.getByTestId("watch-speed")).toHaveText(
            String(rate),
          );
        }
        await playMuted(page);
        await expect(page.getByTestId("watch-skipped")).toBeVisible({
          timeout: 30_000,
        });
        const frames = async () =>
          (await page.evaluate(
            () =>
              (
                globalThis as {
                  shownFrames?: { at: number; covered: boolean }[];
                }
              ).shownFrames,
          )) ?? [];
        // 飛んだ先が覆いを外して映るまで
        await expect
          .poll(
            async () =>
              (await frames()).some((f) => f.at >= CM.end && !f.covered),
            { timeout: 30_000 },
          )
          .toBe(true);
        const seen = await frames();
        expect(
          await page
            .getByTestId("watch-video")
            .evaluate((v) => (v as HTMLVideoElement).playbackRate),
        ).toBe(rate);

        // CM の区間のコマは、覆いの無いまま 1 枚も映っていない
        const leaked = seen.filter(
          (f) => f.at >= CM.start - 0.0005 && f.at < CM.end && !f.covered,
        );
        expect(leaked).toEqual([]);

        /*
         * 早く飛びすぎていない。覆う前に映った最後の本編のコマは、先読み (実時間の 0.1 秒に速さを掛けたもの。
         * 詰まっているときは上限の 0.5 秒) と、呼び出しの間隔ぶんの手前まで
         */
        const first = seen.findIndex((f) => f.covered);
        const before = seen.slice(0, first).filter((f) => f.at < CM.start);
        expect(before.length).toBeGreaterThan(0);
        expect(before.at(-1)!.at).toBeGreaterThan(
          CM.start - (busy ? 0.5 + 0.25 : 0.1 * rate + 0.15),
        );
      } finally {
        await setRecording(request);
      }
    });
  }
});
