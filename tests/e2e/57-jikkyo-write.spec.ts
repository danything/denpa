import type { Page } from "@playwright/test";

import { MX } from "../fake/services";
import {
  expect,
  goto,
  overlayTroubles,
  pickCodec,
  test,
  wakeControls,
} from "./helpers";
import { deviceOn, fakeNx, type Posted, setJikkyo } from "./jikkyo";

/**
 * **ライブで実況に書き込む** (docs/watch.md の「実況」)。NX-Jikkyo へ直に書くときと、ニコニコと連携して
 * denpa のサーバから公式のニコニコ実況へ送るときを見る。偽物の作り方と、テストどうしが状態を当てにしないことは 57-jikkyo の冒頭にある
 */

// ライブは MPEG-2 のまま観る (`pickCodec`)。MPEG-2 をデコードできる端末として開く (`stack.ts` の `liveWithoutMpeg2`)
test.use({ liveMpeg2: true });

/** 書き込みが CSP に止められていないか (読み込む前に控えを仕掛ける) */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen = window as unknown as { __csp: string[] };
    seen.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.__csp.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

/** ライブを MPEG-2 で観て (放送時刻が進むように)、右端の列のボタンでコメントの一覧を開く (下に書き込む 1 行が付く) */
async function openWriting(
  page: Page,
  idle = "NX-Jikkyo に書きます",
): Promise<void> {
  await deviceOn(page);
  await goto(page, `/live?service=${MX.id}`);
  await expect(page.getByTestId("live-title")).toBeVisible();
  await wakeControls(page, "live-frame");
  await pickCodec(page, "live", "mpeg2");
  await wakeControls(page, "live-frame");
  await page.getByTestId("live-jikkyo-list").click();
  await expect(page.getByTestId("jikkyo-list")).toBeVisible();
  await expect(page.getByTestId("jikkyo-compose-input")).toBeFocused();
  // 映像が出て「いま」に追い付くまで
  await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(idle, {
    timeout: 20_000,
  });
}

