import { rmSync } from "node:fs";

import { expect, syncEpg, test } from "./helpers";
import { result, watch } from "./live-pacing";

/**
 * **たまに長く空く経路** (#1210。`src/lib/ts/pacing.ts` の `cover`)。見方は `live-pacing.ts`。
 * 実時間で 2 分かかるので、`50-live-pacing` とは CI の別の組で流す
 */
test.describe("ライブの貯め方 (長く空く経路)", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });
  test.afterEach(async ({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });

  /*
   * **たまに長く空く経路** (#1210)。15〜30 秒おきに 0.5〜0.9 秒空くと、止まるたびに 0.3 秒ずつ
   * 上げていた頃は 2 分半で 8 回止まった。空いた間隔を覚えて覆うので、止まっても最初の 1 回まで
   */
  test("20秒ほどおきに 0.7 秒空いても、止まるのは1回まで", async ({
    page,
    stack,
  }) => {
    test.setTimeout(210_000);
    await watch(
      page,
      JSON.stringify({ gapEvery: [18, 22], gapMs: [700, 700] }),
      stack,
    );
    await page.waitForTimeout(120_000);
    const watched = await result(page, "gaps");
    expect(watched.stalls).toBeLessThanOrEqual(1);
    // 画面に出す数で、届き方のせいだと分かる
    expect(watched.gap).toBeGreaterThanOrEqual(0.6);
  });
});
