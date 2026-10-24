import { writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, goto, pickCodec, wakeControls } from "./helpers";

/**
 * **ライブの貯め方を実時間で見る部品** (`50-live-pacing`・`51-live-gaps`)。
 *
 * 偽 ffmpeg に本物の AV1 の fMP4 を流させ (`stack.liveFmp4File`)、目印に書いた JSON で届き方を荒らす
 * (`tests/fake/fmp4-loop.ts`)。MSE に入れて実際に再生し、`<video>` の貯まりと途切れ (`waiting`) を数える。
 *
 * 実時間で流すので1本が1〜2分かかる。**1つのスペックに並べない** — CI の組 (`shards.json`) を1つだけ長くする
 */

/** 貯まり (`buffered.end - currentTime`) と貯めようとしている量を、再生が落ち着いてから記録し始める */
export async function watch(
  page: Page,
  rough: string,
  stack: { liveFmp4File: string },
  path = "/live",
): Promise<void> {
  writeFileSync(stack.liveFmp4File, rough);
  await goto(page, path);
  await page.getByTestId("live-channel").first().click();
  await expect(page.getByTestId("live-title")).toBeVisible();
  await wakeControls(page, "live-frame");
  await pickCodec(page, "live", "av1");
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
    .toBeGreaterThan(0.5);
  // 始めた直後は貯まりが狙いより多い。落ち着いてから記録する
  await page.waitForTimeout(3_000);
  await page.evaluate(() => {
    const video = document.querySelector(
      '[data-testid="live-video"]',
    ) as HTMLVideoElement;
    const scope = window as unknown as {
      __lags: number[];
      __targets: number[];
    };
    scope.__lags = [];
    scope.__targets = [];
    setInterval(() => {
      const ranges = video.buffered;
      if (ranges.length > 0)
        scope.__lags.push(ranges.end(ranges.length - 1) - video.currentTime);
      // 下限が上がっていないときは出ていない (= 貯める量は下限のまま)
      const shown = document.querySelector('[data-testid="live-floor"]');
      scope.__targets.push(Number(shown?.getAttribute("data-target") ?? 0.2));
    }, 100);
  });
}

export interface Watched {
  stalls: number;
  lag: number;
  target: number;
  gap: number;
}

export async function result(page: Page, name: string): Promise<Watched> {
  const seen = await page.evaluate(() => {
    const scope = window as unknown as {
      __lags: number[];
      __targets: number[];
    };
    // 選局してからの途切れ (`live-player` の `stalls`。自分で飛んだぶんは数えない)。0 なら出ていない
    const stalls = document
      .querySelector('[data-testid="live-stalls"]')
      ?.textContent?.match(/[0-9]+/)?.[0];
    const gap = document
      .querySelector('[data-testid="live-floor"]')
      ?.getAttribute("data-gap");
    return {
      lags: scope.__lags,
      targets: scope.__targets,
      stalls: Number(stalls ?? 0),
      gap: Number(gap ?? 0),
    };
  });
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const watched = {
    stalls: seen.stalls,
    lag: median(seen.lags),
    target: median(seen.targets),
    gap: seen.gap,
  };
  writeFileSync(
    `test-results/live-pacing-${name}.json`,
    JSON.stringify(watched),
  );
  return watched;
}
