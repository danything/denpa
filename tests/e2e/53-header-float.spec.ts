import type { Page } from "@playwright/test";

import { expect, goto, test } from "./helpers";

/**
 * **広い画面のヘッダーは、巻くと浮き、上端と巻けない画面では平ら** (docs/design.md の「浮かせ方」)。
 *
 * 面と影は窓の巻いた量で進むアニメーション (`+layout.svelte`)。巻けない画面へ移ると時間の軸が止まり、
 * Chrome は止まる前の値を残すので、長いページで巻いてから短いページへ移ると浮いたままになっていた。
 * ほかのスペックは動きを止めて流す (いつも浮いた形になる) ので、ここだけ動きを許す
 */
test.use({
  viewport: { width: 1280, height: 720 },
  reducedMotion: "no-preference",
});

/**
 * ヘッダーの面が透明か。アニメーションの途中 (番組表の上端など) では、透明も `oklab(0 0 0 / 0)` の形で返る
 */
function flat(page: Page) {
  return page.evaluate(() =>
    /^rgba\(0, 0, 0, 0\)$|\/ 0\)$/.test(
      getComputedStyle(document.querySelector(".navbar")!).backgroundColor,
    ),
  );
}

/** 設定の画面で巻いて、ヘッダーを浮かせる */
async function floatOnSettings(page: Page) {
  await goto(page, "/settings");
  const scrollable = await page.evaluate(
    () =>
      document.scrollingElement!.scrollHeight -
      document.scrollingElement!.clientHeight,
  );
  // 浮くのを見るには、設定の画面がヘッダーの浮く量 (1.5rem) より長く巻ける必要がある
  expect(scrollable).toBeGreaterThan(24);
  await expect.poll(() => flat(page)).toBe(true);

  await page.mouse.wheel(0, 2000);
  await expect.poll(() => flat(page)).toBe(false);
}

test("巻くと浮き、巻けない画面へ移ると平らに戻る", async ({ page }) => {
  await floatOnSettings(page);
  // ルールが空なら巻けない画面。巻けるときは上端に戻した姿を見る
  await page.locator('.navbar a[href="/rules"]').first().click();
  await page.waitForURL("**/rules");
  await expect.poll(() => flat(page)).toBe(true);
});

/** 番組表を開き、表を縦に巻いてヘッダーを浮かせる (開いたときも「いま」へ巻くので浮いている) */
async function floatOnGuide(page: Page) {
  await goto(page, "/guide?type=GR");
  await expect(page.getByTestId("guide-service").first()).toBeVisible();
  await page
    .getByTestId("guide-grid")
    .evaluate((el) => el.scrollTo({ top: 400, behavior: "instant" }));
  await expect.poll(() => flat(page)).toBe(false);
}

/** ヘッダーのナビから移る (設定は最初の節へ送られる) */
async function navigate(page: Page, url: string) {
  await page.locator(`.navbar ul.links a[href="${url}"]`).click();
  await page.waitForURL((u) =>
    url === "/" ? u.pathname === "/" : u.pathname.startsWith(url),
  );
}

/** 番組表の表を縦に巻き、描き直しを 1 回待ってからヘッダーが平らかを返す */
async function scrollGuideAndRead(page: Page, top: number) {
  await page.getByTestId("guide-grid").evaluate(async (el, t) => {
    el.scrollTo({ top: t, behavior: "instant" });
    await new Promise(requestAnimationFrame);
  }, top);
  return flat(page);
}

/*
 * **ライブは窓も箱も巻かないので、どこから移ってもヘッダーは平ら** (docs/design.md の「観る画面」)。
 * 番組表と同じ時間の軸のアニメーションを残していたので、表を巻いて浮いた番組表から移ると、浮いたままになっていた。
 * ほかの画面 (録画・設定) へ移ったときも、上端に戻るので平らになる
 */
for (const [from, float, urls] of [
  ["番組表", floatOnGuide, ["/live", "/", "/settings"]],
  ["設定", floatOnSettings, ["/live", "/"]],
] as const) {
  for (const url of urls) {
    test(`${from}で浮いたまま移っても平らに戻る (${url})`, async ({ page }) => {
      await float(page);
      await navigate(page, url);
      await expect.poll(() => flat(page)).toBe(true);
    });
  }
}

