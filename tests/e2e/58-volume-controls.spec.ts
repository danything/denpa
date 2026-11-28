import type { Page } from "@playwright/test";

import {
  expect,
  goto,
  openSettings,
  recordOne,
  test,
  wakeControls,
} from "./helpers";

/**
 * **音のボタンと音量のつまみの出し方と操作** (`src/lib/components/player/volume.svelte.ts`・`SoundButton`)。
 * 鳴っている音を測るものは `58-volume`
 */

/** 舞台の testid。操作バーを出すときに動かす所 */
const STAGE = { live: "live-frame", chase: "chase", watch: "watch-stage" };

/**
 * **音のボタンに乗せると縦のつまみが浮かぶ** (`SoundButton`)。マウスで指せる端末だけ。
 * 指の端末 (車のタブレットなど) と、畳んで音のボタンごと ⚙ に入ったときは ⚙ のつまみを使う (つまみは画面に 1 つだけ)
 */
test.describe("音のボタンの縦のつまみ", () => {
  test("乗せると真上に出て、縦に動かす・ホイールで変わり、⚙ には置かない。外れたら閉じ、キーボードでも開く", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const button = page.getByTestId("live-sound");
    const pop = page.getByTestId("live-sound-pop");
    const slider = page.getByTestId("live-sound-volume");

    await wakeControls(page, STAGE.live);
    await expect(pop).toBeHidden();
    await button.hover();
    await expect(pop).toBeVisible();
    // ボタンの真上に、縦長で
    const at = (await button.boundingBox())!;
    const box = (await slider.boundingBox())!;
    expect(box.height).toBeGreaterThan(box.width);
    expect(box.y + box.height).toBeLessThanOrEqual(at.y + 1);
    expect(
      Math.abs(box.x + box.width / 2 - (at.x + at.width / 2)),
    ).toBeLessThan(2);
    await expect(slider).toHaveValue("100");

    // 下の端までつまんで下ろすと 0%、半ばまで上げると 50% 前後
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height + 20, { steps: 5 });
    await expect(slider).toHaveValue("0");
    await page.mouse.move(x, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const half = Number(await slider.inputValue());
    expect(half).toBeGreaterThanOrEqual(40);
    expect(half).toBeLessThanOrEqual(60);
    await expect(pop).toContainText(`${half}%`);

    // ホイールで 1 刻み (上へ回すと大きく)
    await page.mouse.wheel(0, -100);
    await expect(slider).toHaveValue(String(half + 5));
    await page.mouse.wheel(0, 100);
    await page.mouse.wheel(0, 100);
    await expect(slider).toHaveValue(String(half - 5));

    // 押すと今までどおり消音の切り替え (開いたまま)
    // (自動再生を断られて消えていることもあるので、名前が替わって戻るかで見る)
    const name = (await button.getAttribute("aria-label"))!;
    await button.click();
    await expect(button).not.toHaveAccessibleName(name);
    await expect(pop).toBeVisible();
    await button.click();
    await expect(button).toHaveAccessibleName(name);

    // 外れたら少し待ってから閉じる
    const stage = (await page.getByTestId(STAGE.live).boundingBox())!;
    await page.mouse.move(stage.x + stage.width / 2, stage.y + 20);
    await expect(pop).toBeVisible();
    await expect(pop).toBeHidden();

    // つまみは画面に 1 つだけ。マウスの端末の広い枠では ⚙ に音量のつまみを置かない
    await openSettings(page, "live");
    await expect(page.getByTestId("live-settings-menu")).toBeVisible();
    await expect(page.getByTestId("live-volume")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("live-settings-menu")).toBeHidden();

    // キーボードでボタンに来ても開き、つまみは ↑↓ で動く
    await wakeControls(page, STAGE.live);
    await page.getByTestId("live-play").focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(pop).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(slider).toHaveValue(String(half));
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
  });

  /*
   * **つまみが遅れて閉じても、開いている ⚙ のぶんは操作バーを残す** (`controls.svelte.ts` の `holdOpen`)。
   * 開いているかを真偽 1 つで持っていた頃は、つまみが外れて 0.4 秒後に閉じたときに ⚙ のぶんまで下ろし、
   * ⚙ を開いたまま操作バーが引っ込んでいた
   */
  test("つまみを出したまま ⚙ を開いても、⚙ を開いている間は操作バーが残る", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const bar = page.getByTestId("live-controls");
    const pop = page.getByTestId("live-sound-pop");

    await wakeControls(page, STAGE.live);
    await page.getByTestId("live-sound").hover();
    await expect(pop).toBeVisible();
    // つまみが閉じる前に ⚙ を開く
    await page.getByTestId("live-settings").click();
    const menu = page.getByTestId("live-settings-menu");
    await expect(menu).toBeVisible();
    await expect(pop).toBeHidden();
    // 触らずに操作バーの時計 (2.5 秒) より長く待っても、⚙ を開いている間は残る
    await page.waitForTimeout(3500);
    await expect(menu).toBeVisible();
    await expect(bar).toHaveAttribute("data-shown", "true");
  });
});

