import type { APIRequestContext, Page } from "@playwright/test";

import {
  expect,
  goto,
  openSettings,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **ライブの「自動」** (`#lib/live-choice.ts` の `autoCodec`)。E2E は 127.0.0.1 で開くので家の中 (`#lib/host.ts`)。
 * ほかのスペックは H.264 を選んだ端末として開くので (`stack.ts` の `keepH264`)、ここでは cookie を消して自動から始める
 */

/** 選局して、コーデックの行が出るまで */
async function openLive(page: Page): Promise<void> {
  await page.context().clearCookies();
  await goto(page, "/live");
  await page.getByTestId("live-channel").first().click();
  await expect(page.getByTestId("live-title")).toBeVisible();
}

/** 世帯の設定の「視聴」を保存する (画面と同じ action) */
async function saveViewing(
  request: APIRequestContext,
  form: { indoorHosts?: string; hideH264Hevc?: boolean },
): Promise<void> {
  const res = await request.post("/settings/recording?/saveViewing", {
    form: {
      indoorHosts: form.indoorHosts ?? "",
      ...(form.hideH264Hevc === true ? { hideH264Hevc: "on" } : {}),
    },
  });
  expect(res.ok()).toBe(true);
}

test.describe("ライブの自動", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("家の中で開くと MPEG-2 で観る。メニューは自動・AV1・H.264・MPEG-2 の順", async ({
    page,
  }) => {
    await openLive(page);
    await expect(page.getByTestId("live-raw")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("live-codec")).toContainText("自動 (MPEG-2)");

    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await page.getByTestId("live-codec").click();
    const options = page.getByTestId("live-codec-option");
    await expect(options).toHaveCount(4);
    expect(
      await options.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-codec")),
      ),
    ).toEqual(["auto", "av1", "h264", "mpeg2"]);
    await expect(
      page.locator('[data-testid="live-codec-option"][data-codec="auto"]'),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("MPEG-2 をデコードできない端末では、断り書きを出さずに AV1 で観る", async ({
    page,
  }) => {
    // worker へ描く先を渡せない端末 (OffscreenCanvas の無い古い Safari)
    await page.addInitScript(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- 端末に無いことにする
      delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
    });
    await openLive(page);
    await expect(page.getByTestId("live-codec")).toContainText("自動 (AV1)");
    await expect(page.getByTestId("live-raw")).toHaveCount(0);
    await expect(page.getByTestId("live-warning")).toHaveCount(0);
  });

  test("AV1 も受け取れない端末では H.264 で観る", async ({ page }) => {
    await page.addInitScript(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- 端末に無いことにする
      delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
      const can = MediaSource.isTypeSupported.bind(MediaSource);
      MediaSource.isTypeSupported = (type) =>
        !type.includes("av01") && can(type);
    });
    await openLive(page);
    await expect(page.getByTestId("live-codec")).toContainText("自動 (H.264)");
  });

  test("選んだものは家の中でもそのまま使い、開き直しても覚えている", async ({
    page,
  }) => {
    await openLive(page);
    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await page.getByTestId("live-codec").click();
    await page
      .locator('[data-testid="live-codec-option"][data-codec="av1"]')
      .click();
    await expect(page.getByTestId("live-codec")).toHaveText(/AV1/);
    await expect(page.getByTestId("live-raw")).toHaveCount(0, {
      timeout: 30_000,
    });

    await goto(page, "/live");
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect(page.getByTestId("live-codec")).not.toContainText("自動");
    await expect(page.getByTestId("live-codec")).toContainText("AV1");
  });

  test("H.264 と H.265 を出さない設定では、メニューに H.264 が無く、H.264 を選んでいた端末も自動になる", async ({
    page,
    request,
  }) => {
    await saveViewing(request, { hideH264Hevc: true });
    try {
      // 設定の画面にも保存したものが出る
      await goto(page, "/settings/recording");
      await expect(page.getByTestId("hide-h264-hevc")).toBeChecked();
      // テレビのアプリは同じものを API で読む
      expect(
        await (await page.request.get("/api/playback/options")).json(),
      ).toEqual({ indoor: true, hidden: ["h264", "hevc"] });

      // この端末は H.264 を選んでいた (`keepH264`) が、自動として開く
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-codec")).toContainText(
        "自動 (MPEG-2)",
      );
      await wakeControls(page, "live-frame");
      await openSettings(page, "live");
      await page.getByTestId("live-codec").click();
      expect(
        await page
          .getByTestId("live-codec-option")
          .evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-codec")),
          ),
      ).toEqual(["auto", "av1", "mpeg2"]);
    } finally {
      await saveViewing(request, {});
    }
  });

  test("家の中の名前は 1 行に 1 つ保存し、読めない名前は理由を出す", async ({
    page,
  }) => {
    await goto(page, "/settings/recording");
    const field = page.getByTestId("indoor-hosts");
    await field.fill("dp.l.example.com\n\nhttps://NAS.example.com/live");
    await field.blur();
    await expect(page.getByTestId("saved-result")).toBeVisible();
    await goto(page, "/settings/recording");
    await expect(field).toHaveValue("dp.l.example.com\nnas.example.com");

    await field.fill("dp example.com");
    await field.blur();
    await expect(page.getByTestId("settings-error")).toContainText(
      "名前として読めません",
    );
    await field.fill("");
    await field.blur();
    await expect(page.getByTestId("saved-result")).toBeVisible();
  });

  test("観るときの決まりを API で返す (127.0.0.1 は家の中)", async ({
    request,
  }) => {
    const res = await request.get("/api/playback/options");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(await res.json()).toEqual({ indoor: true, hidden: [] });
  });
});
