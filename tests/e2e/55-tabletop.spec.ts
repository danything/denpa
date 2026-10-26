import type { CDPSession, Page } from "@playwright/test";

import {
  expect,
  goto,
  pickCodec,
  pretendGpu,
  recordOne,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **折り畳み端末のテーブルトップ** (半分に折って机に置いた形。`PlayerLayout` の `TABLETOP`)。
 * 映像を上の段、右の列 (局の一覧・番組の中身) を下の段に置き、下の段の黒い地に映像の色の反射 (`FoldReflection`) を敷く。
 *
 * 折り畳み端末は CDP で真似る: 折った形は `Emulation.setDevicePostureOverride`、折り目は
 * `Emulation.setDeviceMetricsOverride` の `displayFeature` (`setDisplayFeaturesOverride` だけでは段が分かれない)。
 * Playwright の `setViewportSize` は画面の大きさの上書きを掛け直して折り目を消すので使わない。
 * 位置はページの中で `getBoundingClientRect` で読む
 */

/** Galaxy Z Fold 系を開いて横に持った大きさ (CSS px)。折り目は真ん中で、蝶番の隙間は無い */
const SIZE = { width: 1104, height: 882 };
const FOLD = SIZE.height / 2;

type Posture = "flat" | "tabletop" | "book";

async function fold(cdp: CDPSession, posture: Posture): Promise<void> {
  const metrics = { ...SIZE, deviceScaleFactor: 1, mobile: false };
  if (posture === "flat") {
    await cdp.send("Emulation.clearDevicePostureOverride");
    await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
    return;
  }
  await cdp.send("Emulation.setDevicePostureOverride", {
    posture: { type: "folded" },
  });
  // 本の形は縦の折り目 (左右 2 段)。テーブルトップの形には当てない
  const displayFeature =
    posture === "tabletop"
      ? { orientation: "horizontal" as const, offset: FOLD, maskLength: 0 }
      : {
          orientation: "vertical" as const,
          offset: SIZE.width / 2,
          maskLength: 0,
        };
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...metrics,
    displayFeature,
  });
}

/** 折り目を変えた直後の見た目がそろうまで、確かめ直す */
async function settled(check: () => Promise<void>): Promise<void> {
  await expect(check).toPass({ timeout: 5_000, intervals: [100] });
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 映像の枠・右の列・反射の箱 (無ければ null) */
function boxes(page: Page, stage: string) {
  return page.evaluate((stage) => {
    const rect = (selector: string): Box | null => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const { top, bottom, left, right } = el.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      stage: rect(`[data-testid="${stage}"]`)!,
      aside: rect("[data-player-side] > aside")!,
      reflection: rect(`[data-testid="${stage}-reflection"]`),
      header: rect(".navbar"),
      tabletop: matchMedia(
        "(device-posture: folded) and (vertical-viewport-segments: 2)",
      ).matches,
      theme:
        document
          .querySelector("[data-player-side]")!
          .getAttribute("data-theme") ?? null,
      scrolls:
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight,
    };
  }, stage);
}

/**
 * 今の二段組 (映像が左、右の列が右)。反射は無い。
 * 折り目が変わった直後は CSS がすぐ替わり、反射の出し入れは `change` を受けた次の描画になるので、そろうまで待つ (`settled`)
 */
async function expectSideBySide(page: Page, stage: string): Promise<void> {
  await settled(async () => {
    const now = await boxes(page, stage);
    expect(now.tabletop).toBe(false);
    expect(now.reflection).toBeNull();
    expect(now.theme).toBeNull();
    expect(now.aside.left).toBeGreaterThanOrEqual(now.stage.right - 1);
    expect(now.aside.right).toBeCloseTo(SIZE.width, 0);
  });
}

/** テーブルトップ: 映像の枠は上の段、右の列は下の段。どちらも折り目をまたがない */
async function expectTabletop(page: Page, stage: string): Promise<void> {
  await settled(async () => {
    const now = await boxes(page, stage);
    expect(now.tabletop).toBe(true);
    // 映像はヘッダーの下から折り目まで
    expect(now.stage.top).toBeGreaterThanOrEqual(now.header?.bottom ?? 0);
    expect(now.stage.bottom).toBeLessThanOrEqual(FOLD);
    // 上の段で映像を小さくしすぎない (段の高さの 3 分の 2 以上)
    expect(now.stage.bottom - now.stage.top).toBeGreaterThan((FOLD * 2) / 3);
    // 右の列は折り目の下から画面の下の端まで、幅いっぱい
    expect(now.aside.top).toBeGreaterThanOrEqual(FOLD);
    expect(now.aside.bottom).toBeLessThanOrEqual(SIZE.height);
    expect(now.aside.left).toBeCloseTo(0, 0);
    expect(now.aside.right).toBeCloseTo(SIZE.width, 0);
    // 下の段は舞台の中なので、右の列はテーマにかかわらず暗いテーマの色。窓は巻かない
    expect(now.theme).toBe("dark");
    expect(now.scrolls).toBe(false);
  });
}

/** 反射の箱は下の段いっぱい */
async function expectReflection(page: Page, stage: string): Promise<void> {
  await settled(async () => {
    const now = await boxes(page, stage);
    expect(now.reflection).not.toBeNull();
    expect(now.reflection!.top).toBeCloseTo(FOLD, 0);
    expect(now.reflection!.bottom).toBeCloseTo(SIZE.height, 0);
    expect(now.reflection!.left).toBeCloseTo(0, 0);
    expect(now.reflection!.right).toBeCloseTo(SIZE.width, 0);
  });
}