test.describe("ライブで実況に書き込む", () => {
  test("選んだ色・位置・大きさで送り、すぐ流す。戻ってきた同じものは 2 度流さない", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      const csp = await watchViolations(page);
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page);

      await page.getByTestId("jikkyo-style-button").click();
      await page.getByTestId("jikkyo-color-red").click();
      await page.getByTestId("jikkyo-position-shita").click();
      await page.getByTestId("jikkyo-size-big").click();
      await expect(page.getByTestId("jikkyo-color-red")).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("自分の書き込み");
      await input.press("Enter");
      await expect(input).toHaveValue("");
      expect(nx.posts).toHaveLength(1);
      expect(nx.posts[0]).toMatchObject({
        text: "自分の書き込み",
        isAnonymous: true,
        color: "red",
        position: "shita",
        size: "big",
      });
      expect(nx.posts[0]!.vpos).toBeGreaterThan(0);

      const mine = page.getByTestId("jikkyo-comment");
      await expect(mine).toHaveCount(1);
      await expect(mine).toHaveText("自分の書き込み");
      await expect(mine).toHaveClass(/\bmine\b/);
      await expect(mine).toHaveCSS("color", "rgb(255, 0, 0)");
      // 下に止める (枠の下半分)
      const frame = (await page.getByTestId("jikkyo-layer").boundingBox())!;
      const box = (await mine.boundingBox())!;
      expect(box.y - frame.y).toBeGreaterThan(frame.height / 2);
      // 戻ってきた yourpost のものは流さない
      await page.waitForTimeout(1_000);
      await expect(mine).toHaveCount(1);

      // 3 秒空けないと送らない
      await input.fill("続けて");
      await input.press("Enter");
      await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
        "3 秒待ってください",
      );
      await expect(input).toHaveValue("続けて");
      expect(nx.posts).toHaveLength(1);

      // 一覧の中なので ✕ は無い (しまうのは右端の列のボタン)
      await expect(page.getByTestId("jikkyo-compose-close")).toHaveCount(0);
      // 選んだものは端末ごとに覚える。覚えていた一覧で開いたときは、入力欄へフォーカスを移さない
      await page.reload();
      await page.locator('[data-hydrated="true"]').waitFor();
      await expect(page.getByTestId("jikkyo-compose-input")).toBeVisible();
      await expect(page.getByTestId("jikkyo-compose-input")).not.toBeFocused();
      await page.getByTestId("jikkyo-style-button").click();
      await expect(page.getByTestId("jikkyo-position-shita")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await csp()).toEqual([]);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("受け付けられなければ、理由を 1 行で出して本文を残す。Esc で一覧ごとしまう", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true, reply: () => "INVALID_MESSAGE" });
      await openWriting(page);
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("断られる書き込み");
      await page.getByTestId("jikkyo-compose-send").click();
      await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
        "この書き込みは受け付けられませんでした",
      );
      await expect(input).toHaveValue("断られる書き込み");
      await expect(page.getByTestId("jikkyo-comment")).toHaveCount(0);
      // 番組の中身を開いて列を入れ替えても、書きかけは残る
      await page.getByTestId("live-channel-detail").first().click();
      await expect(page.getByTestId("live-detail")).toBeVisible();
      await expect(input).toHaveValue("断られる書き込み");
      await page.getByTestId("live-detail-close").click();
      await expect(input).toHaveValue("断られる書き込み");
      await input.press("Escape");
      await expect(page.getByTestId("jikkyo-list")).toHaveCount(0);
      await expect(page.getByTestId("jikkyo-compose")).toHaveCount(0);
      await expect(page.getByTestId("live-jikkyo-list")).toBeFocused();
    } finally {
      await setJikkyo(page, false);
    }
  });

  /*
   * 色・位置・大きさは種別のタブと同じ並び (`.segmented`)。選んでいるものの見た目はどのまとまりでも同じで、塗らない。
   * 色の 8 つは列の幅に入らないので、4 つずつ 2 行にそろえる (6 と 2 に崩さない)
   */
  test("色・位置・大きさの選んでいるものは同じ見た目で、色は 4 つずつ並ぶ", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true });
      await openWriting(page);
      await page.getByTestId("jikkyo-style-button").click();
      await page.getByTestId("jikkyo-color-red").click();
      await page.getByTestId("jikkyo-position-shita").click();
      await page.getByTestId("jikkyo-size-big").click();
      // 押したものに乗せたままだと、指を乗せた地が出る。外してから比べる
      await page.mouse.move(0, 0);
      const look = (id: string) =>
        page.getByTestId(id).evaluate((el) => {
          const style = getComputedStyle(el);
          const group = el.parentElement!;
          return {
            color: style.color,
            weight: style.fontWeight,
            background: style.backgroundColor,
            // 下線は並びの 1 本 (アンカーで選んでいるものに付く)
            line: getComputedStyle(group, "::after").height,
          };
        });
      const color = await look("jikkyo-color-red");
      expect(await look("jikkyo-position-shita")).toEqual(color);
      expect(await look("jikkyo-size-big")).toEqual(color);
      expect(color.background).toBe("rgba(0, 0, 0, 0)");
      expect(color.line).toBe("2px");
      // 選んでいないものは本文の字
      const plain = await page
        .getByTestId("jikkyo-size-small")
        .evaluate((el) => getComputedStyle(el).fontWeight);
      expect(plain).not.toBe(color.weight);

      const rows = await page
        .getByTestId("jikkyo-style")
        .locator('[data-testid^="jikkyo-color-"]')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
      expect(new Set(rows).size).toBe(2);
      expect(rows.filter((y) => y === rows[0])).toHaveLength(4);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("変換中の Enter では送らない", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page);
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("へんかんちゅう");
      await input.evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await page.waitForTimeout(500);
      expect(nx.posts).toHaveLength(0);
      await expect(input).toHaveValue("へんかんちゅう");
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("止めていると書けない", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page);
      await page.getByTestId("live-play").click();
      const line = page.getByTestId("jikkyo-compose-line");
      await expect(line).toHaveText("ライブに戻ると書けます");
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("止めたまま");
      await input.press("Enter");
      await expect(line).toHaveText("ライブに戻ると書けます");
      expect(nx.posts).toHaveLength(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("全画面では一覧を出せないので、同じボタンで操作バーのすぐ上に 1 行を開く。開いている間は操作バーを引っ込めない", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page, { quiet: true });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-full").click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null))
        .toBe(true);
      await wakeControls(page, "live-frame");
      const button = page.getByTestId("live-jikkyo-list");
      await expect(button).toHaveAttribute("aria-label", "実況に書く");
      await button.click();
      await expect(page.getByTestId("jikkyo-list")).toHaveCount(0);
      const input = page.getByTestId("jikkyo-compose-input");
      await expect(input).toBeFocused();
      // 操作バーのすぐ上 (映像の中)
      const compose = (await page.getByTestId("jikkyo-compose").boundingBox())!;
      const seek = (await page.getByTestId("live-play").boundingBox())!;
      expect(compose.y + compose.height).toBeLessThanOrEqual(seek.y);
      await page.waitForTimeout(3_000);
      await expect(page.getByTestId("live-controls")).toHaveAttribute(
        "data-shown",
        "true",
      );
      await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
        "NX-Jikkyo に書きます",
        { timeout: 20_000 },
      );
      await input.fill("全画面から");
      await input.press("Enter");
      await expect(input).toHaveValue("");
      expect(nx.posts.map((p) => p.text)).toEqual(["全画面から"]);
      await page.getByTestId("jikkyo-compose-close").click();
      await expect(page.getByTestId("jikkyo-compose")).toHaveCount(0);
      await expect(button).toBeFocused();
    } finally {
      await page.evaluate(
        () => document.fullscreenElement && document.exitFullscreen(),
      );
      await setJikkyo(page, false);
    }
  });

  /*
   * 実況のボタンで右端の縦の列が 4 つになる。スマホの縦の低い枠では、列を下の操作バーの上で止め、
   * 入りきらないものを左へもう 1 列に並べる (丸は縮めない。全画面のボタンに重ねない)
   */
  test("スマホの縦でも、右端の列は下の操作バーに重ならない", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true });
      await deviceOn(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await goto(page, `/live?service=${MX.id}`);
      // シークバーはエンコードしたもの (AV1) にだけある
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "av1");
      await wakeControls(page, "live-frame");
      const write = page.getByTestId("live-jikkyo-list");
      await expect(write).toBeVisible();
      await expect(page.getByTestId("live-seek")).toBeVisible();
      expect(await overlayTroubles(page, "live-frame")).toEqual([]);

      const record = (await page.getByTestId("live-record").boundingBox())!;
      const jikkyo = (await write.boundingBox())!;
      const seek = (await page.getByTestId("live-seek").boundingBox())!;
      // 丸は 40px のまま。右の縁の列はそのままで、実況のボタンはその左に
      expect(jikkyo.width).toBe(40);
      expect(jikkyo.height).toBe(40);
      expect(jikkyo.x + jikkyo.width).toBeLessThanOrEqual(record.x);
      for (const id of ["live-record", "live-data-button", "live-shot"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x).toBe(record.x);
        // 再生位置のバーにも掛からない
        expect(box.y + box.height).toBeLessThanOrEqual(seek.y);
      }
    } finally {
      await setJikkyo(page, false);
    }
  });
});