test("設定で浮いたまま番組表へ移ると、表の巻いた量で浮く", async ({ page }) => {
  await floatOnSettings(page);
  await navigate(page, "/guide");
  await expect(page.getByTestId("guide-service").first()).toBeVisible();
  // 開いたときの「いま」への位置合わせが後から来るので、上端に戻すのも込みで待つ
  await expect(async () => {
    expect(await scrollGuideAndRead(page, 0)).toBe(true);
  }).toPass();
  await expect(async () => {
    expect(await scrollGuideAndRead(page, 400)).toBe(false);
  }).toPass();
});

/**
 * **本文へ移動のリンクは、キーボードで Tab を押したときだけ左上に出る** (`+layout.svelte` の `.skip`)。
 * 押すと本文 (`main`) に焦点が移り、次の Tab は本文の中から始まる。設定の画面が `#` を節の名前として読むので、URL は変えない
 */
test("Tab で「本文へ移動」が出て、Enter で本文へ焦点が移る", async ({
  page,
}) => {
  await goto(page, "/rules");
  const skip = page.getByTestId("skip-to-main");
  const box = async () => (await skip.boundingBox())!;
  // ふだんは画面の上の外
  expect((await box()).y + (await box()).height).toBeLessThanOrEqual(0);

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toHaveText("本文へ移動");
  expect((await box()).y).toBeGreaterThanOrEqual(0);

  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("");
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.querySelector("main")!.contains(document.activeElement),
    ),
  ).toBe(true);
  // 焦点が離れたら、また画面の外へ
  expect((await box()).y + (await box()).height).toBeLessThanOrEqual(0);
});

/**
 * **明暗を選び直すと、画面全体が前の色から次の色へ移る** (`theme.svelte.ts` の `crossfade`。View Transitions の種類 `theme`)。
 * 開いたときは `app.html` が描く前に色を当てるので、移り変わりは走らない (白から黒へ一瞬見えない)
 */
test("明暗を選び直したときだけ画面全体が移り、開いたときは移らない", async ({
  page,
}) => {
  // E2E のブラウザは GPU を切っていて `<html data-lite>` が付く (`#lib/lite.ts`)。WebGL の描き手の名前を差し替えて、GPU で描ける端末として見る
  await page.addInitScript(() => {
    const read = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (name: number) {
      const value: unknown = read.call(this, name);
      return typeof value === "string" ? "Test GPU" : value;
    };
  });
  await page.addInitScript(() => {
    const w = window as unknown as { kinds: string[][] };
    w.kinds = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((
      arg: Parameters<Document["startViewTransition"]>[0],
    ) => {
      w.kinds.push(
        typeof arg === "object" && arg !== null ? [...(arg.types ?? [])] : [],
      );
      return start(arg);
    }) as Document["startViewTransition"];
  });
  const kinds = () =>
    page.evaluate(() => (window as unknown as { kinds: string[][] }).kinds);
  const html = page.locator("html");

  // 選ぶのは設定の「この端末」のテーマ
  const select = page.getByTestId("theme-select");
  await goto(page, "/settings/general");
  await expect(html).toHaveAttribute("data-theme", "dark");
  // 開いた直後は写しを取らない
  expect(await kinds()).toEqual([]);

  await select.selectOption("light");
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await kinds()).toEqual([["theme"]]);

  // 読み直しても、選んだ色で描かれ、移り変わりは走らない
  await goto(page, "/settings/general");
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await kinds()).toEqual([]);

  // ソフトウェアで描いている端末でも、すぐ替える
  await page.evaluate(() => {
    document.documentElement.dataset["lite"] = "";
  });
  await select.selectOption("system");
  await expect(select).toHaveAttribute("data-mode", "system");
  expect(await kinds()).toEqual([]);
  await page.evaluate(() => {
    delete document.documentElement.dataset["lite"];
  });

  // 動きを減らす設定では写しを取らず、すぐ替える
  await page.emulateMedia({ reducedMotion: "reduce" });
  await select.selectOption("dark");
  await expect(select).toHaveAttribute("data-mode", "dark");
  expect(await kinds()).toEqual([]);
});

/** 番組表の時の列と左上の角の面の濃さ (透明度で出し入れする。`guide/+page.svelte`) */
function guideFloat(page: Page) {
  return page.evaluate(() => ({
    corner: Number(
      getComputedStyle(document.querySelector(".corner")!, "::after").opacity,
    ),
    hour: Number(
      getComputedStyle(document.querySelector(".hour")!, "::before").opacity,
    ),
  }));
}

/*
 * **番組表の時の列は、横に送ってマスが裏に入ったときだけ浮く** (docs/design.md の「浮かせ方」)。
 * 左上の角も同じく横に送ったときだけ浮く。縦に巻いたときは地の色で平らに、裏に来る時の数字を隠すだけ
 */
