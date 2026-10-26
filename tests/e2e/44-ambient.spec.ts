import type { Page } from "@playwright/test";

import {
  expect,
  flipSetting,
  goto,
  pickCodec,
  pretendGpu,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * アンビエントモード (`AmbientGlow.svelte`)。映像の色を枠の周りへぼかして広げる。
 *
 * 映像が本当に出るのは MPEG-2 のまま見るライブだけ (偽 ffmpeg のエンコードしたものには中身が無い。
 * `28-live-raw`) なので、ここで見る。写した回数 (`data-updates`) が進むか・止まるかを見る —
 * 光の色そのものは、GPU の無いヘッドレスでも同じに出るが、比べる意味が薄い
 */

/** 画質の切り替えで MPEG-2 を選ぶ (`28-live-raw` と同じ) */
async function watchRaw(page: Page): Promise<void> {
  await goto(page, "/live");
  await page.getByTestId("live-channel").first().click();
  await expect(page.getByTestId("live-title")).toBeVisible();
  await wakeControls(page, "live-frame");
  await pickCodec(page, "live", "mpeg2");
  await expect
    .poll(
      async () =>
        Number(
          (await page.getByTestId("live-raw").getAttribute("data-shown")) ?? 0,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(10);
}

/** 写した回数 */
function updates(page: Page): () => Promise<number> {
  return async () =>
    Number(
      (await page
        .getByTestId("live-frame-ambient")
        .getAttribute("data-updates")) ?? 0,
    );
}

/**
 * 出ている帯の1つにある2枚の canvas (表と裏)。入れ替えの動きは CSS の `opacity` の transition で、
 * JS が動かすのは表の印 (`data-front`) だけ
 */
function faces(page: Page) {
  return page
    .getByTestId("live-frame-ambient")
    .locator(".band:not([hidden])")
    .first()
    .evaluate((band) =>
      [...band.querySelectorAll("canvas")].map((canvas) => {
        const style = getComputedStyle(canvas);
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return {
          front: canvas.hasAttribute("data-front"),
          opacity: style.opacity,
          transition: `${style.transitionProperty} ${style.transitionDuration}`,
          blend: style.mixBlendMode,
          painted: pixels.some((v, i) => i % 4 === 3 && v > 0),
        };
      }),
    );
}

/** 操作バーのボタンを押す (畳まれないもの) */
async function press(page: Page, testid: string): Promise<void> {
  await wakeControls(page, "live-frame");
  await page.getByTestId(testid).click();
}

test.describe("アンビエントモード", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test.describe("動かしてよい端末", () => {
    test.use({ reducedMotion: "no-preference" });
    test.beforeEach(async ({ page }) => {
      await pretendGpu(page);
    });

    test("既定はオンで、映像の色を写し続ける。止めたら写さず、オフにしたら消えて覚えている", async ({
      page,
    }) => {
      await watchRaw(page);
      const glow = page.getByTestId("live-frame-ambient");
      await expect(glow).toBeVisible();
      await expect(glow).toHaveAttribute("data-plan", "watch");
      // 1秒に5回まで。数秒で何回も進む
      await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(5);
      const before = await updates(page)();
      await expect
        .poll(updates(page), { timeout: 10_000 })
        .toBeGreaterThan(before + 5);
      // 右の列は地の色を外し (区切りの線はもともと無い)、窓全体に敷いた色の上に載る。
      // 見出しは平らなまま (観る画面は窓が巻けないので、裏に中身が来ず浮かない)。色は見出しの裏までそのまま届く
      await expect(page.locator("html")).toHaveAttribute("data-ambient", "");
      const aside = await page
        .locator("[data-player-side] > aside")
        .evaluate((el) => ({
          position: getComputedStyle(el).position,
          image: getComputedStyle(el).backgroundImage,
        }));
      expect(aside).toEqual({ position: "relative", image: "none" });
      const surfaces = await page.evaluate(() => {
        const style = (selector: string) =>
          getComputedStyle(document.querySelector(selector)!);
        const aside = style("[data-player-side] > aside");
        const header = style(".navbar");
        return [
          aside.backgroundColor,
          aside.borderLeftWidth,
          header.backgroundColor,
          header.borderBottomWidth,
        ];
      });
      expect(surfaces).toEqual([
        "rgba(0, 0, 0, 0)",
        "0px",
        "rgba(0, 0, 0, 0)",
        "0px",
      ]);
      // 色は見出しの所 (窓の上の端) まで敷く
      expect((await glow.boundingBox())!.y).toBeLessThanOrEqual(0);
      // 光は枠の外 (帯) にだけ描く。枠に重なる帯は無い
      const stage = (await page.getByTestId("live-frame").boundingBox())!;
      for (const band of await glow.locator(".band:not([hidden])").all()) {
        const box = (await band.boundingBox())!;
        const overlaps =
          box.x < stage.x + stage.width - 1 &&
          box.x + box.width > stage.x + 1 &&
          box.y < stage.y + stage.height - 1 &&
          box.y + box.height > stage.y + 1;
        expect(overlaps, JSON.stringify({ box, stage })).toBe(false);
      }

      // 入れ替えの途中も、2枚の透明度を足すといつも 1 (前の色から次の色へ、抜けも跳ねも無くつながる)
      for (let i = 0; i < 10; i++) {
        const sum = (await faces(page)).reduce(
          (total, face) => total + Number(face.opacity),
          0,
        );
        expect(sum).toBeCloseTo(1, 1);
        await page.waitForTimeout(37);
      }

      // 止めている間は写さない (光は残す)
      await press(page, "live-play");
      await expect(glow).toHaveAttribute("data-plan", "hold");
      const paused = await updates(page)();
      await page.waitForTimeout(1500);
      expect(await updates(page)()).toBe(paused);
      await expect(glow).toBeVisible();
      // 入れ替えは CSS の transition (120ms) で、2枚は足して重ねる。止まったら表の1枚だけが出ていて、色が描いてある
      const settled = await faces(page);
      expect(settled.map((face) => face.transition)).toEqual([
        "opacity 0.12s",
        "opacity 0.12s",
      ]);
      expect(settled.map((face) => face.blend)).toEqual([
        "plus-lighter",
        "plus-lighter",
      ]);
      expect(settled.filter((face) => face.front)).toHaveLength(1);
      for (const face of settled)
        expect(face.opacity).toBe(face.front ? "1" : "0");
      expect(settled.find((face) => face.front)!.painted).toBe(true);
      await press(page, "live-play");
      await expect(glow).toHaveAttribute("data-plan", "watch");

      // オフにすると消える。端末に覚えるので、開き直してもオフのまま
      await wakeControls(page, "live-frame");
      await flipSetting(page, "live", "ambient");
      await expect(glow).toHaveAttribute("data-plan", "off");
      await expect(glow).toBeHidden();
      await expect(page.locator("html")).not.toHaveAttribute("data-ambient");
      await page.reload();
      await expect(page.getByTestId("live-frame-ambient")).toHaveAttribute(
        "data-plan",
        "off",
      );
      expect(
        await page.evaluate(() => localStorage.getItem("player-ambient")),
      ).toBe("0");
    });

    test("縦に積むと、映像の下の番組の中身に色を敷く", async ({ page }) => {
      // 選局と MPEG-2 の切り替えは広い画面で済ませ、それから縦に積む幅へ
      await watchRaw(page);
      await page.setViewportSize({ width: 390, height: 844 });
      const glow = page.getByTestId("live-frame-ambient");
      await expect(glow).toHaveAttribute("data-plan", "watch");
      await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(2);
      const stage = (await page.getByTestId("live-frame").boundingBox())!;
      const below = [];
      for (const band of await glow.locator(".band:not([hidden])").all()) {
        const box = (await band.boundingBox())!;
        if (box.y >= stage.y + (stage.width * 9) / 16 - 1) below.push(box);
      }
      // 枠はちょうど映像の形 (16:9)。色は映像の下の端から、画面の幅いっぱい・240px 以上
      expect(Math.round(stage.height)).toBe(Math.round((stage.width * 9) / 16));
      expect(
        Math.abs((below[0]?.y ?? 0) - (stage.y + stage.height)),
      ).toBeLessThan(2);
      expect(below).toHaveLength(1);
      expect(below[0]!.width).toBeGreaterThanOrEqual(389);
      expect(below[0]!.height).toBeGreaterThanOrEqual(240);
    });

    test("明るいテーマでも出し、帯は地に掛ける (multiply)", async ({
      page,
    }) => {
      await page.addInitScript(() => localStorage.setItem("theme", "light"));
      await watchRaw(page);
      const glow = page.getByTestId("live-frame-ambient");
      await expect(glow).toHaveAttribute("data-plan", "watch");
      await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(3);
      const blend = await glow
        .locator(".band:not([hidden])")
        .first()
        .evaluate((el) => getComputedStyle(el).mixBlendMode);
      expect(blend).toBe("multiply");
    });
  });

  // E2E の既定は動かさない設定 (`playwright.config.ts` の `reducedMotion: 'reduce'`)
  test("動かさない設定の端末では、1枚だけ写して止める", async ({ page }) => {
    await watchRaw(page);
    const glow = page.getByTestId("live-frame-ambient");
    await expect(glow).toHaveAttribute("data-plan", "hold");
    await expect(glow).toHaveAttribute("data-updates", "1");
    await page.waitForTimeout(1500);
    await expect(glow).toHaveAttribute("data-updates", "1");
    // 入れ替えの長さは 0 (トークンが 0 になる)。写した1枚がその場で表に出ている
    const shown = await faces(page);
    expect(shown.map((face) => face.transition)).toEqual([
      "opacity 0s",
      "opacity 0s",
    ]);
    const front = shown.find((face) => face.front)!;
    expect(front.opacity).toBe("1");
    expect(front.painted).toBe(true);
  });

  test.describe("ソフトウェアで描いている端末", () => {
    test.use({ reducedMotion: "no-preference" });

    // E2E のブラウザは GPU を切っていて `<html data-lite>` が付く。動かさない設定と同じに、1 秒に 5 回は描き直さない
    test("動かしてよい設定でも、1枚だけ写して止める", async ({ page }) => {
      await watchRaw(page);
      await expect(page.locator("html")).toHaveAttribute("data-lite", "");
      const glow = page.getByTestId("live-frame-ambient");
      await expect(glow).toHaveAttribute("data-plan", "hold");
      await expect(glow).toHaveAttribute("data-updates", "1");
      await page.waitForTimeout(1500);
      await expect(glow).toHaveAttribute("data-updates", "1");
    });
  });

  /*
   * **ブラウザの枠の色 (theme-color) は、色を敷いている間だけその色** (ページの上の端の色。`washTop`)。
   * オフにした・画面を離れたらテーマの地 (#0b0c0f) に戻す
   */
  test("色を敷いている間はブラウザの枠の色も合わせ、消したら・離れたら地の色に戻す", async ({
    page,
  }) => {
    const toolbar = page.locator('meta[name="theme-color"]');
    await watchRaw(page);
    const glow = page.getByTestId("live-frame-ambient");
    await expect(glow).toHaveAttribute("data-updates", "1");
    await expect(toolbar).toHaveAttribute("content", /^#[0-9a-f]{6}$/);
    await expect(toolbar).not.toHaveAttribute("content", "#0b0c0f");

    await wakeControls(page, "live-frame");
    await flipSetting(page, "live", "ambient");
    await expect(glow).toHaveAttribute("data-plan", "off");
    await expect(toolbar).toHaveAttribute("content", "#0b0c0f");

    await wakeControls(page, "live-frame");
    await flipSetting(page, "live", "ambient");
    await expect(toolbar).not.toHaveAttribute("content", "#0b0c0f");
    // 画面を離れる (ページは読み直さない)
    await page.getByTestId("nav-guide").click();
    await page.waitForURL(/guide/);
    await expect(toolbar).toHaveAttribute("content", "#0b0c0f");
  });
});
