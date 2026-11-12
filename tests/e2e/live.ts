import type { Locator, Page } from "@playwright/test";

import { expect, pickCodec, wakeControls } from "./helpers";

/**
 * 2 つが寸分同じ枠にあること。**組み上がりを待つ。**
 *
 * 開いた直後は幅が決まりきっていないので、1 回だけ見比べると稀に外れる
 * (実際に flaky で落ちた)
 */
export async function sameBox(a: Locator, b: Locator): Promise<void> {
  await expect(async () => {
    expect(await a.boundingBox()).toEqual(await b.boundingBox());
  }).toPass({ timeout: 5_000 });
}

/** 画質の切り替えで MPEG-2 を選ぶ。操作バーは触らないと引っ込む (`ControlBar`) ので動かして出す */
export async function chooseRaw(page: Page): Promise<void> {
  await wakeControls(page, "live-frame");
  await pickCodec(page, "live", "mpeg2");
}
