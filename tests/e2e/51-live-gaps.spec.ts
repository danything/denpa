import { rmSync } from "node:fs";

import { expect, syncEpg, test } from "./helpers";
import { result, watch } from "./live-pacing";

/**
 * **たまに長く空く経路** (#1210。`src/lib/ts/pacing.ts` の `cover`)。見方は `live-pacing.ts`。
 * 実時間で 1 分かかるので、`50-live-pacing` とは CI の別の組で流す
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
   * 上げていた頃は 2 分半で 8 回止まった。空いた間隔を覚えて覆うので、止まっても最初の 1 回まで。
   *
   * **空きは 3 回、21〜22 秒おき。** 覚えていないと、空きと空きの間に貯める量を縮め
   * (`pacing.ts` の `SETTLED` の 15 秒無事なら縮める。決め直すのは 5 秒ごと)、2 回目と 3 回目の空きでも止まる。
   * 間隔を 20 秒より短くすると、縮める前に次の空きが来て、覚えていなくても止まらないことがある。
   * 1 回目は流し始めて 8 秒 (`gapFirst`)。3 回目の空きが終わるのは流し始めて 52.1〜54.1 秒で、`watch` が戻るのは流し始めて
   * 3.7 秒より後 (0.2 秒貯めて 0.5 秒進み、3 秒置く) なので、そこから 52 秒待てば 3 回とも通る
   */
  test("20 秒ほどおきに 0.7 秒空いても、止まるのは 1 回まで", async ({
    page,
    stack,
  }) => {
    test.setTimeout(120_000);
    await watch(
      page,
      JSON.stringify({ gapFirst: 8, gapEvery: [21, 22], gapMs: [700, 700] }),
      stack,
    );
    await page.waitForTimeout(52_000);
    const watched = await result(page, "gaps");
    expect(watched.stalls).toBeLessThanOrEqual(1);
    // 画面に出す数で、届き方のせいだと分かる
    expect(watched.gap).toBeGreaterThanOrEqual(0.6);
  });
});
