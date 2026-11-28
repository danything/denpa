import { readFileSync } from "node:fs";

import { clipFrom, readClip } from "../fake/fmp4-clip";
import {
  countBarWakes,
  expect,
  goto,
  openSettings,
  recordOne,
  test,
  wakeControls,
} from "./helpers";
import { playMuted, streamRequests } from "./watch-stream";

/**
 * **観る画面で、回線が細いと画質の段を下げて流す** (`watch-adapt.ts`・`handoff.ts`)。
 * 何をどの位置からリクエストするかの基本は `39-watch-stream`、下げるときの入れ替えは `39-watch-adapt-handoff`
 */

test.describe("観る画面でその場で流す", () => {
  /**
   * **回線が細ければ、「自動」は画質の段を下げて流す** (`watch-adapt.ts`)。エンコード済みのファイルが届かない
   * (回線を絞った) まま詰まって 3 秒たつと、ファイルの直再生から段 1 (720p) の変換へ移る (裏の `<video>` で用意して入れ替える)。
   * 段を下げた変換のコーデックはサーバが端末の再生できるもの (`playable`) から選び、応答のヘッダで返す。
   * 入れ替えても引っ込んだ操作バーは出さない (`controls.svelte.ts` の `stir`。入れ替えた `<video>` の `play` で出していた)。
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
    const wakes = await countBarWakes(page, "watch-stage", "watch-controls");
    await playMuted(page);

    await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1);
    const first = asked[0]!;
    expect(first.searchParams.get("rung")).toBe("1");
    expect(first.searchParams.get("playable")?.split(",")).toContain("av1");
    expect(first.searchParams.get("from")).toBe("0.000");
    await expect(page.getByTestId("watch-adapt")).toHaveText(
      "回線が細いため、720p に下げました",
    );
    await expect(video).not.toHaveAttribute("src", /file/);
    // 入れ替えた `<video>` が再生を始める (`play` は `paused` が false になった時点で来る) まで待つ
    await expect
      .poll(() => video.evaluate((v) => !(v as HTMLVideoElement).paused))
      .toBe(true);
    expect(await wakes()).toBe(0);

    // メニューの「自動」の行に、サーバが選んだ形式と高さを添える
    await wakeControls(page, "watch-stage");
    await openSettings(page, "watch");
    await expect(page.getByTestId("watch-codec")).toContainText(
      "自動 (AV1 720p)",
    );
  });

  /**
   * **読み始める前にブラウザが読むのを止めていても (`NETWORK_IDLE`)、回線のせいで詰まれば下げる** (`watch-adapt.ts` の `fileIdle`)。
   * `NETWORK_IDLE` は読み終えたときだけでなく、読み始める前 (`preload` が `none`) にも付く。それを「読み終えた」と読むと、
   * 1 バイトも届かないまま止まり続けた。いまの位置を読めていない間は、止めていても足りている印にしない
   */
  test("読み始める前に読むのを止めていても、ファイルが届かなければ下げる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "networkState", {
        get: () => HTMLMediaElement.NETWORK_IDLE,
      });
    });
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
    await playMuted(page);

    await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1);
    expect(asked[0]!.searchParams.get("rung")).toBe("1");
    await expect(page.getByTestId("watch-adapt")).toHaveText(
      "回線が細いため、720p に下げました",
    );
  });

  /**
   * **ファイルを読み終えていれば、終わり際に先のバッファが減っても画質を下げない** (`adapt.ts` の `idle`)。
   * ファイルの直再生は受け取りの速さを測れないので、先が終わりまでの長さになって 2 秒を切ると、
   * ローカルネットでも「回線が細いため、720p に下げました」と出していた
   */
  test("ファイルを読み終えていれば、終わり際に先のバッファが減っても下げない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    const clip = readClip(
      new Uint8Array(
        readFileSync(new URL("../fake/live-av1.mp4", import.meta.url)),
      ),
    );
    await page.route(`**/api/recordings/${id}/playback`, (route) =>
      route.fulfill({
        json: {
          duration: 20,
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
    // 20 秒のファイルをまるごと返す (すぐ読み終える)
    const file = Buffer.from(clipFrom(clip, 0, 20));
    await page.route(`**/api/recordings/${id}/file?**`, (route) =>
      route.fulfill({ status: 200, contentType: "video/mp4", body: file }),
    );
    await page.route(`**/api/recordings/${id}/chapters`, (route) =>
      route.fulfill({ json: { chapters: [] } }),
    );
    const asked = streamRequests(page);

    await goto(page, `/watch/${id}`);
    const video = page.getByTestId("watch-video");
    await expect(video).toHaveAttribute(
      "src",
      `/api/recordings/${id}/file?source=encoded`,
    );
    await playMuted(page);
    // 終わりまで観る。終わり際の 2 秒も段を動かさない
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).ended), {
        timeout: 60_000,
      })
      .toBe(true);
    expect(asked).toHaveLength(0);
    await expect(page.getByTestId("watch-adapt")).toHaveCount(0);
  });
});
