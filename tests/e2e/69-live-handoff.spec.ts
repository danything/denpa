import { rmSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import {
  captureSockets,
  expect,
  feedNotice,
  goto,
  setRecording,
  syncEpg,
  test,
} from "./helpers";

/**
 * **ライブの段を替えるときは、裏の `<video>` で用意してから入れ替える** (`live-player.svelte.ts` の `stageStep`。
 * docs/stream.md「段を替えるときは、裏の `<video>` で用意してから入れ替えます」)。
 *
 * 偽 ffmpeg に本物の H.264 の fMP4 を流させ、入口の TS の PCR から時計を配らせる (`tests/fake/fmp4-loop.ts` の `clock`)。
 * E2E は MPEG-2 をデコードできない端末として開くので、「自動」の段 0 は H.264 (MSE)。段を下げさせるのは、
 * サーバが塊を捨てたという通知 (`pace` の `dropped`) を流して (`61-live-auto` と同じ)
 *
 * 用意をやめる経路のうち、ここで見るのは変換の枠が空いていないとき。12 秒で入れ替えられない・裏に回る・小窓を出す・
 * 裏の接続にだけ `restarting`・`error` が届く、は偽のサーバと偽 ffmpeg では起こせない。どれも同じ `spareFailed`
 * (これまでどおりリクエストし直す) に入る
 */

/** 前のコマで覆った (`live-still` の `data-holding`) か、開いてからずっと見ておく */
async function watchHolding(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as { __held: boolean };
    scope.__held = false;
    setInterval(() => {
      const still = document.querySelector('[data-testid="live-still"]');
      if (still?.getAttribute("data-holding") === "true") scope.__held = true;
    }, 10);
  });
}

const held = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __held: boolean }).__held);

/** 段が下がるまで、塊を捨てたという通知を流し続ける (選局の直後と、切り替えのあとしばらくは数えない) */
async function lower(page: Page, label: RegExp): Promise<void> {
  await expect(async () => {
    await feedNotice(page, [
      { type: "pace", backlog: 0, dropped: 3, speed: null },
    ]);
    await expect(page.getByTestId("live-codec")).toContainText(label, {
      timeout: 1_000,
    });
  }).toPass({ timeout: 60_000 });
}

/** 映している `<video>` の位置 */
const at = (page: Page): Promise<number> =>
  page
    .getByTestId("live-video")
    .evaluate((video) => (video as HTMLVideoElement).currentTime);

test.describe("ライブの段の入れ替え", () => {
  test.beforeEach(async ({ request, stack }) => {
    await syncEpg(request);
    writeFileSync(stack.liveFmp4File, JSON.stringify({ clock: true }));
  });
  test.afterEach(async ({ request, stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
    await setRecording(request, { transcodeLimit: "" });
  });

  /** 選局して (`nth` 番目の局)、H.264 が映り始めるまで */
  async function open(page: Page, nth = 0): Promise<void> {
    await captureSockets(page);
    await goto(page, "/live");
    await page.getByTestId("live-channel").nth(nth).click();
    await expect(page.getByTestId("live-codec")).toContainText("自動 (H.264)");
    await expect.poll(() => at(page), { timeout: 30_000 }).toBeGreaterThan(1);
    await watchHolding(page);
  }

  test("段を下げるときは裏で用意して入れ替え、前のコマで覆って止めない。前の接続は閉じる", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page);
    await lower(page, /自動 \(H\.264 \d+p\)/);
    // 入れ替えた先の `<video>` が進んでいる
    const after = await at(page);
    await expect
      .poll(() => at(page), { timeout: 10_000 })
      .toBeGreaterThan(after + 0.5);
    expect(await held(page), "前のコマで覆った").toBe(false);
    // 裏の接続がいつもの接続になり、前の接続は閉じた
    const states = await page.evaluate(() =>
      (window as unknown as { __sockets: WebSocket[] }).__sockets.map(
        (socket) => socket.readyState,
      ),
    );
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[0]).toBe(WebSocket.CLOSED);
    expect(states.at(-1)).toBe(WebSocket.OPEN);
    await expect(page.getByTestId("live-video-spare")).toHaveCount(1);
  });

  test("変換の枠が空いていなければ、これまでどおり前のコマで覆ってリクエストし直す", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // 段を下げた変換は 1 本だけ。別の画面が別の局で段を下げて、その 1 本を使う
    await setRecording(request, { transcodeLimit: "1" });
    const other = await page.context().newPage();
    await open(other, 1);
    await lower(other, /自動 \(H\.264 \d+p\)/);
    // この画面の裏はサーバに断られる (段が下がらない) ので、いまの接続でリクエストし直す (前のコマで覆う)
    await open(page);
    await expect(async () => {
      await feedNotice(page, [
        { type: "pace", backlog: 0, dropped: 3, speed: null },
      ]);
      expect(await held(page)).toBe(true);
    }).toPass({ timeout: 60_000 });
    await other.close();
  });
});
