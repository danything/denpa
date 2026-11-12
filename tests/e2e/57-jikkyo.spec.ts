import type { APIRequestContext, Page } from "@playwright/test";

import { MX } from "../fake/services";
import {
  expect,
  flipSetting,
  goto,
  openSettings,
  pickCodec,
  pretendGpu,
  test,
  wakeControls,
} from "./helpers";
import { deviceOn, fakeNx, setJikkyo } from "./jikkyo";

/**
 * **ニコニコ実況のコメント** (docs/watch.md の「実況」)。既定はオフで、世帯の設定 (連携の「実況」) と
 * 端末の ⚙ の両方がオンのときだけ流す。
 *
 * **外 (NX-Jikkyo・過去ログ API) には繋がない。** 端末が繋ぐ WebSocket と fetch は
 * `page.routeWebSocket` と `page.route` で偽物に差し替え、勢いの中継 (`/api/jikkyo/ranking`) も
 * 画面からの呼び出しを `page.route` で差し替える (サーバの中継そのものは単体テストで見る)。
 *
 * 実況のテストは、ライブの表示 (このファイル)、書き込み (57-jikkyo-write)、一覧とタブ (57-jikkyo-list)、
 * 録画の実況 (57-jikkyo-recorded と 57-jikkyo-recorded-list) に分けてある。1 本にまとめると、CI の組の時間がその 1 本より短くならない。
 * どのテストも世帯の設定を自分でオンにし、終わったら既定 (オフ) に戻す。ファイルの中でも前のテストの状態は当てにしない
 */

// ライブは MPEG-2 のまま観る (`pickCodec`)。MPEG-2 をデコードできる端末として開く (`stack.ts` の `liveWithoutMpeg2`)
test.use({ liveMpeg2: true });

/** 局の一覧の API で、局の名前 → 実況のチャンネル */
async function channels(
  request: APIRequestContext,
): Promise<Record<string, string | null>> {
  const list = (await (await request.get("/api/services")).json()) as {
    name: string;
    jikkyo: string | null;
  }[];
  return Object.fromEntries(list.map((s) => [s.name, s.jikkyo]));
}

test.describe("実況の世帯の設定", () => {
  test("既定はオフ。オフの間は局の一覧に実況のチャンネルを載せず、勢いも返さない", async ({
    page,
    request,
  }) => {
    await goto(page, "/settings/integrations");
    await expect(page.getByTestId("jikkyo-setting")).not.toBeChecked();
    expect(
      Object.values(await channels(request)).every((c) => c === null),
    ).toBe(true);
    expect((await request.get("/api/jikkyo/ranking")).status()).toBe(403);
    // テレビのアプリが読む NG ワードも、オフの間は返さない
    expect((await request.get("/api/jikkyo/ng")).status()).toBe(403);
  });

  test("オンにすると、局の一覧に実況のチャンネルが載る", async ({
    page,
    request,
  }) => {
    await setJikkyo(page, true);
    try {
      const list = await channels(request);
      expect(list["ＴＯＫＹＯ　ＭＸ"]).toBe("jk9");
      expect(list["フジテレビ"]).toBe("jk8");
      // テレビのアプリ向けの NG ワードも読める
      expect((await request.get("/api/jikkyo/ng")).status()).toBe(200);
    } finally {
      await setJikkyo(page, false);
    }
  });
});

test.describe("ライブの実況", () => {
  test("世帯の設定がオフなら ⚙ に「実況」は出ない", async ({ page }) => {
    await goto(page, `/live?service=${MX.id}`);
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await expect(page.getByTestId("live-ambient")).toBeVisible();
    await expect(page.getByTestId("live-jikkyo")).toHaveCount(0);
  });

  test("両方オンなら NX-Jikkyo のコメントを映像の上に流し、⚙ で切れる", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page);
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      // 映像が進まないと放送時刻も進まない。偽の放送をそのままデコードできる MPEG-2 で観る (28-live-raw と同じ)
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const comment = page.getByTestId("jikkyo-comment").first();
      await expect(comment).toHaveText("テストのコメント", { timeout: 20_000 });
      expect(nx.watched[0]).toContain("/channels/jk9/ws/watch");
      // 読み上げには出さない
      await expect(page.getByTestId("jikkyo-layer")).toHaveAttribute(
        "aria-hidden",
        "true",
      );

      await wakeControls(page, "live-frame");
      await openSettings(page, "live");
      const row = page.getByTestId("live-jikkyo");
      await expect(row).toHaveAttribute("aria-checked", "true");
      await row.click();
      await expect(row).toHaveAttribute("aria-checked", "false");
      await expect(page.getByTestId("jikkyo-comment")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("NX-Jikkyo に繋がらなければ、⚙ の行に「(いまは読めません)」を添える (通知は出さない)", async ({
    page,
  }) => {
    // 5 回続けて失敗するまで 1+2+4+8 秒ほど待つ
    test.setTimeout(150_000);
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { refuse: () => true });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await openSettings(page, "live");
      await expect(page.getByTestId("live-jikkyo")).toContainText(
        "(いまは読めません)",
        { timeout: 60_000 },
      );
      await expect(page.getByTestId("live-jikkyo")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    } finally {
      await setJikkyo(page, false);
    }
  });
});

