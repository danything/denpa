import type { Page } from "@playwright/test";

import { expect, goto, test } from "./helpers";

/**
 * **ソフトウェアで描いている端末では、動き続けるものを止める** (docs/design.md の「動き」。`#lib/lite.ts`)。
 *
 * 開いたときに WebGL の描き手の名前を読み、ソフトウェアなら `<html data-lite>` を付ける。
 * 付いている間は、録画中の点・骨組みの光などを動きを減らす設定と同じ止まった姿にする (`app.css` の最後)。
 * 描き手の名前は端末で変わるので、WebGL の箱を差し替えて名前を決める。動きを見るので、動きを許して流す
 */
test.use({ reducedMotion: "no-preference" });

/** WebGL (1) の箱を、決めた名前を答える偽物に差し替える。映像の WebGL2 には触らない */
async function fakeRenderer(page: Page, name: string): Promise<void> {
  await page.addInitScript((renderer) => {
    const original = HTMLCanvasElement.prototype.getContext;
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind !== "webgl")
        return (original as (...args: unknown[]) => unknown).call(
          this,
          kind,
          ...rest,
        );
      return {
        RENDERER: 0x1f01,
        getExtension: (ext: string) =>
          ext === "WEBGL_debug_renderer_info"
            ? { UNMASKED_RENDERER_WEBGL }
            : ext === "WEBGL_lose_context"
              ? { loseContext: () => {} }
              : null,
        getParameter: () => renderer,
      };
    } as typeof HTMLCanvasElement.prototype.getContext;
  }, name);
}

/** 録画中の点と骨組みを置き、それぞれの動きの名前を読む */
function animations(page: Page) {
  return page.evaluate(() => {
    const dot = document.createElement("span");
    dot.className = "rec-dot";
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton";
    document.body.append(dot, skeleton);
    const result = {
      dot: getComputedStyle(dot).animationName,
      skeleton: getComputedStyle(skeleton, "::after").animationName,
    };
    dot.remove();
    skeleton.remove();
    return result;
  });
}

function lite(page: Page) {
  return page.evaluate(() => document.documentElement.dataset["lite"] ?? null);
}

test("ソフトウェアの描き手なら data-lite を付け、録画中の点と骨組みの光を止める", async ({
  page,
}) => {
  await fakeRenderer(
    page,
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
  );
  await goto(page, "/settings");
  await expect.poll(() => lite(page)).toBe("");
  expect(await animations(page)).toEqual({ dot: "none", skeleton: "none" });
});

test("GPU の描き手なら data-lite を付けず、回し続ける", async ({ page }) => {
  await fakeRenderer(
    page,
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  );
  await goto(page, "/settings");
  // 見分けは、goto が待つハイドレーションの印 (`data-hydrated`) を付ける `onMount` より先に済んでいる
  expect(await lite(page)).toBeNull();
  expect(await animations(page)).toEqual({
    dot: "rec-pulse",
    skeleton: "skeleton-sweep",
  });
});
