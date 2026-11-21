import type { Page } from "@playwright/test";

import {
  captureSockets,
  countBarWakes,
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

  test("家の中で開くと MPEG-2 で観る。メニューは自動・エンコードするもの 1 つ・MPEG-2 の順 (GPU が無いので H.264)", async ({
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
    ).toEqual(["auto", "h264", "mpeg2"]);
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

  /*
   * **自動で段を切り替えても、操作バーは出さない** (`controls.svelte.ts` の `stir`)。出すのは人が触ったときだけで、
   * 切り替えたことは映像の上の断り書きで伝える。カーソルは舞台の上に置いたまま (止まったカーソルの下で映像を入れ替える)
   */
  test("自動で段を切り替えても、引っ込んだ操作バーは出てこない", async ({
    page,
  }) => {
    await captureSockets(page);
    await openLive(page);
    await expect(page.getByTestId("live-raw")).toBeVisible({
      timeout: 30_000,
    });
    const wakes = await countBarWakes(page, "live-frame", "live-controls");
    await expect(async () => {
      await feedNotice(page, [
        { type: "pace", backlog: 0, dropped: 3, speed: null },
      ]);
      await expect(page.getByTestId("live-warning")).toContainText(
        "回線が細いため",
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("live-codec")).toContainText(
      /自動 \(H\.264 \d+p\)/,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("live-video")).toBeVisible({
      timeout: 30_000,
    });
    // 出てこないことは時間で待つ。CI では入れ替えた `<video>` の `paused` が 30 秒たっても false にならず、再生の始まりでは待てなかった
    await page.waitForTimeout(3_000);
    expect(await wakes()).toBe(0);
    await expect(page.getByTestId("live-controls")).toHaveAttribute(
      "data-shown",
      "false",
    );
  });

  /*
   * **届いているのに端末の処理で止まったのは、回線のせいにしない** (`adapt.ts` の `LAG_STEADY`)。メインスレッドを 1.5 秒ごとに
   * 0.7 秒塞ぐ (実況の描画などが重い端末のつもり)。音を使い切って止まるが、届いた端は放送に遅れないので、段は下げない。
   * 直す前は「回線が細いため、360p に下げました」と出て変換に移っていた。端末のデコードが間に合わずに形式を替えるのは
   * `raw/budget.ts` の役目で、並べて流すと起きるので、ここでは形式を見ない
   */
  test("メインスレッドが塞がって止まっても、家の中の MPEG-2 から段を下げない", async ({
    page,
  }) => {
    await openLive(page);
    const canvas = page.getByTestId("live-raw");
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => Number((await canvas.getAttribute("data-shown")) ?? 0))
      .toBeGreaterThan(30);
    // 放送に対する遅れを測れるまで (選局から 4 秒。`LAG_SPAN`) は、これまでどおり詰まりで下げる。測れてから塞ぎ始める
    await page.waitForTimeout(5_000);
    await page.evaluate(() => {
      setInterval(() => {
        const end = performance.now() + 700;
        while (performance.now() < end);
      }, 1_500);
    });
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      seen.push(
        (await page.getByTestId("live-warning").allTextContents()).join(""),
      );
      await page.waitForTimeout(1_000);
    }
    expect(seen.join("\n")).not.toContain("回線が細いため");
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
      .locator('[data-testid="live-codec-option"][data-codec="h264"]')
      .click();
    await expect(page.getByTestId("live-codec")).toHaveText(/H\.264/);
    await expect(page.getByTestId("live-raw")).toHaveCount(0, {
      timeout: 30_000,
    });

    await goto(page, "/live");
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect(page.getByTestId("live-codec")).not.toContainText("自動");
    await expect(page.getByTestId("live-codec")).toContainText("H.264");
  });

  test("前に AV1 を選んでいた端末は、AV1 をその場でエンコードできない (メニューに並ばない) ので自動で開く", async ({
    page,
    stack,
  }) => {
    await page.context().addCookies([
      {
        name: "denpa_live_last",
        value: encodeURIComponent(JSON.stringify({ choice: "av1" })),
        domain: new URL(stack.appUrl).hostname,
        path: "/live",
      },
    ]);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-codec")).toContainText("自動 (MPEG-2)");
  });

  test("前に H.264 を選んでいた端末は、H.264 がメニューに並んでいればそれで開く", async ({
    page,
    stack,
  }) => {
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
    await expect(page.getByTestId("live-codec")).toHaveText(/H\.264/);
    await expect(page.getByTestId("live-codec")).not.toContainText("自動");
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

  test("観るときの決まりを API で返す (127.0.0.1 は家の中。GPU が無いのでその場でエンコードできるのは H.264 だけで、AV1 と H.265 を外させる)", async ({
    request,
  }) => {
    const res = await request.get("/api/playback/options");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(await res.json()).toEqual({
      indoor: true,
      liveCodecs: ["h264"],
      hidden: ["av1", "hevc"],
      hevc: false,
    });
  });
});
