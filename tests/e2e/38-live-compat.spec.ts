import { rmSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { MX } from "../fake/services";
import {
  captureSockets,
  expect,
  feedNotice,
  goto,
  openSettings,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **互換モード** — ライブの H.264 / AV1 も canvas に描く (`src/lib/canvas-video.ts`・`src/lib/raw/fmp4.ts`)。
 *
 * テスラの車載ブラウザは停車中でも `<video>` を止める。互換モードではエンコードしたもの (fMP4) を MSE に
 * 渡さず、放送のままの MPEG-2 と同じ worker でデコードして canvas に描く。ここは**描くところまで**見る —
 * 偽 ffmpeg に目印 (`stack.liveFmp4File`) を置くと、本物の H.264 + AAC・AV1 + Opus の fMP4 を流す
 * (`tests/fake/fmp4-loop.ts`)。映像は VideoDecoder が、音は WASM (`wasm/decoder.c`、28-live-raw と同じ
 * デコーダ。AAC は ADTS の先頭を付けて、Opus は OpusHead で) がデコードする。
 *
 * 描くのは AV1 (互換モードの自動は AV1 を先に選ぶ)。箱の読み方 (avcC・esds) は単体試験 (`ts/fmp4.test.ts`) が見る
 */

const TESLA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2026.32.1";

/**
 * 選局して、自動で AV1 になるのを待つ (互換モードの自動は AV1 → H.264 → MPEG-2)。GPU が無いので
 * メニューに並ぶエンコードするものは H.264 で、AV1 は選べない
 */
async function watchAv1(page: Page): Promise<void> {
  await expect(page.getByTestId("live-title")).toBeVisible();
  await expect(page.getByTestId("live-codec")).toContainText("自動 (AV1)");
}

/** canvas に描いて、音も鳴らしていること (数が進む・映像が変わる) */
async function expectDrawn(page: Page, prefix = "live"): Promise<void> {
  const canvas = page.locator('[data-testid="live-raw"][data-input="fmp4"]');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const count = async (name: "shown" | "audio") =>
    Number((await canvas.getAttribute(`data-${name}`)) ?? 0);
  await expect
    .poll(() => count("shown"), { timeout: 30_000 })
    .toBeGreaterThan(10);
  const first = await count("shown");
  await expect
    .poll(() => count("shown"), { timeout: 15_000 })
    .toBeGreaterThan(first + 10);
  // 音 (AAC・Opus) を WASM でデコードできている
  await expect
    .poll(() => count("audio"), { timeout: 15_000 })
    .toBeGreaterThan(0);
  // 映像が動いている (testsrc2 の模様が流れる)
  const one = await canvas.screenshot();
  await expect(async () => {
    expect((await canvas.screenshot()).equals(one)).toBe(false);
  }).toPass({ timeout: 10_000 });
  // **`<video>` では再生していない** (MSE を繋いでいない)
  const video = page.getByTestId(`${prefix}-video`);
  expect(await video.evaluate((v) => (v as HTMLVideoElement).currentSrc)).toBe(
    "",
  );
}

test.describe("互換モード", () => {
  test.beforeEach(async ({ request, stack }) => {
    await syncEpg(request);
    writeFileSync(stack.liveFmp4File, "");
  });
  test.afterEach(async ({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });

  test("⚙ で入れると運転中の注意が出て、読み直したライブを canvas に描く", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    const toggle = page.getByTestId("live-compat");
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // 取消なら入らない。押すとメニューは閉じて、注意の窓だけになる
    await toggle.click();
    await expect(page.getByTestId("live-settings-menu")).toBeHidden();
    // ライブは再生の前に出す注意も持っている (閉じたまま)。開いているほうを見る
    const notice = page.locator('[data-testid="drive-notice"][open]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("運転中は画面を見ないでください");
    // フォーカスは箱に置き (取消に枠が付かない)、Tab でボタンへ進む
    await expect(notice.locator(".modal-box")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(notice.getByTestId("drive-notice-cancel")).toBeFocused();
    await notice.getByTestId("drive-notice-cancel").click();
    await expect(notice).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      await page.evaluate(() => localStorage.getItem("canvas-video")),
    ).toBeNull();

    // 「了解」で入って、ページを読み直す
    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await toggle.click();
    await Promise.all([
      page.waitForEvent("load"),
      notice.getByTestId("drive-notice-accept").click(),
    ]);
    expect(
      await page.evaluate(() => localStorage.getItem("canvas-video")),
    ).toBe("on");

    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect(page.getByTestId("live-compat")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 注意は入れたときに見せたので、ライブでは出さない
    await expect(page.getByTestId("drive-notice")).toBeHidden();

    // 自動は描ける形式の先頭 (互換モードは AV1 → H.264 → MPEG-2。Opus は WASM)
    await expect(page.getByTestId("live-codec")).toContainText("自動 (AV1)");
    await expectDrawn(page);

    // 止める・再開する (再開は放送の今から)
    const play = page.getByTestId("live-play");
    await wakeControls(page, "live-frame");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "再生");
    await wakeControls(page, "live-frame");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    // 遡れないのでシークバーは出さない
    await expect(page.getByTestId("live-seek")).toHaveCount(0);
  });

  test.describe("テスラの車載ブラウザ", () => {
    test.use({ userAgent: TESLA });

    test("触らなくても入っていて、初めて再生する前に注意を出す。押すまで再生しない", async ({
      page,
    }) => {
      // 開けばサーバが決めた局 (一覧の先頭) をそのまま選局しに行く。その前に注意が出る
      await goto(page, "/live");
      const notice = page.getByTestId("drive-notice");
      await expect(notice).toBeVisible();
      // 再生の前では取消は出さない (押すまで待つ)
      await expect(page.getByTestId("drive-notice-cancel")).toHaveCount(0);
      await page.waitForTimeout(1_000);
      await expect(page.getByTestId("live-raw")).toHaveCount(0);
      await page.getByTestId("drive-notice-accept").click();
      await expect(notice).toBeHidden();
      expect(
        await page.evaluate(() => localStorage.getItem("canvas-drive-notice")),
      ).toBe("1");

      await watchAv1(page);
      await expectDrawn(page);

      // 二度目からは出さない
      await goto(page, "/live");
      await expect(page.getByTestId("live-title")).toBeVisible();
      await expect(page.getByTestId("drive-notice")).toBeHidden();
      await expect(
        page.locator('[data-testid="live-raw"][data-input="fmp4"]'),
      ).toBeVisible({
        timeout: 30_000,
      });
    });

    /*
     * **互換モードでも、回線が細ければ「自動」は段を下げる** (`live-player.svelte.ts` の `adapt`)。下げた先のコーデックは
     * サーバが選ぶので、canvas に描けるものだけを `playable` に並べる (H.265 は描かない)。GPU が無ければ下げた先は
     * ソフトウェアの H.264 なので、H.264 を描ける端末のふりをする (Playwright の Chromium は描けないことがある。
     * 段を下げた後に描くところは見ない)
     */
    test("回線が細いと、互換モードでも描ける形式だけを渡して段を下げる", async ({
      page,
    }) => {
      await captureSockets(page);
      await page.addInitScript(() => {
        const real = VideoDecoder.isConfigSupported.bind(VideoDecoder);
        VideoDecoder.isConfigSupported = (config) =>
          config.codec.startsWith("avc1")
            ? Promise.resolve({ supported: true, config })
            : real(config);
        // 送った指示を控える
        const sent = window as unknown as { __sent: string[] };
        sent.__sent = [];
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data === "string") sent.__sent.push(data);
          send.call(this, data);
        };
      });
      // 自動で開く (前のテストで選んだものを消す)
      await page.context().clearCookies();
      await goto(page, "/live");
      await page.getByTestId("drive-notice-accept").click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      await expect(
        page.locator('[data-testid="live-raw"][data-input="fmp4"]'),
      ).toBeVisible({ timeout: 30_000 });

      // 選局の直後 (`adapt.ts` の `GRACE`) は数えないので、下がるまで送り続ける
      await expect(async () => {
        await feedNotice(page, [
          { type: "pace", backlog: 0, dropped: 3, speed: null },
        ]);
        await expect(page.getByTestId("live-warning")).toContainText(
          "回線が細いため",
          { timeout: 1_000 },
        );
      }).toPass({ timeout: 20_000 });
      const lowered = (
        await page.evaluate(
          () => (window as unknown as { __sent: string[] }).__sent,
        )
      )
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .filter((command) => command["type"] === "tune")
        .at(-1);
      expect(lowered?.["rung"]).toBeGreaterThanOrEqual(1);
      expect(lowered?.["raw"]).toBe(false);
      expect(lowered?.["playable"]).toContain("h264");
      expect(lowered?.["playable"]).not.toContain("hevc");
    });

    test("⚙ で明示して切れば、テスラでも <video> で観る", async ({ page }) => {
      // 触らなくても入っているので、まず運転中の注意が出る
      await goto(page, "/live");
      await page.getByTestId("drive-notice-accept").click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await openSettings(page, "live");
      const toggle = page.getByTestId("live-compat");
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      // 切るのは注意を出さずにその場で。読み直す
      await Promise.all([page.waitForEvent("load"), toggle.click()]);
      expect(
        await page.evaluate(() => localStorage.getItem("canvas-video")),
      ).toBe("off");

      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      // 注意も出さず、MSE に繋ぐ
      await expect(page.getByTestId("drive-notice")).toBeHidden();
      await expect
        .poll(
          () =>
            page
              .getByTestId("live-video")
              .evaluate((v) => (v as HTMLVideoElement).currentSrc),
          {
            timeout: 15_000,
          },
        )
        .toMatch(/^blob:/);
      await expect(page.getByTestId("live-raw")).toHaveCount(0);
    });
  });
});

test.describe("互換モードの追っかけ", () => {
  /** 録っている番組 (止めるのに使う) */
  let programId: number | null = null;
  test.beforeEach(async ({ request, stack }) => {
    await syncEpg(request);
    writeFileSync(stack.liveFmp4File, "");
  });
  test.afterEach(async ({ request, stack }) => {
    // 地上波の偽番組は 30 分あるので、止めないと次のテストまでチューナーを塞ぐ
    if (programId !== null) {
      await request.post("/guide?/cancel", {
        form: { programId: String(programId) },
      });
    }
    programId = null;
    rmSync(stack.liveFmp4File, { force: true });
    rmSync(stack.failFile, { force: true });
  });

  test("追っかけも canvas に描き、速さは出さず、止めた所から再開する", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    /*
     * **録っている最中に観る。** 追っかけは録っている最中だけで、録り終えた録画は観る画面へ送られる
     * (25-chase と同じく、地上波のいまの番組 (偽番組は 30 分) を録る)。エンコードは失敗させておく
     * (止めたあとエンコードできると元の TS が無くなり、リクエストし直しが断られる)
     */
    writeFileSync(stack.failFile, "1");
    // 入れてあり、注意も見せたことにしておく (出し方はライブのテストが見る)
    await page.addInitScript(() => {
      localStorage.setItem("canvas-video", "on");
      localStorage.setItem("canvas-drive-notice", "1");
    });
    const services = (await (await request.get("/api/services")).json()) as {
      id: number;
      now: { id: number } | null;
    }[];
    programId = services.find((s) => s.id === MX.id)?.now?.id ?? null;
    expect(programId, `${MX.name} にいま放送中の番組が要る`).not.toBeNull();
    expect(
      (
        await request.post("/live?/record", {
          form: { service: String(MX.id) },
        })
      ).ok(),
    ).toBe(true);
    let id = 0;
    await expect(async () => {
      type Item = { id: number; recording: boolean };
      const list = (await (
        await request.get("/api/recordings")
      ).json()) as Item[];
      id = list.find((rec) => rec.recording)?.id ?? 0;
      expect(id).toBeGreaterThan(0);
    }).toPass({ timeout: 120_000, intervals: [500] });

    await goto(page, `/chase/${id}`);
    await expect(page.getByTestId("chase-title")).toBeVisible();
    // 互換モードの自動は AV1 から (GPU が無いので、メニューに並ぶエンコードするものは H.264)
    await expect(page.getByTestId("chase-codec")).toContainText("自動 (AV1)");
    await expectDrawn(page, "chase");

    // 速さは等速だけ (切り替えを出さない)
    await wakeControls(page, "chase");
    await expect(page.getByTestId("chase-speed")).toHaveCount(0);

    // 止めても映像は止めた所のまま。再開すると続きから描く (リクエストし直さない — プレイヤーはそのまま数え続ける)
    const canvas = page.locator('[data-testid="live-raw"][data-input="fmp4"]');
    const shown = async () =>
      Number((await canvas.getAttribute("data-shown")) ?? 0);
    const play = page.getByTestId("chase-play");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "再生");
    const paused = await shown();
    await page.waitForTimeout(1_500);
    expect(await shown()).toBeLessThanOrEqual(paused + 2);
    await wakeControls(page, "chase");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(paused + 10);

    /*
     * **リクエストし直したあとも再生位置が飛ばない。** シークバーを動かすと (溢れの読み直しと同じく) いまの位置から
     * リクエストし直す。新しいストリームの時刻は 0 から数え直しになるので、再生位置はサーバが返す先頭 (`timeline`) +
     * 新しいストリームの中の秒になる。前のストリームの秒を足したまま先へ飛んでいないことを見る
     */
    // 再生位置は読みものの「m:ss / m:ss」の左 (シークバーの値は録れている長さで頭打ちになるので使わない)
    const status = page
      .getByTestId("chase-controls")
      .getByText(/^\d+:\d\d \/ \d+:\d\d$/);
    const where = async () => {
      const text = (await status.textContent()) ?? "";
      const [m = 0, s = 0] = text.split(" / ")[0]!.split(":").map(Number);
      return m * 60 + s;
    };
    await expect.poll(where, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
    const before = await where();
    // シークバーを動かすのと同じ (`seekBy`)。先頭へ戻す。押したボタンにフォーカスがあると矢印は効かない (`keys.ts`) ので外す
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowLeft");
    /*
     * **戻った先 (10 秒前) の近くに来たのを見てから数える。** 新しいストリームが届くまでは、手元に残った前の
     * ストリームを描き続け、再生位置もそれで進む (RawEngine を開き直すのは届いてから)。混んでいて届くのが
     * 遅れると、そのぶんのコマを新しいストリームのものと取り違え、前のストリームの位置を「後」として読んでいた
     */
    await expect
      .poll(where, { timeout: 15_000 })
      .toBeLessThan(Math.max(0, before - 10) + 3);
    // リクエストした所へ戻り、そこから進む。3 秒後も、前の再生位置より手前にある (前のストリームの秒を足していない)
    await expect
      .poll(shown, { timeout: 15_000 })
      .toBeGreaterThan((await shown()) + 30);
    await page.waitForTimeout(3_000);
    const after = await where();
    expect(after).toBeLessThan(before);
    await expect.poll(where, { timeout: 15_000 }).toBeGreaterThan(after);
  });
});
