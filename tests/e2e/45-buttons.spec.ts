import type { Locator } from "@playwright/test";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * **ボタンと入力欄の見た目は `app.css` のトークン (`--dp-btn-*`・`--dp-field`) だけで決まる。** 画面ごとの上書きが
 * 戻ってきて形や大きさがばらつかないように、代表の画面で確かめる (docs/design.md の「地・件の面・操作の層」)。
 * 主は操作の層に乗せる (半透明の面と影のカプセル。主の色では塗らない)・浮いたものの中では浮かせない・
 * 控えは平ら (地も枠も影も無い)・形はカプセル・入力欄は線も凹みも無い平らな面・
 * 指で押す端末では小さいボタンも 40px 以上・アイコンのボタンは円
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
      borderWidth: style.borderBottomWidth,
      shadow: style.boxShadow,
      outline: style.outlineStyle,
    };
  });
}

/** `var(...)` の計算値を同じ画面で採る */
async function resolved(
  page: import("@playwright/test").Page,
  value: string,
): Promise<string> {
  return await page.evaluate((v) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = v;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, value);
}

test.describe("ボタンの見た目", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("主は操作の層に乗せ、控えは平ら。形はカプセル", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const primary = await resolved(page, "var(--pico-primary-background)");
    const tonal = await look(page.getByTestId("guide-genres"));
    expect(tonal.border).toBe("rgba(0, 0, 0, 0)");
    expect(tonal.background).toBe("rgba(0, 0, 0, 0)");
    expect(tonal.shadow).toBe("none");
    expect(tonal.radius).toBeGreaterThanOrEqual(tonal.height / 2 - 0.5);

    // 主のボタンの代表は検索の画面の「ルールとして保存」(広い画面の右の列。浮いたものの中ではない)
    await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
    const submit = await look(page.getByTestId("rule-submit"));
    expect(submit.background).not.toBe(primary);
    // 操作の層と同じ半透明の面 (`--dp-float`)
    expect(submit.background).toBe(await resolved(page, "var(--dp-float)"));
    expect(submit.background).toMatch(/^(rgba|color)\(/);
    expect(submit.shadow).not.toBe("none");
    expect(submit.radius).toBeGreaterThanOrEqual(submit.height / 2 - 0.5);
  });

  test("何行かある件は件の面に乗せ、中のボタンは浮かせない", async ({
    page,
  }) => {
    await goto(page, `/search?q=${encodeURIComponent("テスト")}`);
    const hit = page.locator(".hit").first();
    await expect(hit).toBeVisible();
    expect((await look(hit)).background).toBe(
      await resolved(page, "var(--dp-item)"),
    );
    for (const button of await hit.locator("button, a.button").all()) {
      expect((await look(button)).shadow).toBe("none");
    }
  });

  test("入力欄は線も凹みも無い平らな面。焦点は外側の線", async ({ page }) => {
    await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
    const input = page
      .getByTestId("rule-draft")
      .locator("input[type=text], input:not([type])")
      .first();
    const before = await look(input);
    expect(before.borderWidth).toBe("0px");
    expect(before.shadow).toBe("none");
    expect(before.background).toBe(await resolved(page, "var(--dp-field)"));
    await input.focus();
    expect((await look(input)).outline).toBe("solid");
  });

  test.describe("狭い画面", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("下から出す書く欄の中の主のボタンは浮かせない", async ({ page }) => {
      await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
      await page.getByTestId("rule-draft-open").click();
      const submit = await look(page.getByTestId("rule-submit"));
      expect(submit.shadow).toBe("none");
      expect(submit.background).toBe("rgba(0, 0, 0, 0)");
    });
  });

  test.describe("指で押す端末", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 1180, height: 820 },
    });

    test("小さいボタンも高さ 40px 以上、アイコンのボタンは円", async ({
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
      expect(toggle.radius).toBeGreaterThanOrEqual(toggle.height / 2 - 0.5);
    });
  });
});