test.describe("指の端末の音のボタン", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1280, height: 800 },
  });

  test("押しても縦のつまみは出ず、消音を切り替えるだけ", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(false);

    const bar = page.getByTestId("live-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      const stage = (await page.getByTestId(STAGE.live).boundingBox())!;
      await page.touchscreen.tap(
        stage.x + stage.width / 2,
        stage.y + stage.height / 2,
      );
    }
    await expect(bar).toHaveAttribute("data-shown", "true");
    const button = page.getByTestId("live-sound");
    const name = await button.getAttribute("aria-label");
    await button.tap();
    await expect(button).not.toHaveAccessibleName(name!);
    await expect(page.getByTestId("live-sound-pop")).toBeHidden();

    // 代わりに ⚙ の先頭に音量のつまみ。← → で動かし、↓ はほかの行と同じく次の行へ (音量は変えない)
    const gear = page.getByTestId("live-settings");
    await gear.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("live-settings-menu")).toBeVisible();
    const volume = page.getByTestId("live-volume");
    await expect(volume).toBeFocused();
    await expect(volume).toHaveValue("100");
    await page.keyboard.press("ArrowLeft");
    await expect(volume).toHaveValue("95");
    await page.keyboard.press("ArrowRight");
    await expect(volume).toHaveValue("100");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("live-ambient")).toBeFocused();
    await expect(volume).toHaveValue("100");
    // つまみは行の幅いっぱいの横のカプセルで、高さ 44px (ほかの行と同じ幅)
    const slider = (await volume.boundingBox())!;
    const row = (await page.getByTestId("live-ambient").boundingBox())!;
    expect(Math.abs(slider.width - row.width)).toBeLessThan(2);
    expect(slider.height).toBeGreaterThanOrEqual(43.5);

    // 値は変えている間だけ出て、止めて少し経つと消える。読み上げにはいつも渡す
    const value = page
      .getByTestId("live-settings-menu")
      .locator(".volume-slider .value");
    await volume.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(value).toHaveText("95%");
    await expect(value).toHaveCSS("opacity", "1");
    await expect(value).toHaveCSS("opacity", "0");
    await expect(volume).toHaveAttribute("aria-valuetext", "95%");

    // 押した所へ飛ぶ (指でも。左の端は 0%、右の端は 100%)
    await page.touchscreen.tap(slider.x + 2, slider.y + slider.height / 2);
    await expect(volume).toHaveValue("0");
    await page.touchscreen.tap(
      slider.x + slider.width - 2,
      slider.y + slider.height / 2,
    );
    await expect(volume).toHaveValue("100");
  });
});

/** マウスの端末でも、畳んで音のボタンごと ⚙ に入ったら (狭い枠) ⚙ につまみを置く */
test.describe("畳んだ枠の音量", () => {
  test.use({ viewport: { width: 400, height: 800 } });

  test("音のボタンは ⚙ の「消音」の行になり、音量のつまみも ⚙ に出る", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(true);
    await expect(page.getByTestId(STAGE.live)).toHaveAttribute("data-fold", "");

    await wakeControls(page, STAGE.live);
    await expect(page.getByTestId("live-sound")).toBeHidden();
    await openSettings(page, "live");
    await expect(page.getByTestId("live-mute")).toBeVisible();
    const volume = page.getByTestId("live-volume");
    await expect(volume).toBeVisible();
    await volume.fill("40");
    await expect(page.getByTestId("live-settings-menu")).toContainText("40%");
  });
});

/**
 * **⚙ の開け閉めは `toggle` を待たない** (`Menu.svelte`)。`toggle` は後のタスクで届くので、重い CI では開いてから
 * 届くまでに押した Esc が効かず、閉じてから届くまでに動かしたフォーカスを遅れて引き金へ戻していた (閉じた直後の
 * ↑↓ が引き金に当たってメニューを開き直す)。ここでは popover の `toggle` を止めておき、届く前に操作してから届ける
 */
