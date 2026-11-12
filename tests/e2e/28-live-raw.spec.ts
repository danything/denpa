import { existsSync, readFileSync } from "node:fs";

import {
  expect,
  goto,
  pickCodec,
  syncEpg,
  takeClip,
  test,
  wakeControls,
} from "./helpers";
import { chooseRaw } from "./live";

/**
 * ライブを MPEG-2 のまま見る ([docs/stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))。
 *
 * エンコードする経路の E2E (20-live など) と違って、**ここは映像が出るところまで見る。** 偽エージェントは
 * 本当にデコードできる MPEG-2 と AAC を流していて (`packages/arib/src/synth-av.ts`)、ブラウザの中の
 * WASM のデコーダ (`wasm/decoder.c`、Dockerfile の `mpeg2wasm` 段で組む) がそれをデコードする。
 * デコーダの置き場は `MPEG2_DIR` (CI は組んだものをランナーへ出して渡す)。
 *
 * 映像は worker の canvas にあって画面から画素を読めないので、**描いたコマ数とデコードできた音の
 * コマ数** (canvas の `data-shown` / `data-audio`) が進むこと、canvas を撮った画像が
 * 時間とともに変わることを見る。GPU の無いヘッドレス (SwiftShader) でも同じに動く。
 *
 * 2 本に分けて別のワーカーで流す ([docs/development.md](../../docs/development.md#並べて流す))。
 * ここは映像と音が出るまでと、局の切り替え・切り抜き・小窓。バックグラウンド再生の音と、
 * MPEG-2 をデコードできない端末・端末に覚える選択は [28-live-raw-device.spec.ts](28-live-raw-device.spec.ts) にある
 */

/** 偽 ffmpeg に渡された引数を、1 回ぶんずつに切る (`tests/fake/ffmpeg.sh`) */
function ffmpegRuns(file: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("---\n")
    .filter((run) => run.trim() !== "")
    .map((run) => run.split("\n"));
}