test.describe("ライブの実況の色・位置・大きさ", () => {
  test("ほかの人のコメントの mail を読み、色を付けて上に止め、大きく出す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { text: "赤い上の字", mail: "184 red ue big" });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const comment = page.getByTestId("jikkyo-comment").first();
      await expect(comment).toHaveText("赤い上の字", { timeout: 20_000 });
      await expect(comment).toHaveClass(/\bstill\b/);
      await expect(comment).toHaveCSS("color", "rgb(255, 0, 0)");
      // 大きい (中の 1.25 倍)
      expect(
        await comment.evaluate(
          (el) =>
            parseFloat(getComputedStyle(el).fontSize) /
            parseFloat(getComputedStyle(el.parentElement!).fontSize),
        ),
      ).toBeCloseTo(1.25);
      // 上の行から積む (いちばん上のものは枠の上の端の近く)。止めたものは 3 秒残る
      const frame = (await page.getByTestId("jikkyo-layer").boundingBox())!;
      const tops = await page
        .getByTestId("jikkyo-comment")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(Math.min(...tops) - frame.y).toBeLessThan(frame.height / 4);
      await page.waitForTimeout(1_000);
      await expect(page.getByTestId("jikkyo-comment").first()).toBeVisible();
    } finally {
      await setJikkyo(page, false);
    }
  });
});

