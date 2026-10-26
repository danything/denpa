import type { Page } from "@playwright/test";

import { expect, goto, syncEpg, test } from "./helpers";

/**
 * **番組表は局名の行と時刻の列を先に出し、マスのところだけ骨組みにする**
 * (`guide/+page.server.ts` が局の並び、`guide/+page.ts` が `/api/guide` からマスを取る)。
 *
 * マスの取得 (`/api/guide`) を `page.route` で止めておき、止めている間の姿と、通したあとの姿を見比べる。
 * サービスワーカーは止める (動いていると取得があちら経由になり、`page.route` で止められない)
 */
test.use({ serviceWorkers: "block" });

/** マスの取得を止める。`release` で通し、`rearm` でまた止める */
async function holdSheets(page: Page) {
  let open = (): void => {};
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await page.route("**/api/guide?*", async (route) => {
    await gate;
    await route.continue();
  });
  return {
    release: () => open(),
    rearm: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
  };
}

/** 表の枠・局名・時刻の位置と、縦の送り位置 */
function layout(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return [
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
      ];
    };
    const grid = document.querySelector(
      '[data-testid="guide-grid"]',
    ) as HTMLElement;
    return {
      grid: box(grid),
      scrollTop: Math.round(grid.scrollTop),
      services: [
        ...document.querySelectorAll('[data-testid="guide-service"]'),
      ].map(box),
      hours: [...document.querySelectorAll(".hour-label")].map(box),
    };
  });
}

/** 骨組み (の見えているところ) の下の端と、届くべき位置 (広い画面は画面の下、640〜767px は下の操作の行の上) */
function bottoms(page: Page, toolbar: string) {
  return page.evaluate((toolbar) => {
    const skeleton = [
      ...document.querySelectorAll('[data-testid="guide-skeleton"]'),
    ].find((el) => el.checkVisibility()) as HTMLElement;
    let bottom = skeleton.getBoundingClientRect().bottom;
    // マスのところの骨組みは 24 時間ぶんの高さがあり、表の枠の中で切られて見える
    const grid = skeleton.closest('[data-testid="guide-grid"]');
    if (grid !== null)
      bottom = Math.min(bottom, grid.getBoundingClientRect().bottom);
    const narrow = matchMedia(
      "(min-width: 640px) and (max-width: 767px)",
    ).matches;
    // 640〜767px は操作の1行が表の下に並ぶ (上の余白ぶん空ける)。スマホは表が画面の下の端まで伸び、1行はその上に浮く
    const bar = document.querySelector(toolbar) as HTMLElement;
    const limit = narrow
      ? bar.getBoundingClientRect().top -
        parseFloat(getComputedStyle(bar).marginTop)
      : window.innerHeight;
    return { bottom: Math.round(bottom), limit: Math.round(limit) };
  }, toolbar);
}

