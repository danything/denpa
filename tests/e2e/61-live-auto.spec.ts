import type { Page } from "@playwright/test";

import {
  captureSockets,
  expect,
  feedNotice,
  goto,
  openSettings,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **ライブの「自動」** (`#lib/live-choice.ts` の `autoCodec`)。E2E は 127.0.0.1 で開くので家の中 (`#lib/host.ts`)。
 * ほかのスペックは MPEG-2 をデコードできない端末として開くので (`stack.ts` の `liveWithoutMpeg2`)、ここではデコードできる
 * 端末として開き、cookie を消して自動から始める
 */
test.use({ liveMpeg2: true });

/** 選局して、コーデックの行が出るまで */
async function openLive(page: Page): Promise<void> {
  await page.context().clearCookies();
  await goto(page, "/live");
  await page.getByTestId("live-channel").first().click();
  await expect(page.getByTestId("live-title")).toBeVisible();
}

test.describe("ライブの自動", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("家の中で開くと MPEG-2 で観る。メニューは自動・AV1・MPEG-2 の順 (H.264 と H.265 は並べない)", async ({
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
    await expect(options).toHaveCount(3);
    expect(
      await options.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-codec")),
      ),
    ).toEqual(["auto", "av1", "mpeg2"]);
    await expect(
      page.locator('[data-testid="live-codec-option"][data-codec="auto"]'),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("MPEG-2 をデコードできない端末では、断り書きを出さずに H.264 で観る (家の中は MPEG-2 の次が H.264)", async ({
    page,
  }) => {
    // worker へ描く先を渡せない端末 (OffscreenCanvas の無い古い Safari)
    await page.addInitScript(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- 端末に無いことにする
      delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
    });
    await openLive(page);
    await expect(page.getByTestId("live-codec")).toContainText("自動 (H.264)");
    await expect(page.getByTestId("live-raw")).toHaveCount(0);
    await expect(page.getByTestId("live-warning")).toHaveCount(0);
  });

  test("サーバが塊を捨てたと知らせてきたら、家の中の MPEG-2 から段を下げた変換に移り、メニューに高さを出す", async ({
    page,
  }) => {
    await captureSockets(page);
    await openLive(page);
    await expect(page.getByTestId("live-raw")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("live-codec")).toContainText("自動 (MPEG-2)");
    // 選局の直後 (`adapt.ts` の `GRACE`) は数えないので、下がるまで送り続ける。届くたびに新しい通知として数える
    await expect(async () => {
      await feedNotice(page, [
        { type: "pace", backlog: 0, dropped: 3, speed: null },
      ]);
      await expect(page.getByTestId("live-warning")).toContainText(
        "回線が細いため",
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 20_000 });
    // サーバが選んだコーデック (GPU が無いのでソフトウェアの H.264) と段の高さ
    await expect(page.getByTestId("live-codec")).toContainText(
      /自動 \(H\.264 \d+p\)/,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("live-raw")).toHaveCount(0);
  });

  test("H.264 も受け取れない端末では AV1 で観る", async ({ page }) => {
    await page.addInitScript(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- 端末に無いことにする
      delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
      const can = MediaSource.isTypeSupported.bind(MediaSource);
      MediaSource.isTypeSupported = (type) =>
        !type.includes("avc1") && can(type);
    });
    await openLive(page);
    await expect(page.getByTestId("live-codec")).toContainText("自動 (AV1)");
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

  test("前に H.264 を選んでいた端末も自動で開く", async ({ page, stack }) => {
    await page.context().addCookies([
      {
        name: "denpa_live_last",
        value: encodeURIComponent(JSON.stringify({ choice: "h264" })),
        domain: new URL(stack.appUrl).hostname,
        path: "/live",
      },
    ]);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-codec")).toContainText("自動 (MPEG-2)");
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

  test("観るときの決まりを API で返す (127.0.0.1 は家の中。メニューから外すのはいつも H.264 と H.265)", async ({
    request,
  }) => {
    const res = await request.get("/api/playback/options");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(await res.json()).toEqual({
      indoor: true,
      hidden: ["h264", "hevc"],
      hevc: false,
    });
  });
});
