import { rmSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, goto, syncEpg, test } from "./helpers";
import { result, watch } from "./live-pacing";

/**
 * **ライブの貯め方** (`src/lib/ts/pacing.ts`。docs/stream.md#たまに長く空く経路で止まり続ける)。見方は `live-pacing.ts`。
 * たまに長く空く経路は `51-live-gaps` (実時間で2分かかるので、CI の別の組で流す)。数字は test-results に残す
 */

test.describe("ライブの貯め方", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });
  test.afterEach(async ({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });

  /*
   * **低い遅延が先。** 宅内のように滑らかに届くなら、貯める量は下限 (0.2秒) のまま動かさない。
   * 遅延 (貯まり) も直す前と同じ (手元で中央値 0.185 秒。直す前も 0.185 秒)
   */
  test("滑らかに届けば、貯める量も遅延も下限のまま", async ({
    page,
    stack,
  }) => {
    test.setTimeout(150_000);
    await watch(page, "", stack);
    await page.waitForTimeout(60_000);
    const watched = await result(page, "smooth");
    expect(watched.stalls).toBe(0);
    expect(watched.target).toBeLessThanOrEqual(0.25);
    expect(watched.lag).toBeLessThanOrEqual(0.25);
  });

  /*
   * **Safari は速さを変えるたびにつまずく** (#1210。`pacing.ts` の `Steering`)。荒れた届き方で、
   * WebKit なら遅くしないことを見る (WebKit は `--browser=webkit` で手元だけ)
   */
  test("荒れた届き方で、WebKit なら遅くしない", async ({
    page,
    stack,
    browserName,
  }) => {
    test.skip(browserName !== "webkit", "WebKit だけの寄せ方");
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const scope = window as unknown as { __rates: number[] };
      scope.__rates = [];
      document.addEventListener(
        "ratechange",
        (event) =>
          scope.__rates.push((event.target as HTMLVideoElement).playbackRate),
        true,
      );
    });
    await watch(
      page,
      JSON.stringify({ gapEvery: [4, 6], gapMs: [500, 700] }),
      stack,
    );
    await page.waitForTimeout(40_000);
    const rates = await page.evaluate(
      () => (window as unknown as { __rates: number[] }).__rates,
    );
    writeFileSync(
      `test-results/live-rates-${browserName}.json`,
      JSON.stringify(rates),
    );
    expect(Math.min(1, ...rates)).toBe(1);
  });
});

interface Joined {
  /** 押してから、新しい MediaSource の1枚目が映るまで (ms) */
  firstFrame: number;
  /** 捨てられたコマ (Safari は飛ぶたびに 0 に戻すので、差を足し上げる) */
  dropped: number;
  /** 鳴り始めた位置と、映った1枚目の時刻の差 (秒)。手前から鳴らすと、映像はキーフレームで止まったまま音だけ進む */
  ahead: number;
}

/** いま見ている局を押し直す。**誰かが見ている局に後から入る**のと同じで、塊はキーフレームの途中から届く */
async function rejoin(page: Page): Promise<Joined> {
  await page.getByTestId("live-video").evaluate((v) => {
    const video = v as HTMLVideoElement & {
      requestVideoFrameCallback(
        cb: (now: number, meta: { mediaTime: number }) => void,
      ): number;
    };
    const scope = window as unknown as {
      __joined: Partial<Joined> & { done?: boolean };
    };
    const from = performance.now();
    const seen: Partial<Joined> & { done?: boolean } = { dropped: 0 };
    scope.__joined = seen;
    let last = 0;
    let playingAt: number | null = null;
    let media: number | null = null;
    const settle = () => {
      if (playingAt !== null && media !== null) seen.ahead = media - playingAt;
    };
    video.addEventListener(
      "loadedmetadata",
      () => {
        last = video.getVideoPlaybackQuality().droppedVideoFrames;
        video.requestVideoFrameCallback((_, meta) => {
          seen.firstFrame = performance.now() - from;
          media = meta.mediaTime;
          settle();
        });
        video.addEventListener(
          "playing",
          () => {
            playingAt = video.currentTime;
            settle();
          },
          { once: true },
        );
        const timer = setInterval(() => {
          const now = video.getVideoPlaybackQuality().droppedVideoFrames;
          seen.dropped = (seen.dropped ?? 0) + (now >= last ? now - last : now);
          last = now;
        }, 50);
        setTimeout(() => {
          clearInterval(timer);
          seen.done = true;
        }, 3_000);
      },
      { once: true },
    );
  });
  await page
    .locator('[data-testid="live-channel"][data-current="true"]')
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __joined: { done?: boolean } }).__joined
              .done,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  return (await page.evaluate(
    () => (window as unknown as { __joined: Joined }).__joined,
  )) as Joined;
}