test.describe("ライブを MPEG-2 のまま見る", () => {
  // MPEG-2 をデコードできる端末として開く (`stack.ts` の `liveWithoutMpeg2`)
  test.use({ liveMpeg2: true });

  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("MPEG-2 を選ぶと、エンコードせず放送のままデコードして描き、音も出す", async ({
    page,
    stack,
  }) => {
    const before = ffmpegRuns(stack.liveArgsFile).length;
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);

    const canvas = page.getByTestId("live-raw");
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // 切り替えに選んだものが出る
    await expect(page.getByTestId("live-codec")).toContainText("MPEG-2");

    // **コマが進む。** 1 秒に 60 枚 (フィールドごと) 描くので、数秒で数十は進む
    const shown = async () =>
      Number((await canvas.getAttribute("data-shown")) ?? 0);
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);
    const first = await shown();
    await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(first + 10);

    // **音もデコードできている** (WASM の AAC デコーダが ADTS をデコードした)
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-audio")) ?? 0),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // **映像が動いている。** 縞が流れるので、時間をおいて撮った 2 枚は違う
    const one = await canvas.screenshot();
    await expect(async () => {
      const two = await canvas.screenshot();
      expect(two.equals(one)).toBe(false);
    }).toPass({ timeout: 10_000 });

    // 再生中になり、止める・再開するも繋がっている (再開は放送の今から)
    await expect(page.getByTestId("live-status")).toHaveCount(0);
    const play = page.getByTestId("live-play");
    // 操作バーは触らないと引っ込む (`ControlBar`)。動かして出してから押す
    await wakeControls(page, "live-frame");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "再生");
    await wakeControls(page, "live-frame");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    const resumed = await shown();
    await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(resumed + 10);

    /*
     * **エンコードする ffmpeg は起こさない。** 起きるのは字幕だけを描く 1 本で、放送の時刻のまま
     * 出させる (`-copyts`。`server/captions.ts` の `rawCaptionArgs`)。
     *
     * 見るのは**MPEG-2 のままでリクエストしたあと**にエンコードし始めていないこと
     */
    const runs = ffmpegRuns(stack.liveArgsFile).slice(before);
    const captions = runs.findIndex((run) => run.includes("-copyts"));
    expect(captions).toBeGreaterThanOrEqual(0);
    const baked = runs
      .slice(captions)
      .some((run) => run.includes("libx264") || run.includes("libsvtav1"));
    expect(baked).toBe(false);
  });

  test("局を変えても MPEG-2 のまま、新しい局の映像が出る", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await channels.first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    const canvas = page.getByTestId("live-raw");
    const shown = async () =>
      Number((await canvas.getAttribute("data-shown")) ?? 0);
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);

    await channels.nth(1).click();
    await expect(channels.nth(1)).toHaveAttribute("data-current", "true");
    // 切り替えの間も前の局の映像のまま (テレビと同じ)。幕で塗り潰さない
    await expect(
      page.locator('[data-testid="live-status"][data-veiled="true"]'),
    ).toHaveCount(0);
    // プレイヤーは作り直さない (同じ canvas のまま、数え続ける)
    const after = await shown();
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(after + 10);
    await expect(page.getByTestId("live-codec")).toContainText("MPEG-2");
  });

  /*
   * **選局したての先頭を捨てない** (`packages/arib/src/service-filter.ts`)。本物の電波は PAT・PMT を 100ms ごとに流すので、
   * 選局したては映像と音声が先に届く。捨てていた頃は、PMT を読んでから音を貯め始めていた — 鳴り出すのは
   * 貯める量 (0.2 秒) が貯まってから。取っておけば、PMT と一緒に貯まったぶんが届いてすぐ鳴り出す
   * (手元で、新しい局の PAT が届いてから鳴り出すまで 直す前 197ms → 直したあと 16〜20ms)。
   * 偽の電波は表を 1 秒おきに流すので (`Knobs.tablesLate`)、その間に届いたものを取っておけているかを見る
   */
  test("局を変えて PMT が遅れても、届いていた音からすぐ鳴り出す", async ({
    page,
    stack,
    request,
  }) => {
    await page.addInitScript(() => {
      const scope = window as unknown as {
        __tuned: number | null;
        __firstTs: number | null;
        __started: number | null;
      };
      scope.__tuned = null;
      scope.__firstTs = null;
      scope.__started = null;
      /*
       * 新しい局の PAT が届いた時刻 (`tuned` の後ろの 0x02 で、PID 0 のパケットを含む最初の塊)。
       * 番組表 (EIT) は局に関係なく通るので、PAT より先に届く
       */
      const hasPat = (data: ArrayBuffer): boolean => {
        const bytes = new Uint8Array(data, 9);
        for (let at = 0; at + 188 <= bytes.length; at += 188)
          if (((bytes[at + 1]! & 0x1f) << 8) + bytes[at + 2]! === 0)
            return true;
        return false;
      };
      const Native = WebSocket;
      class Spy extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const kind = new DataView(event.data).getUint8(0);
            if (kind === 0x40) {
              const text = new TextDecoder().decode(
                new Uint8Array(event.data, 9),
              );
              if ((JSON.parse(text) as { type: string }).type === "tuned")
                scope.__tuned = performance.now();
            } else if (
              kind === 0x02 &&
              scope.__tuned !== null &&
              scope.__firstTs === null &&
              hasPat(event.data)
            )
              scope.__firstTs = performance.now();
          });
        }
      }
      window.WebSocket = Spy;
      // 鳴らし始め (`raw/engine.ts` の `play`)。新しい局の塊が届いてからの最初のもの
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (scope.__firstTs !== null && scope.__started === null)
          scope.__started = performance.now();
        return start.apply(this, args);
      };
    });
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await channels.first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    const canvas = page.getByTestId("live-raw");
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-audio")) ?? 0),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(10);

    await request.post(`${stack.agentUrl}/__control/tables-late?on=1`);
    try {
      await page.evaluate(() => {
        const scope = window as unknown as {
          __tuned: number | null;
          __firstTs: number | null;
          __started: number | null;
        };
        scope.__tuned = null;
        scope.__firstTs = null;
        scope.__started = null;
      });
      await channels.nth(1).click();
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as unknown as { __started: number | null }).__started,
            ),
          { timeout: 30_000 },
        )
        .not.toBeNull();
      const { firstTs, started } = await page.evaluate(() => {
        const scope = window as unknown as {
          __firstTs: number;
          __started: number;
        };
        return { firstTs: scope.__firstTs, started: scope.__started };
      });
      // 貯める量 (0.2 秒) を待っていない
      expect(started - firstTs).toBeLessThan(150);
    } finally {
      await request.post(`${stack.agentUrl}/__control/tables-late?on=0`);
    }
  });

  /*
   * **MPEG-2 のまま見ている間も切り抜ける。** 映像は worker の canvas にあって `<video>` は空なので、
   * worker に 1 枚貰う (`raw/engine.ts` の `grab`)。描いたものは残さない作り
   * (`preserveDrawingBuffer` 無し) なので、**描き直さずに読むと真っ黒**になる — 黒くないことまで見る
   */
  test("MPEG-2 のまま見ている間も切り抜きは映像ごとサーバに届く", async ({
    page,
    request,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    const canvas = page.getByTestId("live-raw");
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-shown")) ?? 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(10);

    await wakeControls(page, "live-frame");
    // 送った 1 枚を見る。偽 ffmpeg は受けたものをそのまま置くので、置いた画像が送った WebP
    const clip = await takeClip(page, "live-shot");
    const image = (
      await (await request.get(`/api/clips/${clip.id}/image`)).body()
    ).toString("base64");
    const lit = await page.evaluate(async (data) => {
      // data: を fetch すると CSP (connect-src 'self') に止められるので、手でデコードする
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes]);
      const bitmap = await createImageBitmap(blob);
      const board = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = board.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let bright = 0;
      for (let i = 0; i < pixels.length; i += 4 * 97) {
        if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 60) bright++;
      }
      return { width: bitmap.width, bright };
    }, image);
    expect(lit.width).toBeGreaterThan(0);
    expect(lit.bright).toBeGreaterThan(0);
  });

  /*
   * **MPEG-2 のままでも小窓 (PiP) に映像が出る。** 映像は worker の canvas にあって `<video>` は空なので、
   * canvas からストリームを取って見えない `<video>` (`pip-raw`) に映し、それを小窓にする。
   *
   * その `<video>` は MPEG-2 のままに切り替えた時点で 1 枚目まで受け取っておく。押されてから待つと、
   * iPhone の Safari は「押された直後」と見なさなくなって断った (`NotAllowedError`)。
   * 押す前に 1 枚目が届いていること、押したら小窓に入ってコマが流れること、
   * 小窓で止めると操作バーも止まることを見る
   */
  test("MPEG-2 のままでも小窓に映像が出て、小窓で止めると操作バーも止まる", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    const canvas = page.getByTestId("live-raw");
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-shown")) ?? 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(10);

    // 押す前に 1 枚目が届いている (`HAVE_METADATA` 以上)
    const proxy = page.getByTestId("pip-raw");
    await expect
      .poll(() => proxy.evaluate((v) => (v as HTMLVideoElement).readyState), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1);

    /*
     * **Chrome は worker が描いたコマを直に書き込む** (`MediaStreamTrackGenerator`)。canvas の
     * 画面への更新から取っていた頃は、Chrome の窓が小窓の後ろに隠れると映像が止まった (Ubuntu)
     */
    expect(
      await proxy.evaluate((v) => {
        const Generator = (
          globalThis as { MediaStreamTrackGenerator?: unknown }
        ).MediaStreamTrackGenerator as (new () => unknown) | undefined;
        const track = (
          (v as HTMLVideoElement).srcObject as MediaStream
        ).getVideoTracks()[0];
        return Generator === undefined || track instanceof Generator;
      }),
    ).toBe(true);

    await wakeControls(page, "live-frame");
    const pip = page.getByTestId("live-pip");
    await pip.click();
    await expect(pip).toHaveAttribute("aria-pressed", "true");
    expect(
      await proxy.evaluate((v) => document.pictureInPictureElement === v),
    ).toBe(true);
    // 小窓にコマが流れている (押す前は流れを切ってある)
    const frames = await proxy.evaluate(
      (v) =>
        new Promise<number>((done) => {
          const video = v as HTMLVideoElement;
          let count = 0;
          const next = () => {
            count += 1;
            video.requestVideoFrameCallback(next);
          };
          video.requestVideoFrameCallback(next);
          setTimeout(() => done(count), 1000);
        }),
    );
    expect(frames).toBeGreaterThan(5);

    /*
     * **字幕も小窓に出る** (`compose.ts`)。偽の放送に字幕は乗っていないので、画面の字幕の
     * canvas に赤い帯を描いて「描いている」印を立てる (`caption-draw.ts` の `CaptionPainter` と同じ印)。
     * 小窓のコマの同じ所が赤くなり、印を下ろせば (字幕を消した) 元の映像に戻る
     */
    const captionShown = (on: boolean) =>
      page.getByTestId("live-captions").evaluate((c, on) => {
        const canvas = c as HTMLCanvasElement;
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.clearRect(0, 0, 1920, 1080);
        if (on) {
          ctx.fillStyle = "rgb(255, 0, 0)";
          ctx.fillRect(0, 810, 1920, 216);
          canvas.dataset["drawn"] = "";
        } else delete canvas.dataset["drawn"];
      }, on);
    // 小窓のコマの、字幕の帯の真ん中 (下から 1/6) の色
    const pipPixel = () =>
      proxy.evaluate((v) => {
        const video = v as HTMLVideoElement;
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.drawImage(video, 0, 0);
        const [r = 0, g = 0, b = 0] = ctx.getImageData(
          Math.floor(canvas.width / 2),
          Math.floor((canvas.height * 11) / 12),
          1,
          1,
        ).data;
        return r > 200 && g < 60 && b < 60;
      });
    await captionShown(true);
    await expect.poll(pipPixel, { timeout: 5_000 }).toBe(true);
    await captionShown(false);
    await expect.poll(pipPixel, { timeout: 5_000 }).toBe(false);

    // 小窓の再生ボタン (代わりの `<video>` を直に止める) で、操作バーも止まる・再開する
    const play = page.getByTestId("live-play");
    await proxy.evaluate((v) => (v as HTMLVideoElement).pause());
    await expect(play).toHaveAttribute("aria-label", "再生");
    await proxy.evaluate((v) => (v as HTMLVideoElement).play());
    await expect(play).toHaveAttribute("aria-label", "一時停止");

    await wakeControls(page, "live-frame");
    await pip.click();
    await expect(pip).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(() => document.pictureInPictureElement),
    ).toBeNull();
  });

  /*
   * **MPEG-2 のままの映像をストリームにできない端末では、その間だけ小窓のボタンを出さない。** Firefox は
   * 書き込む API (`MediaStreamTrackGenerator`) が無く、worker に渡した canvas からもストリームを
   * 取れない。押せても必ず断られる
   */
  test("MPEG-2 のままの映像をストリームにできない端末では、その間は小窓のボタンを出さない", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(globalThis, "MediaStreamTrackGenerator");
      HTMLCanvasElement.prototype.captureStream = () => {
        throw new DOMException("取れない", "NotSupportedError");
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    // エンコードしたもの (AV1) では出る
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");
    await wakeControls(page, "live-frame");
    await expect(page.getByTestId("live-pip")).toBeVisible();
    await chooseRaw(page);
    await expect
      .poll(
        async () =>
          Number(
            (await page.getByTestId("live-raw").getAttribute("data-shown")) ??
              0,
          ),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(10);
    await wakeControls(page, "live-frame");
    await expect(page.getByTestId("live-pip")).toHaveCount(0);
  });
});