test("番組表の時の列と角は横に送ると浮き、縦に巻いても角は平ら", async ({
  page,
}) => {
  // 合成のデータは局が少ないので、横に送れる狭い幅にする (面の出し方は幅によらず同じ)
  await page.setViewportSize({ width: 320, height: 700 });
  await goto(page, "/guide?type=GR");
  const grid = page.getByTestId("guide-grid");
  await expect(page.getByTestId("guide-service").first()).toBeVisible();
  const scroll = (left: number, top: number) =>
    grid.evaluate(
      (el, [l, t]) => el.scrollTo({ left: l!, top: t!, behavior: "instant" }),
      [left, top],
    );

  await scroll(0, 0);
  await expect.poll(() => guideFloat(page)).toEqual({ corner: 0, hour: 0 });

  await scroll(60, 0);
  await expect.poll(() => guideFloat(page)).toEqual({ corner: 1, hour: 1 });

  // 縦だけ巻くと、時の列の裏にマスは来ない。角は地の色のまま (面にすると局名の左に色の塊が見えた)
  await scroll(0, 400);
  await expect.poll(() => guideFloat(page)).toEqual({ corner: 0, hour: 0 });
  expect(
    await page.evaluate(() => {
      // 地の色 (`--dp-bg`) を同じ書き方で解いて比べる
      const probe = document.createElement("div");
      probe.style.background = "var(--dp-bg)";
      document.body.append(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return (
        getComputedStyle(document.querySelector(".corner")!).backgroundColor ===
        bg
      );
    }),
  ).toBe(true);
});

test.describe("動きを減らす設定", () => {
  test.use({ reducedMotion: "reduce" });

  test("番組表の時の列と角は、上端でも浮いた形のまま", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await goto(page, "/guide?type=GR");
    await expect(page.getByTestId("guide-service").first()).toBeVisible();
    await page
      .getByTestId("guide-grid")
      .evaluate((el) => el.scrollTo({ left: 0, top: 0, behavior: "instant" }));
    await expect.poll(() => guideFloat(page)).toEqual({ corner: 1, hour: 1 });
  });
});

/*
 * **スマホでは、番組表の操作の1行もほかの画面と同じく下のタブのすぐ上に浮く** (docs/design.md の「浮かせ方」)。
 * 平らなまま表の下に置かれていたので、面 (`--dp-float`) とカプセルの角 (`--dp-radius-full`) を見る
 */
test("スマホの番組表の操作の1行は、カプセルの面で浮く", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goto(page, "/guide?type=GR");
  const bar = page.getByTestId("guide-toolbar");
  await expect(bar).toBeVisible();
  const style = await bar.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, radius: s.borderTopLeftRadius };
  });
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.radius).toBe("999px");
});

/**
 * 下のタブの印 (並びの疑似要素) と、`aria-current` の付いたタブの字の箱。
 * 印の箱は並びの左上からの `left`・`top`・`width` で読む (疑似要素は `getBoundingClientRect` で測れない)
 */
function tabMark(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".tabbar")!;
    const label = bar
      .querySelector('.tab[aria-current="page"] > span')!
      .getBoundingClientRect();
    const mark = getComputedStyle(bar, "::before");
    const box = bar.getBoundingClientRect();
    const left = box.left + parseFloat(mark.left);
    const top = box.top + parseFloat(mark.top);
    return {
      left: left - label.left,
      right: left + parseFloat(mark.width) - label.right,
      gap: top - label.bottom,
      height: mark.height,
    };
  });
}

/*
 * **下のタブの印は、ほかの横の並びと同じく、選んでいるタブの字の幅いっぱいの下線** (docs/design.md の「選んでいるもの」・「選んでいる印は、前の場所から滑る」)。
 * 字のすぐ下に引く。「その他」はメニューのボタンで、`Menu` が自分のアンカー名を付けるため、前はルールや設定で印が左端に出ていた
 */
for (const url of ["/", "/guide?type=GR", "/rules", "/settings", "/search"]) {
  test(`下のタブの印は選んでいるタブの字の下線 (${url})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, url);
    await expect(
      page.locator('.tabbar .tab[aria-current="page"]'),
    ).toBeVisible();
    await expect(async () => {
      const mark = await tabMark(page);
      expect(Math.abs(mark.left)).toBeLessThan(1);
      expect(Math.abs(mark.right)).toBeLessThan(1);
      expect(mark.gap).toBeGreaterThanOrEqual(0);
      expect(mark.gap).toBeLessThan(4);
      expect(mark.height).toBe("2px");
    }).toPass({ timeout: 5_000 });
  });
}
