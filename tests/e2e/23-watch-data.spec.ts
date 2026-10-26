import { writeFileSync } from "node:fs";
import { extname } from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

import {
  captionsSeenInDataWindow,
  expect,
  expectSharpCaptions,
  fakeDataBroadcast,
  goto,
  holdCaptions,
  holdMedia,
  recordOne,
  routeCaptions,
  test,
  wakeControls,
} from "./helpers";

/**
 * 録画を観る画面 (`/watch/<id>`) でデータ放送を出すところ。
 *
 * 22-watch から分けた (あちらが e2e の組の時間の下限になっていた)。偽の録画には
 * データ放送が無いので、どのテストもサイドカー (`.bml.jsonl`) を置いてから出す
 */

/**
 * **「このブラウザでは再生できませんでした」の幕を畳む** (画像で字幕を確かめるテストだけ)。
 * 偽の録画は中身が無く、ブラウザは再生に転んで幕 (`watch-broken`。映像の箱を暗く覆う) を出す。
 * データ放送の小窓に寄せた映像の箱もその下にあるので、塗った字幕が暗く写る。本物の録画では出ない
 */
async function hideBroken(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-testid="watch-broken"] { display: none !important; }',
  });
}

/** 録画のサイドカーにデータ放送を置く */
function placeDataBroadcast(libraryPath: string, script?: string): void {
  writeFileSync(
    `${libraryPath.slice(0, libraryPath.length - extname(libraryPath).length)}.bml.jsonl`,
    `${fakeDataBroadcast(script)
      .map((message) => JSON.stringify({ at: 0, message }))
      .join("\n")}\n`,
  );
}

/**
 * 小窓を持つ既定の BML を置いた録画は**1本を使い回す** (どのテストも同じサイドカーを読むだけ)。
 * 文書を差し替えるテストだけが自分のぶんを録る
 */
let shared: { id: string } | null = null;
async function withDataBroadcast(
  page: Page,
  request: APIRequestContext,
): Promise<string> {
  if (shared === null) {
    const { id, libraryPath } = await recordOne(page, request);
    placeDataBroadcast(libraryPath);
    shared = { id };
  }
  return shared.id;
}

test.describe("録画のデータ放送", () => {
  /**
   * **データ放送を出しても字幕は見えている。テレビと同じで映像と一緒に小窓へ縮む。**
   *
   * 映像の箱ごと BML の小窓へ寄せる。字幕の canvas が箱の外にあった頃は、映像だけ
   * 小窓へ行き、字幕は枠いっぱいのままデータ放送の面の下に隠れていた (実機で「データ放送を
   * 出すと字幕が出なくなる」)。**操作列を出したまま d を押す**
   * (持ち上げた字幕が小窓の中に残らないことも見る)
   */
  test("データ放送を出しても、字幕は映像と一緒に小窓へ縮んで見えている", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await withDataBroadcast(page, request);
    await goto(page, `/watch/${id}`);
    await hideBroken(page);
    await holdMedia(
      page,
      "watch-video",
      "watch-captions-canvas",
      "watch-stage",
    );
    await page
      .getByTestId("watch-captions-canvas")
      .evaluate((el) => el.setAttribute("data-ink", "0.8000,0.9700"));

    await wakeControls(page, "watch-stage");
    // データ放送は ⚙ (再生の設定) の中
    await page.getByTestId("watch-settings").click();
    await page.getByTestId("watch-data").click();
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "ready",
      {
        timeout: 15_000,
      },
    );

    await captionsSeenInDataWindow(page);
  });

  /**
   * **録画の再生中は選局できない。** データ放送の文書が epgTune を
   * 呼んだら失敗を返し、観ている人には「録画の再生中は選局できません」と知らせる
   */
  test("録画のデータ放送が epgTune を呼ぶと、失敗にして知らせる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // 文書を差し替えるので、使い回しの1本は汚さない
    const { id, libraryPath } = await recordOne(page, request);
    placeDataBroadcast(
      libraryPath,
      '<script><![CDATA[function tune() { var r = browser.epgTune("arib://7fe7.-1.428"); document.getElementById("r").firstChild.data = "r:" + r; }]]></script>' +
        '<bevent><beitem type="DataButtonPressed" onoccur="tune();" subscribe="subscribe"/></bevent>' +
        '<p id="r" style="left:0px;top:0px;width:200px;height:30px;"></p>',
    );
    await goto(page, `/watch/${id}`);
    await wakeControls(page, "watch-stage");
    // データ放送は ⚙ (再生の設定) の中
    await page.getByTestId("watch-settings").click();
    await page.getByTestId("watch-data").click();
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "ready",
      {
        timeout: 15_000,
      },
    );
    await expect(page.getByText("録画の再生中は選局できません")).toBeVisible({
      timeout: 15_000,
    });
    // 文書には失敗 (NaN) が返り、後に続く処理も動く
    await expect
      .poll(() =>
        page.evaluate(() => {
          for (const host of document.querySelectorAll(
            '[data-testid="live-data"] div',
          )) {
            const text = host.shadowRoot?.textContent ?? "";
            if (text.includes("r:")) return text.trim();
          }
          return "";
        }),
      )
      .toBe("r:NaN");
  });
});