test("局名の行と時刻の列はマスより先に出て、届いても動かない", async ({
  page,
  request,
}) => {
  await syncEpg(request);
  const sheets = await holdSheets(page);
  await page.goto("/guide?type=GR");
  await page.locator('[data-hydrated="true"]').waitFor();

  // マスはまだ無く、そこだけ骨組み。局名の行・時刻の列・「いま」の時刻は本物
  await expect(page.getByTestId("guide-skeleton")).toBeVisible();
  await expect(page.getByTestId("program-button")).toHaveCount(0);
  await expect(page.getByTestId("guide-service").first()).toBeVisible();
  await expect(page.locator(".hour-label").first()).toBeAttached();
  await expect(page.getByTestId("now-line")).toBeVisible();
  // いまの位置まで、骨組みのうちに送ってある
  const now = await page.evaluate(() => {
    const grid = document.querySelector(
      '[data-testid="guide-grid"]',
    ) as HTMLElement;
    const line = document.querySelector(
      '[data-testid="now-line"]',
    ) as HTMLElement;
    const top =
      line.getBoundingClientRect().top - grid.getBoundingClientRect().top;
    return { top, height: grid.clientHeight, scrollTop: grid.scrollTop };
  });
  expect(now.top).toBeGreaterThan(0);
  expect(now.top).toBeLessThan(now.height);
  const before = await layout(page);

  sheets.release();
  await expect(page.getByTestId("program-button").first()).toBeVisible();
  await expect(page.getByTestId("guide-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("guide-grid")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(await layout(page)).toEqual(before);
});

for (const [width, height] of [
  [1440, 900],
  [1366, 768],
  [820, 1180],
  [390, 844],
] as const) {
  test(`骨組みは画面の下の端まで届く ${width}×${height}`, async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    await page.setViewportSize({ width, height });
    const sheets = await holdSheets(page);

    // 番組表を開いたところ (局の並びは届いていて、マスを待っている)
    await page.goto("/guide?type=GR");
    await page.locator('[data-hydrated="true"]').waitFor();
    await expect(page.getByTestId("guide-skeleton")).toBeVisible();
    const opened = await bottoms(page, '[data-testid="guide-toolbar"]');
    expect(
      Math.abs(opened.bottom - opened.limit),
      JSON.stringify(opened),
    ).toBeLessThanOrEqual(1);
    sheets.release();
    await expect(page.getByTestId("program-button").first()).toBeVisible();

    // ほかの画面から移る途中 (局の並びもまだ届いていない。`GuidePending`)
    await goto(page, "/");
    await page.route("**/guide/__data.json*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await page.getByTestId(width < 640 ? "tab-guide" : "nav-guide").click();
    await expect(page.getByTestId("guide-pending")).toBeVisible();
    const pending = await bottoms(
      page,
      '[data-testid="guide-pending"] .toolbar',
    );
    expect(
      Math.abs(pending.bottom - pending.limit),
      JSON.stringify(pending),
    ).toBeLessThanOrEqual(1);
  });
}

test("放送波を選び直すと、押してすぐマスが骨組みになり、局名は届いたら出る", async ({
  page,
  request,
}) => {
  await syncEpg(request);
  await goto(page, "/guide?type=GR");
  const sheets = await holdSheets(page);
  // 外枠 (局の並び) も少し遅らせて、局名の行が骨組みになっている間を作る
  await page.route("**/guide/__data.json*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.getByTestId("type-BS").click();
  // 押してすぐ: マスも局名も骨組み。時刻の列はそのまま
  await expect(page.getByTestId("guide-skeleton")).toBeVisible();
  await expect(page.getByTestId("program-button")).toHaveCount(0);
  await expect(
    page.getByTestId("guide-service-skeleton").first(),
  ).toBeVisible();
  await expect(page.locator(".hour-label").first()).toBeAttached();

  // 外枠が届く: BS の局名が出て、マスはまだ骨組み
  await expect(page).toHaveURL(/type=BS/);
  await expect(page.getByTestId("guide-service").first()).toBeVisible();
  await expect(page.getByTestId("guide-service-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("guide-skeleton")).toBeVisible();
  const before = await layout(page);

  // マスが届く: 位置は動かない
  sheets.release();
  await expect(page.getByTestId("program-button").first()).toBeVisible();
  await expect(page.getByTestId("guide-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("guide-grid")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(await layout(page)).toEqual(before);
});

test("日を変えると、押してすぐマスが骨組みになり、局名と時刻はそのまま", async ({
  page,
  request,
}) => {
  await syncEpg(request);
  const sheets = await holdSheets(page);
  await page.goto("/guide?type=GR");
  sheets.release();
  await expect(page.getByTestId("program-button").first()).toBeVisible();
  await expect(page.getByTestId("guide-grid")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  // 前日・翌日の先読み (描き終えて少し置いてから) より先に、また止める
  sheets.rearm();
  const shown = await layout(page);

  await page
    .locator('a[data-testid="guide-day"]:not([aria-current])')
    .first()
    .click();
  await expect(page.getByTestId("guide-skeleton")).toBeVisible();
  await expect(page.getByTestId("program-button")).toHaveCount(0);
  await expect(page.getByTestId("guide-service-skeleton")).toHaveCount(0);
  await expect(page).toHaveURL(/start=/);
  // 同じ放送波なので、局名の行・時刻の列・縦の送り位置はそのまま
  const before = await layout(page);
  expect(before).toEqual(shown);

  sheets.release();
  await expect(page.getByTestId("program-button").first()).toBeVisible();
  await expect(page.getByTestId("guide-skeleton")).toHaveCount(0);
  expect(await layout(page)).toEqual(before);
});

/*
 * 狭い画面の「今日」は start を付けないリンク。付いていないのを「同じ日」と見なしていた頃は、
 * 押しても前の日のマスが残り、骨組みにならなかった
 */
test("狭い画面で「今日」を押しても、押してすぐマスが骨組みになる", async ({
  page,
  request,
}) => {
  await syncEpg(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await goto(page, "/guide?type=GR");
  await page.getByTestId("next-day").click();
  await expect(page).toHaveURL(/start=/);
  // 翌日は開いた時刻によっては番組が無い (作り物の番組はいまの前後にしか無い)。マスではなく、描き終えたことを待つ
  await expect(page.getByTestId("guide-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("guide-grid")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  // 外枠を少し遅らせて、移る途中を見られるようにする
  await page.route("**/guide/__data.json*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.getByTestId("guide-today").click();
  await expect(page.getByTestId("guide-skeleton")).toBeVisible();
  await expect(page.getByTestId("program-button")).toHaveCount(0);
  await expect(page).not.toHaveURL(/start=/);
  await expect(page.getByTestId("program-button").first()).toBeVisible();
});