/** 写した回数 */
function updates(page: Page): () => Promise<number> {
  return async () =>
    Number(
      (await page
        .getByTestId("live-frame-reflection")
        .getAttribute("data-updates")) ?? 0,
    );
}

/** 表の1枚に色が描いてあるか */
function painted(page: Page) {
  return page
    .getByTestId("live-frame-reflection")
    .locator("canvas[data-front]")
    .evaluate((canvas: HTMLCanvasElement) =>
      canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((v, i) => i % 4 === 3 && v > 0),
    );
}

/** 局を選んで MPEG-2 のまま観る (映像が本当に出るのはこれだけ。`44-ambient` と同じ) */
async function watchRaw(page: Page): Promise<void> {
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
      { timeout: 30_000 },
    )
    .toBeGreaterThan(10);
}

test.describe("テーブルトップ", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("ライブ: 映像を上の段、局の一覧を下の段に置き、下の段に反射を敷く。開くと元に戻る", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await goto(page, "/live");
    const cdp = await page.context().newCDPSession(page);

    // 平らなうちは今の二段組 (アンビエントの光)
    await fold(cdp, "flat");
    await expectSideBySide(page, "live-frame");
    await expect(page.getByTestId("live-frame-ambient")).toBeAttached();

    await fold(cdp, "tabletop");
    await expect(page.getByTestId("live-frame-reflection")).toBeAttached();
    await expectTabletop(page, "live-frame");
    await expectReflection(page, "live-frame");
    // 光の代わりに反射。光は置かない
    await expect(page.getByTestId("live-frame-ambient")).not.toBeAttached();
    // 局の一覧は今のまま、列の中で巻く
    const list = await page.locator(".channels").evaluate((el) => ({
      overflow: getComputedStyle(el).overflowY,
      inside: el.getBoundingClientRect().bottom <= window.innerHeight + 0.5,
    }));
    expect(list).toEqual({ overflow: "auto", inside: true });

    // 映像を出すと色を写す。E2E の既定 (動かさない設定・ソフトウェアで描く) では 1 枚で止める
    await watchRaw(page);
    const reflection = page.getByTestId("live-frame-reflection");
    await expect(reflection).toHaveAttribute("data-plan", "hold");
    await expect(reflection).toHaveAttribute("data-updates", "1");
    expect(await painted(page)).toBe(true);
    // 選局しても配置は変わらない (操作バーは上の段の映像の上)
    await expectTabletop(page, "live-frame");
    await wakeControls(page, "live-frame");
    const bar = (await page
      .getByTestId("live-frame")
      .locator("[data-stage-bar]")
      .evaluate((el) => el.getBoundingClientRect().bottom))!;
    expect(bar).toBeLessThanOrEqual(FOLD);

    // オフにすると反射は消え、黒い地に一覧だけ
    await page.evaluate(() => localStorage.setItem("player-ambient", "0"));
    await page.reload();
    await expect(page.getByTestId("live-frame-reflection")).toHaveAttribute(
      "data-plan",
      "off",
    );
    await expect(page.getByTestId("live-frame-reflection")).toBeHidden();
    await expectTabletop(page, "live-frame");
    await page.evaluate(() => localStorage.removeItem("player-ambient"));

    // 本の形 (左右 2 段) では当てない
    await fold(cdp, "book");
    await expectSideBySide(page, "live-frame");

    // 開くと元の二段組に戻る
    await fold(cdp, "flat");
    await expectSideBySide(page, "live-frame");
  });

  test.describe("動かしてよい端末", () => {
    test.use({ reducedMotion: "no-preference" });

    test("映像の色を写し続け、反射を描き直す", async ({ page }) => {
      await pretendGpu(page);
      await goto(page, "/live");
      const cdp = await page.context().newCDPSession(page);
      await fold(cdp, "tabletop");
      await watchRaw(page);
      const reflection = page.getByTestId("live-frame-reflection");
      await expect(reflection).toHaveAttribute("data-plan", "watch");
      await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(5);
      expect(await painted(page)).toBe(true);
      // 入れ替えはアンビエントの光と同じ (CSS の transition。2 枚は足して重ねる)
      const faces = await reflection.locator("canvas").evaluateAll((canvases) =>
        canvases.map((canvas) => {
          const style = getComputedStyle(canvas);
          return `${style.transitionProperty} ${style.mixBlendMode}`;
        }),
      );
      expect(faces).toEqual(["opacity plus-lighter", "opacity plus-lighter"]);
    });
  });

  test("観る画面: 映像を上の段、番組の中身を下の段に置く", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    await goto(page, `/watch/${id}`);
    const cdp = await page.context().newCDPSession(page);
    await fold(cdp, "flat");
    await expectSideBySide(page, "watch-stage");
    await fold(cdp, "tabletop");
    await expect(page.getByTestId("watch-stage-reflection")).toBeAttached();
    await expectTabletop(page, "watch-stage");
    await expectReflection(page, "watch-stage");
    // 番組の中身は列の中で巻く
    const body = await page.getByTestId("watch-facts").evaluate((el) => ({
      overflow: getComputedStyle(el).overflowY,
      inside: el.getBoundingClientRect().bottom <= window.innerHeight + 0.5,
    }));
    expect(body).toEqual({ overflow: "auto", inside: true });
    await fold(cdp, "flat");
    await expectSideBySide(page, "watch-stage");
  });
});
