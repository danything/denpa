import type { Page } from "@playwright/test";

import { expect } from "./helpers";

/** 互換モードの観る画面のスペックの部品 (`40-watch-compat`・`40-watch-compat-long`) */

/** 互換モードを入れて、運転中の注意も見せたことにしておく (出し方はライブのテストが見る) */
export async function compatOn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("canvas-video", "on");
    localStorage.setItem("canvas-drive-notice", "1");
  });
}

/** canvas に描いて、音もデコードできていること (数が進む)。**`<video>` は空** */
export async function expectDrawn(
  page: Page,
  input: "fmp4" | "ts-mpeg2",
): Promise<void> {
  const canvas = page.locator(
    `[data-testid="live-raw"][data-input="${input}"]`,
  );
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const count = async (name: "shown" | "audio") =>
    Number((await canvas.getAttribute(`data-${name}`)) ?? 0);
  await expect
    .poll(() => count("shown"), { timeout: 30_000 })
    .toBeGreaterThan(5);
  await expect
    .poll(() => count("audio"), { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(
    await page
      .getByTestId("watch-video")
      .evaluate((v) => (v as HTMLVideoElement).currentSrc),
  ).toBe("");
}

/** 操作バーの「m:ss / m:ss」の左 (いまの位置。秒) */
export async function where(page: Page): Promise<number> {
  const text = (await page.getByTestId("watch-clock").textContent()) ?? "";
  const parts = text.split(" / ")[0]!.trim().split(":").map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}