/**
 * **データ放送を常に受信する端末** (再生の設定。ライブと同じ1つ。`data-receive.ts`)。ライブは 36-bml。
 *
 * 録画でも、開く前から変化ログを流して入口の文書を裏で動かし、文書が自分で出したものは映像に重ねる。
 * リモコン・キー・d は開いてから。文書からの選局は、開くまでは黙って断る (知らせるのは開いているときだけ)
 */
test.describe("録画のデータ放送を常に受信する端末", () => {
  /** 読み込んだときに選局を試し (開く前なので断られる)、d と押されたキーを数える文書 */
  const SCRIPTED = [
    "<script><![CDATA[",
    'var pressed = 0; var log = ""; var tuned = "r:" + browser.epgTune("arib://7fe7.-1.428");',
    "function onData() { pressed++; show(); }",
    'function onKey() { log += "k" + document.currentEvent.keyCode + ","; show(); }',
    'function show() { document.getElementById("msg").firstChild.data = tuned + "|d" + pressed + "|" + log; }',
    "]]></script>",
    '<bevent><beitem type="DataButtonPressed" onoccur="onData();" subscribe="subscribe"/></bevent>',
    '<p id="msg" style="left:0px;top:0px;width:400px;height:40px;nav-index:0;color-index:7;" onkeydown="onKey();">init</p>',
  ].join("\n");

  const text = (page: Page) =>
    page.evaluate(() => {
      for (const host of document.querySelectorAll(
        '[data-testid="live-data"] div',
      )) {
        const found = host.shadowRoot?.querySelector("span");
        if (found) return found.textContent;
      }
      return null;
    });

  test("開く前から流して文書が出したものを重ね、リモコン・キー・d・選局は開いてから", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id, libraryPath } = await recordOne(page, request);
    placeDataBroadcast(libraryPath, SCRIPTED);
    await page.addInitScript(() =>
      localStorage.setItem("player-data-always", "1"),
    );
    await goto(page, `/watch/${id}`);
    const overlay = page.getByTestId("live-data");
    // 押さなくてもエンジンが立ち、文書が出てくる
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    await expect(overlay).toHaveAttribute("data-open", "false");
    await expect(overlay).toHaveAttribute("data-showing", "true", {
      timeout: 15_000,
    });
    await expect.poll(() => text(page), { timeout: 10_000 }).toBe("init");
    // 選局は黙って断る (開くまでは「選局できません」も出さない)
    await expect(page.getByText("録画の再生中は選局できません")).toBeHidden();
    // リモコンは出さず、キーも渡さない
    await expect(page.getByTestId("live-remote")).toBeHidden();
    await page.keyboard.press("b");
    await page.waitForTimeout(500);
    expect(await text(page)).toBe("init");

    // 開くと d が届き、リモコンが出る。エンジンは作り直さない (読み込んだときの選局の答えが残っている)
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-settings").click();
    await page.getByTestId("watch-data").click();
    await expect(overlay).toHaveAttribute("data-open", "true");
    await expect.poll(() => text(page), { timeout: 10_000 }).toBe("r:NaN|d1|");
    await expect(page.getByTestId("live-remote")).toBeVisible();
    await page.keyboard.press("b");
    await expect.poll(() => text(page)).toBe("r:NaN|d1|k21,");
  });

  test("閉じてもエンジンは残す。設定はライブと同じ1つで、切ると畳む", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // d を聞かない文書 (⚙ の「データ放送」で閉じる)
    const id = await withDataBroadcast(page, request);
    await page.addInitScript(() =>
      localStorage.setItem("player-data-always", "1"),
    );
    await goto(page, `/watch/${id}`);
    const overlay = page.getByTestId("live-data");
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-settings").click();
    await page.getByTestId("watch-data").click();
    await expect(page.getByTestId("live-remote")).toBeVisible();
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-settings").click();
    await page.getByTestId("watch-data").click();
    await expect(overlay).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("live-remote")).toBeHidden();
    await expect(overlay).toHaveAttribute("data-state", "ready");

    // ライブと同じ行。切ると畳む
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-settings").click();
    const row = page.getByTestId("watch-data-receive");
    await expect(row).toHaveAttribute("aria-checked", "true");
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "false");
    await expect(overlay).toHaveAttribute("data-state", "off");
    expect(
      await page.evaluate(() => localStorage.getItem("player-data-always")),
    ).toBe("0");
  });
});
/**
 * **字幕は、見えている大きさ × 画面の画素で描く** (`caption-draw.ts` の `CaptionPainter`)。
 * データ放送の小窓の中でも同じ。PC とスマホの素の画面は 22-watch の「字幕をくっきり描く」が見る
 */
test.describe("字幕をくっきり描く (データ放送の小窓)", () => {
  test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });

  test("DPR 2 で、データ放送の小窓の中でも字幕の画素が見えている大きさ × DPR と合う", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await withDataBroadcast(page, request);
    await routeCaptions(page);
    await goto(page, `/watch/${id}`);
    await hideBroken(page);
    await holdMedia(
      page,
      "watch-video",
      "watch-captions-canvas",
      "watch-stage",
    );
    await holdCaptions(page, "watch-captions-canvas");
    await expectSharpCaptions(page, "小窓に入る前");

    await wakeControls(page, "watch-stage");
    // データ放送は ⚙ (再生の設定) の中
    await page.getByTestId("watch-settings").click();
    await page.getByTestId("watch-data").click();
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "ready",
      {
        timeout: 15_000,
      },
    );
    await captionsSeenInDataWindow(page);
    await expectSharpCaptions(page, "データ放送の小窓の中");
  });
});