test.describe("⚙ の開け閉めと遅れて届く toggle", () => {
  test("届く前の Esc で閉じ、閉じた後に動かしたフォーカスを奪わない", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // 止めている popover と、止めた間のもとの状態 (oldState)。届けるときは 1 回にまとめる (ブラウザと同じ)
      const held = new Map<HTMLElement, string>();
      (globalThis as { __release?: () => void }).__release = () => {
        for (const [target, oldState] of held) {
          const newState = target.matches(":popover-open") ? "open" : "closed";
          target.dispatchEvent(
            new ToggleEvent("toggle", { oldState, newState }),
          );
        }
        held.clear();
      };
      window.addEventListener(
        "toggle",
        (event) => {
          const target = event.target;
          if (
            !event.isTrusted ||
            !(target instanceof HTMLElement) ||
            !target.hasAttribute("popover")
          )
            return;
          event.stopImmediatePropagation();
          if (!held.has(target))
            held.set(target, (event as ToggleEvent).oldState);
        },
        true,
      );
    });
    const release = () =>
      page.evaluate(() =>
        (globalThis as unknown as { __release: () => void }).__release(),
      );
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const menu = page.getByTestId("live-settings-menu");
    const trigger = page.getByTestId("live-settings");

    // 開いて、toggle が届く前の Esc
    await wakeControls(page, STAGE.live);
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await release();
    await expect(menu).toBeHidden();

    // 中にフォーカスがある間に閉じると、その場で引き金へ戻る。そこから動かしたフォーカスは、
    // 後から届いた toggle に奪われない
    await wakeControls(page, STAGE.live);
    await trigger.click();
    await expect(menu).toBeVisible();
    await release();
    await page.getByTestId("live-ambient").focus();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await release();
    await expect(trigger).not.toBeFocused();
    await expect(menu).toBeHidden();
  });
});

/**
 * **`<video>` の音量を変えられない端末 (iPhone・iPad) では、3 画面とも音量のつまみを出さない** (`volume.svelte.ts` の `fixed`)。
 * 本体の音量ボタンに任せる。見分けるのは `volume` に 0.5 を入れて読み返す所 (`native-audio-choice.ts` の `volumeFixed`) なので、
 * `volume` を入れても 1 のままにして iOS の WebKit と同じにする。指の端末なので、ふつうは ⚙ につまみが出る
 */
test.describe("音量を変えられない端末", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1280, height: 800 },
  });

  /** `volume` を入れても 1 のままにする (iOS と同じ) */
  async function fixVolume(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "volume", {
        configurable: true,
        get: () => 1,
        set() {
          // iOS と同じく、入れても変わらない
        },
      });
    });
  }

  /** 音のボタンと ⚙ につまみが無く、↑↓ も効かない。消音のボタンは残る */
  async function expectNoVolume(
    page: Page,
    prefix: "live" | "watch",
  ): Promise<void> {
    const bar = page.getByTestId(`${prefix}-controls`);
    const stage = page.getByTestId(STAGE[prefix]);
    await expect(stage).toBeVisible();
    if ((await bar.getAttribute("data-shown")) !== "true") {
      const box = (await stage.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");

    // 消音のボタンは残り、押すと切り替わる。浮かぶつまみは置かない
    const button = page.getByTestId(`${prefix}-sound`);
    const name = (await button.getAttribute("aria-label"))!;
    await button.tap();
    await expect(button).not.toHaveAccessibleName(name);
    await expect(page.getByTestId(`${prefix}-sound-pop`)).toHaveCount(0);

    // 指の端末でも ⚙ につまみを置かない
    const gear = page.getByTestId(`${prefix}-settings`);
    await gear.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(`${prefix}-settings-menu`)).toBeVisible();
    await expect(page.getByTestId(`${prefix}-volume`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`${prefix}-settings-menu`)).toBeHidden();

    // ↑↓ で音量を変えない (今の音量も出さない)
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowDown");
    // 出るなら押してすぐ出る (`VolumeNote`)。少し待ってから無いことを見る
    await page.waitForTimeout(500);
    await expect(page.getByTestId(`${prefix}-volume-note`)).toHaveCount(0);
  }

  test("観る画面に音量のつまみを出さず、↑↓ も効かない。消音のボタンは残る", async ({
    page,
    request,
  }) => {
    await fixVolume(page);
    const { id } = await recordOne(page, request);
    await goto(page, `/watch/${id}`);
    await expectNoVolume(page, "watch");
  });

  test("ライブも音量のつまみを出さず、↑↓ も効かない。消音のボタンは残る", async ({
    page,
  }) => {
    await fixVolume(page);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expectNoVolume(page, "live");
  });
});