/*
 * **途中から入っても、キーフレームから始める** (#1210。`src/lib/ts/key-gate.ts`)。
 *
 * キーフレームの手前から渡していた頃は、Safari (WebKit) がそのコマをデコードしては捨てて、選局の直後に
 * 3〜18 コマ落としていた。Chromium は落とさない代わりに、手前から音だけ鳴らして映像はキーフレームで止めていた。
 * どちらのブラウザでも同じことを見る (WebKit では `bunx playwright install webkit` のあと
 * `bunx playwright test 50-live-pacing --browser=webkit`)
 */
test.describe("途中から入る", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });
  test.afterEach(async ({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });

  test("キーフレームの途中から届いても、コマを落とさず、音と映像を揃えて始める", async ({
    page,
    stack,
  }) => {
    writeFileSync(stack.liveFmp4File, "");
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect
      .poll(
        () =>
          page
            .getByTestId("live-video")
            .evaluate((v) => (v as HTMLVideoElement).currentTime),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0.3);
    // キーフレームは 1 秒おき (`tests/fake/live-h264.mp4`)。入る位置をずらして2回
    const joined: Joined[] = [];
    for (const wait of [300, 700]) {
      await page.waitForTimeout(wait);
      joined.push(await rejoin(page));
    }
    writeFileSync("test-results/live-rejoin.json", JSON.stringify(joined));
    for (const one of joined) {
      expect(one.dropped).toBeLessThanOrEqual(1);
      expect(Math.abs(one.ahead)).toBeLessThanOrEqual(0.05);
      // 手元で 0.1〜0.7 秒 (キーフレームを待つぶん)。直す前と変わらない
      expect(one.firstFrame).toBeLessThan(2_000);
    }
  });
});

/** 局を押して、新しい局の再生が始まって (`playing`) から、1枚目の次のコマが映るまで (ms) */
async function switchTo(page: Page, index: number): Promise<number> {
  await page.getByTestId("live-video").evaluate((v) => {
    const video = v as HTMLVideoElement & {
      requestVideoFrameCallback(
        cb: (now: number, meta: { mediaTime: number }) => void,
      ): number;
    };
    const scope = window as unknown as { __moved: number | null };
    scope.__moved = null;
    // 前の局の `playing` を拾わないよう、作り直した (`emptied`) あとから見る
    video.addEventListener(
      "emptied",
      () => {
        video.addEventListener(
          "playing",
          () => {
            const from = performance.now();
            const first = video.currentTime;
            const next = (_: number, meta: { mediaTime: number }) => {
              if (meta.mediaTime > first + 0.001)
                scope.__moved = performance.now() - from;
              else video.requestVideoFrameCallback(next);
            };
            video.requestVideoFrameCallback(next);
          },
          { once: true },
        );
      },
      { once: true },
    );
  });
  await page.getByTestId("live-channel").nth(index).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __moved: number | null }).__moved,
        ),
      { timeout: 30_000 },
    )
    .not.toBeNull();
  return (await page.evaluate(
    () => (window as unknown as { __moved: number }).__moved,
  )) as number;
}

/*
 * **選局したての音声だけの塊を捨てず、再生の時計を止めない** (`src/lib/ts/key-gate.ts`)。
 *
 * 選局したての ffmpeg は、最初の塊が音声だけのことがあり、立ち上がりで読み込んだぶんをまとめて出すので貯まりも
 * 狙いより多い (画面はすぐ速めにかかる)。キーフレームを待つ係がその塊を捨てていた頃は、音声が映像より後から始まり、
 * Chromium は再生の時計が止まって1枚目のまま動かなかった (本番で 0.3〜0.6 秒。手元ではこの組の 24 回のうち 4 回、0.53〜7.9 秒)。
 * 直したあとは、作り置きの1枚目の尺 (0.155 秒) のぶんを足した 0.23〜0.25 秒に揃う
 */
test.describe("選局の直後", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });
  test.afterEach(async ({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });

  test("最初の塊が音声だけでも、再生の時計が止まらず次のコマが映る", async ({
    page,
    stack,
  }) => {
    writeFileSync(
      stack.liveFmp4File,
      JSON.stringify({ audioFirst: true, headStartMs: 400 }),
    );
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect
      .poll(
        () =>
          page
            .getByTestId("live-video")
            .evaluate((v) => (v as HTMLVideoElement).currentTime),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0.3);
    const moved: number[] = [];
    for (const index of [1, 0, 1, 0, 1, 0, 1, 0]) {
      await page.waitForTimeout(1_000);
      moved.push(await switchTo(page, index));
    }
    writeFileSync("test-results/live-switch.json", JSON.stringify(moved));
    for (const one of moved) expect(one).toBeLessThan(400);
  });
});
