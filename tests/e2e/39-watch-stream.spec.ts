import { readFileSync, rmSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { clipFrom, readClip } from "../fake/fmp4-clip";
import {
  expect,
  goto,
  openSettings,
  pickCodec,
  recordOne,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **観る画面で、サーバがその場で流すものを観る** (`api/recordings/<id>/playback`・`stream`。
 * 選び方は `ts/playback.ts`、受け方は `remux-player.ts`)。
 *
 * 偽 ffmpeg は映像を作らないので、映像が出るところまでは見ない。見るのは**何をリクエストするか** —
 * どの形式を・どの位置から・どの音声でリクエストし、飛んだらリクエストし直し、混んでいると言われたら勧め直すか
 */

/** リクエストした `stream` の URL を順に控える */
function streamRequests(page: Page): URL[] {
  const seen: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/api\/recordings\/\d+\/stream$/.test(url.pathname)) seen.push(url);
  });
  return seen;
}

test.describe("観る画面でその場で流す", () => {
  test.afterAll(({ stack }) => {
    rmSync(stack.failFile, { force: true });
  });

  /**
   * **録り終えてエンコードできていない録画も観る画面で観る** (追っかけは録っている最中だけ)。
   * サーバが元の TS をその場で変換して流す。字幕は元の TS から抜き、データ放送は出さない
   * (エンコード済みの時刻で書いてあるため)
   */
  test("エンコードできていない録画は観る画面で開き、元の TS を変換させて流す", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    writeFileSync(stack.failFile, "1");
    const programId = await reserveSoon(page, request, "BS");
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await expect(async () => {
      await goto(page, "/");
      await expect(row.getByTestId("recording-state")).toHaveText(
        "エンコード失敗",
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 120_000, intervals: [500] });
    rmSync(stack.failFile, { force: true });

    const id = await row.getAttribute("data-recording-id");
    const asked = streamRequests(page);
    await expect(row.getByTestId("play-hint")).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));

    /*
     * **録画しか無いときの自動は、ライブ・追っかけと同じ「その場でエンコード」の順** (`autoOrder`)。E2E は 127.0.0.1 で
     * 開くので家の中で、元の TS をそのまま流してこの端末でデコードし、互換モードと同じく canvas に描く
     */
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0]?.searchParams.get("codec")).toBe("mpeg2");
    expect(asked[0]?.searchParams.get("from")).toBe("0.000");
    const canvas = page.locator(
      '[data-testid="live-raw"][data-input="ts-mpeg2"]',
    );
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-shown")) ?? 0),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(10);
    // ファイルそのままは渡さない (元の TS は `<video>` で読めない)
    await expect(page.getByTestId("watch-video")).not.toHaveAttribute(
      "src",
      /file/,
    );
    await wakeControls(page, "watch-stage");
    // 速さは等速だけ (canvas に描くときは互換モードと同じく切り替えを出さない)
    await expect(page.getByTestId("watch-speed")).toHaveCount(0);

    // 字幕は元の TS から (偽 ffmpeg は作り置きの字幕を返す)。データ放送は出さない
    await expect(page.getByTestId("watch-captions")).toHaveCount(1);
    await expect(page.getByTestId("watch-data")).toHaveCount(0);

    // ほかのコーデックを選ぶと、サーバに変換させて `<video>` で観る
    await pickCodec(page, "watch", "av1");
    await expect
      .poll(() => asked.at(-1)?.searchParams.get("codec"))
      .toBe("av1");
    await expect(page.getByTestId("live-raw")).toHaveCount(0);
    await wakeControls(page, "watch-stage");
    await expect(page.getByTestId("watch-speed")).toBeVisible();
  });

  /**
   * **コーデックを選べる** (この端末で観られる方式が 2 つ以上あるとき)。エンコード済みと違うものを選ぶと
   * サーバに変換させて流す。選んだものは端末ごとに覚え、続きの位置からリクエストする。
   * サーバが混んでいると言えば、変換させずに観られるものを勧める。
   *
   * 何で観られるかはここで決めて渡す (H.264 のエンコード済みと、AV1 への変換と、元の TS)。Playwright の
   * Chromium は H.264 を持たないので、H.264 のファイルは読めることにする。H.264 はメニューに並ばない
   * (`#lib/live-choice.ts` の `HIDDEN_CODECS`) ので、メニューは自動・AV1・MPEG-2 になる
   */
  test("エンコード済みと違うコーデックを選ぶと、続きの位置から変換させて流す", async ({
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
          audios: [
            { id: "0", label: "主音声" },
            { id: "1", label: "副音声" },
          ],
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
    let busy = false;
    await page.route(`**/api/recordings/${id}/stream?**`, (route) =>
      busy
        ? route.fulfill({
            status: 503,
            json: { message: "サーバが混んでいます" },
          })
        : route.fulfill({ status: 200, contentType: "video/mp4", body: "" }),
    );
    // 続きの位置 (10 分)
    expect(
      (
        await request.post(`/api/recordings/${id}/resume`, {
          data: { at: 600, length: 1800 },
        })
      ).ok(),
    ).toBe(true);

    await goto(page, `/watch/${id}`);
    expect(
      await page.evaluate(() =>
        MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08,opus"'),
      ),
      "Chromium の MSE が AV1 を受け取れること",
    ).toBe(true);
    // 自動ではエンコード済みのファイルそのまま
    const video = page.getByTestId("watch-video");
    await expect(video).toHaveAttribute(
      "src",
      `/api/recordings/${id}/file?source=encoded`,
    );

    const asked = streamRequests(page);
    await wakeControls(page, "watch-stage");
    await pickCodec(page, "watch", "av1");
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0]?.searchParams.get("codec")).toBe("av1");
    expect(asked[0]?.searchParams.get("audio")).toBe("0");
    await expect(page.getByTestId("watch-codec")).toContainText("AV1");

    // 選んだものは端末ごとに覚える。開き直すと、はじめから変換させて続きの位置からリクエストする
    const reopened = streamRequests(page);
    await goto(page, `/watch/${id}`);
    await expect.poll(() => reopened.length).toBeGreaterThan(0);
    expect(reopened[0]?.searchParams.get("codec")).toBe("av1");
    expect(reopened[0]?.searchParams.get("from")).toBe("600.000");

    /*
     * 飛んだ先からのリクエストし直しは `remux-player.test.ts` が見ている (偽のストリームは中身が空で、
     * 尺が分からないうちは `<video>` が位置を受け付けない)
     *
     * 混んでいると言われたら、変換させずに観られるもの (H.264 のファイル) を勧める
     */
    busy = true;
    await goto(page, `/watch/${id}`);
    const note = page.getByTestId("watch-status");
    await expect(note).toContainText("サーバが混んでいます");
    await note
      .getByTestId("watch-busy-switch")
      .filter({ hasText: "H.264" })
      .click();
    // 同じ幕は、移った先の読み込み中にも出る。混んでいるという文言だけが消える
    await expect(page.getByText("サーバが混んでいます")).toHaveCount(0);
    await expect(video).toHaveAttribute(
      "src",
      `/api/recordings/${id}/file?source=encoded`,
    );
  });

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
   * ファイルの直再生から段を下げた変換へ移っても、黒く塗った覆いを出さず、観ていない頭の CM を飛ばず
   * (「CM を飛ばしました」を出さない)、観ていた位置から続ける。同じ `<video>` を作り直していた頃は、
   * 位置が 0 に戻った一瞬に頭の CM を飛び、映像も黒くなっていた。
   *
   * ファイルは頭の 12 秒ぶんだけにし (届いたぶんを観終えそうになる)、映像は作り置きの fMP4 (`fmp4-clip.ts`) を使う
   */
  test("段を下げても黒くならず、頭の CM を飛ばず、観ていた位置から続ける", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    // エンコードしない録画にする (CM 検出が走らず、観はじめの CM 飛ばしがオンのまま。40-watch-compat と同じ)
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
      // ファイルは頭の 12 秒ぶんしか無い。先のバッファが減り続けて 2 秒を切ると、段を下げる
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
      // 頭の 1 秒が CM
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
      // 頭の CM を飛んで本編を観る (ここで出る「CM を飛ばしました」は本当に飛んだもの)
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
      // 入れ替えた側は観ていた位置から続ける (頭へ戻らない)
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