/** 枠 (`data-frame`) の位置と大きさ */
async function frameBox(page: Page): Promise<Box> {
  return page
    .locator('[data-testid="jikkyo-layer"] [data-frame]')
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 窓の大きさを変えた後の枠。枠は舞台の大きさを `ResizeObserver` で測り直してから動くので、変えた直後に読むと
 * 前の大きさのことがある (CI で踏んだ)。舞台の幅に揃うまで待つ (縦の端数で 1px ほどずれる)
 */
async function settledFrame(page: Page): Promise<Box> {
  let box = await frameBox(page);
  await expect
    .poll(async () => {
      box = await frameBox(page);
      const stage = await page
        .getByTestId("live-frame")
        .evaluate((el) => el.clientWidth);
      return Math.abs(box.right - box.left - stage) < 2;
    })
    .toBe(true);
  return box;
}

/** いちばん新しい流れるコメント (枠の中の 1 つ) の、流れ始めの位置 (`--from`。枠の左の端から) */
async function newestFrom(page: Page): Promise<number> {
  return page.getByTestId("jikkyo-comment").evaluateAll((els) =>
    parseFloat(
      els
        .filter((el) => !el.classList.contains("still"))
        .at(-1)
        ?.style.getPropertyValue("--from") ?? "NaN",
    ),
  );
}

test.describe("アンビエントの光の上を流れる実況", () => {
  test.use({ reducedMotion: "no-preference" });

  test("光が枠の外に見えている間は、流れるものは光の範囲の端から端まで流れる。止めるものは枠の中。外が無ければ今までどおり", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await setJikkyo(page, true);
    try {
      await fakeNx(page, {
        texts: ["流れる字", "上の字"],
        mails: [undefined, "ue"],
      });
      await deviceOn(page);
      await pretendGpu(page);
      // 枠を高さで抑える広い窓 (二段組で、枠の左右に光の範囲が余る)
      await page.setViewportSize({ width: 2400, height: 1000 });
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const outside = page.getByTestId("live-frame-outside");
      await expect(outside).toBeAttached({ timeout: 30_000 });

      const frame = await frameBox(page);
      const room = await outside.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      // 外の所は窓の端から端まで (右の列の上も通る)。見出しには掛からない
      const aside = (await page
        .locator("[data-player-side] > aside")
        .boundingBox())!;
      const width = await page.evaluate(
        () => document.documentElement.clientWidth,
      );
      expect(room.left).toBeCloseTo(0, 0);
      expect(room.right).toBeCloseTo(width, 0);
      expect(room.right).toBeGreaterThan(aside.x + 100);
      expect(frame.left - room.left).toBeGreaterThan(100);
      const header = (await page.locator(".navbar").boundingBox())!;
      expect(room.top).toBeGreaterThanOrEqual(header.y + header.height - 0.5);

      // 流れるものは外の右の端から流し始める (行は枠のまま)
      await expect
        .poll(() => newestFrom(page), { timeout: 20_000 })
        .toBeCloseTo(room.right - frame.left, -1);
      // 外の写しが、枠の外 (光の上) に見えている
      await expect
        .poll(
          () =>
            page.getByTestId("jikkyo-outside-comment").evaluateAll(
              (els, f) =>
                els.some((el) => {
                  const r = el.getBoundingClientRect();
                  return r.left > f.right + 10 || r.right < f.left - 10;
                }),
              frame,
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
      // 写しは枠の行と同じ高さ
      const rows = await page.evaluate(() => {
        const tops = (testid: string) =>
          [
            ...document.querySelectorAll<HTMLElement>(
              `[data-testid="${testid}"]`,
            ),
          ]
            .filter((el) => !el.classList.contains("still"))
            .map((el) => Math.round(el.getBoundingClientRect().top));
        return {
          inside: tops("jikkyo-comment"),
          outside: tops("jikkyo-outside-comment"),
        };
      });
      for (const top of rows.outside) expect(rows.inside).toContain(top);

      // 右の列の上を通っている間も、押すのは右の列の中身 (外のコメントは押すものを受けない)
      await expect
        .poll(
          () =>
            page.getByTestId("jikkyo-outside-comment").evaluateAll(
              (els, side) =>
                els.some((el) => {
                  const r = el.getBoundingClientRect();
                  const x = Math.max(r.left, side.x + 8);
                  if (x > r.right - 4 || x > window.innerWidth - 4)
                    return false;
                  const hit = document.elementFromPoint(
                    x,
                    r.top + r.height / 2,
                  );
                  return hit?.closest("[data-player-side]") != null;
                }),
              aside,
            ),
          { timeout: 20_000 },
        )
        .toBe(true);

      // 止めるもの (`ue`) は枠の中だけ。写しは作らない
      const still = page.locator('[data-testid="jikkyo-comment"].still');
      await expect(still.first()).toHaveText("上の字", { timeout: 20_000 });
      const box = await still.first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      expect(box.left).toBeGreaterThanOrEqual(frame.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(frame.right + 0.5);
      await expect(
        page
          .getByTestId("jikkyo-outside-comment")
          .filter({ hasText: "上の字" }),
      ).toHaveCount(0);

      // 縦に積むと外は無く、枠の右の端から流す (今までどおり)
      await page.setViewportSize({ width: 900, height: 900 });
      const narrow = await settledFrame(page);
      await expect
        .poll(() => newestFrom(page), { timeout: 20_000 })
        .toBeCloseTo(narrow.right - narrow.left, -1);

      // 広い窓でも、光を消せば枠の中だけ
      await page.setViewportSize({ width: 2400, height: 1000 });
      await wakeControls(page, "live-frame");
      await flipSetting(page, "live", "ambient");
      await expect(outside).toHaveCount(0);
      const wide = await settledFrame(page);
      await expect
        .poll(() => newestFrom(page), { timeout: 20_000 })
        .toBeCloseTo(wide.right - wide.left, -1);
      await expect(page.getByTestId("jikkyo-outside-comment")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
  });
});

/** 設定画面の NG ワードを書き換えて、保存し終えるまで (欄を離れたときに保存する) */
async function setNg(page: Page, text: string): Promise<void> {
  await goto(page, "/settings/integrations");
  const field = page.getByTestId("jikkyo-ng");
  await field.fill(text);
  await field.blur();
  await expect(page.getByTestId("saved-result")).toBeVisible();
}

test.describe("実況の NG ワード", () => {
  test("NG ワードを含むコメントは流さない (半角カナで書いても、ひらがなのものに効く)", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await setNg(page, "ﾈﾀﾊﾞﾚ\n\n");
      // 空の行は落として保存する
      await goto(page, "/settings/integrations");
      await expect(page.getByTestId("jikkyo-ng")).toHaveValue("ﾈﾀﾊﾞﾚ");
      // テレビのアプリは同じものを API で読む (比べ方をそろえるのは受け側)
      expect(await (await page.request.get("/api/jikkyo/ng")).json()).toEqual({
        words: ["ﾈﾀﾊﾞﾚ"],
      });
      await fakeNx(page, { texts: ["ねたばれ注意", "ふつうのコメント"] });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const comments = page.getByTestId("jikkyo-comment");
      await expect(comments.first()).toHaveText("ふつうのコメント", {
        timeout: 20_000,
      });
      await page.waitForTimeout(1_000);
      expect(await comments.allTextContents()).not.toContain("ねたばれ注意");
    } finally {
      await setNg(page, "");
      await setJikkyo(page, false);
    }
  });

  test("多すぎる・長すぎる NG ワードは保存せず、理由を出す", async ({
    page,
  }) => {
    await goto(page, "/settings/integrations");
    const field = page.getByTestId("jikkyo-ng");
    await field.fill("あ".repeat(41));
    await field.blur();
    await expect(page.getByTestId("settings-error")).toContainText(
      "1 語は 40 文字までです",
    );
    await expect(field).toHaveValue("");
  });
});