/** 設定の「連携」の「実況」から、偽の denpa-hub でニコニコと連携する (60-niconico と同じ流れ) */
async function linkNiconico(page: Page): Promise<void> {
  await goto(page, "/settings/integrations#jikkyo");
  await page.getByTestId("niconico-link").click();
  await page.waitForURL(/\/settings\/integrations#jikkyo$/);
  await expect(page.getByTestId("niconico-state")).toContainText("連携中");
}

async function unlinkNiconico(page: Page): Promise<void> {
  await goto(page, "/settings/integrations#jikkyo");
  const unlink = page.getByTestId("niconico-unlink");
  // 外すのは 2 回押し (`ArmedDelete`)
  if ((await unlink.count()) > 0) {
    await unlink.click();
    await page.getByTestId("niconico-unlink-confirm").click();
  }
  await expect(page.getByTestId("niconico-link")).toBeVisible();
}

test.describe("ニコニコと連携しているときの書き込み", () => {
  test("公式のニコニコ実況へ denpa のサーバから送り、すぐ流す。NX-Jikkyo が取り込んで流してきた同じものは 2 度流さない", async ({
    page,
    request,
    stack,
  }) => {
    await setJikkyo(page, true);
    try {
      await linkNiconico(page);
      const csp = await watchViolations(page);
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page, "ニコニコ実況に書きます");

      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("公式への書き込み");
      await input.press("Enter");
      await expect(input).toHaveValue("");
      // NX-Jikkyo には送らず、denpa のサーバが偽の視聴の WebSocket へ送る (いつも 184)
      expect(nx.posts).toHaveLength(0);
      const state = (await (
        await request.get(`${stack.hubUrl}/__control/state`)
      ).json()) as { posts: Posted[]; watched: string[] };
      expect(state.watched).toContain("jk9");
      expect(state.posts.at(-1)).toMatchObject({
        text: "公式への書き込み",
        isAnonymous: true,
      });

      await expect(
        page
          .getByTestId("jikkyo-comment")
          .filter({ hasText: "公式への書き込み" }),
      ).toHaveClass(/\bmine\b/);
      // 流れ終わっても残る一覧で数える
      const comments = page.getByTestId("jikkyo-list-row");
      const mine = comments.filter({ hasText: "公式への書き込み" });
      await expect(mine).toHaveCount(1);
      // NX-Jikkyo が取り込んで流してきた同じ本文は流さない (ほかの人の書き込みは流れる)
      nx.emit("公式への書き込み");
      nx.emit("ほかの人の書き込み", [-5_000, 0, 5_000, 10_000, 20_000]);
      await expect(
        comments.filter({ hasText: "ほかの人の書き込み" }).first(),
      ).toBeVisible({ timeout: 25_000 });
      await page.waitForTimeout(1_000);
      await expect(mine).toHaveCount(1);
      // 端末は外 (ニコニコ) へ繋がない
      expect(await csp()).toEqual([]);
    } finally {
      await unlinkNiconico(page);
      await setJikkyo(page, false);
    }
  });

  test("連携が切れていたら、連携し直すよう 1 行で出す", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      await linkNiconico(page);
      await fakeNx(page, { quiet: true });
      await openWriting(page, "ニコニコ実況に書きます");
      // 開いたまま、別のタブで連携を外す
      const other = await page.context().newPage();
      await unlinkNiconico(other);
      await other.close();
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("届かない書き込み");
      await input.press("Enter");
      await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
        "ニコニコとの連携が切れました。設定の「連携」で連携し直してください",
      );
      await expect(input).toHaveValue("届かない書き込み");
    } finally {
      await unlinkNiconico(page);
      await setJikkyo(page, false);
    }
  });
});
