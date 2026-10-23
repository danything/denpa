import type { Locator } from "@playwright/test";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * **ボタンの見た目は `app.css` のトークン (`--dp-btn-*`) だけで決まる。** 画面ごとの上書きが
 * 戻ってきて形や大きさがばらつかないように、代表の画面で確かめる。
 * 主は浮かせる (面と影。主の色では塗らない)・控えは平ら (地も枠も影も無い)・角は行やメニューと同じ丸み (`--dp-radius`)・
 * 指で押す端末では小さいボタンも 40px 以上・アイコンのボタンは角の丸い正方形
 */
async function look(button: Locator) {
  return await button.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      radius: Number.parseFloat(style.borderTopLeftRadius),
      background: style.backgroundColor,
      border: style.borderTopColor,
      shadow: style.boxShadow,
    };
  });
}

test.describe("ボタンの見た目", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("主は浮かせ、控えは平ら。角は行と同じ丸み", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    // 主の色 (azure) で塗っていない。主の色の計算値を同じ画面で採って比べる
    const primary = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--pico-primary-background)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    // 角の丸み (`--dp-radius`) の計算値
    const radius = await page.evaluate(
      () =>
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--dp-radius",
          ),
        ) *
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const tonal = await look(page.getByTestId("guide-genres"));
    expect(tonal.border).toBe("rgba(0, 0, 0, 0)");
    expect(tonal.background).toBe("rgba(0, 0, 0, 0)");
    expect(tonal.shadow).toBe("none");
    expect(tonal.radius).toBeCloseTo(radius, 0);

    // 主のボタンの代表は検索の画面の「ルールとして保存」
    await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
    const submit = await look(page.getByTestId("rule-submit"));
    expect(submit.background).not.toBe(primary);
    expect(submit.shadow).not.toBe("none");
  });

  test.describe("指で押す端末", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 1180, height: 820 },
    });

    test("小さいボタンも高さ 40px 以上、アイコンのボタンは正方形", async ({
      page,
    }) => {
      await goto(page, "/guide?type=GR");
      for (const id of [
        "guide-day",
        "guide-jump-6",
        "guide-genres",
        "type-GR",
        "type-BS",
      ]) {
        expect(
          (await look(page.getByTestId(id).first())).height,
          id,
        ).toBeGreaterThanOrEqual(40);
      }
      const toggle = await look(page.getByTestId("theme-toggle"));
      expect(toggle.height).toBeGreaterThanOrEqual(40);
      expect(Math.abs(toggle.width - toggle.height)).toBeLessThan(1);
      expect(toggle.radius).toBeLessThan(toggle.height / 2);
    });
  });
});
