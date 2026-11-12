import {
  captionsClearOfBar,
  expect,
  flipSetting,
  goto,
  leaveFullscreen,
  liveWithoutMpeg2,
  oneRowTroubles,
  overlayTroubles,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";
import { sameBox } from "./live";

/**
 * ライブ視聴の操作バー・小窓・全画面・バックグラウンド再生と、スマホの向き。
 * 偽 ffmpeg で確かめる範囲と、ほかのライブ視聴のスペックとの分け方は [20-live.spec.ts](20-live.spec.ts) の冒頭にある
 */
test.describe("ライブ視聴", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  /*
   * **しばらく触らなければ消える。** 映像の上に居座るものなので、見ている間は
   * 引っ込んでいるほうがいい。**止めていても消えます** — 一時停止するのは
   * 映像の中の文字をじっくり見るためで、そこに操作バーが残っていては止めた意味が無い
   */
  test("操作バーは触らないでいると消え、動かすと戻る", async ({ page }) => {
    await goto(page, "/live");
    const controls = page.getByTestId("live-controls");
    await expect(controls).toHaveAttribute("data-shown", "true");

    await page.mouse.move(400, 300);
    await expect(controls).toHaveAttribute("data-shown", "true");
    await expect(controls).toHaveAttribute("data-shown", "false", {
      timeout: 6000,
    });
    await page.mouse.move(420, 320);
    await expect(controls).toHaveAttribute("data-shown", "true");

    // 止めていても消える。押した直後は出ている (押したものが見えないと困る)
    await page.getByTestId("live-play").click();
    await expect(controls).toHaveAttribute("data-shown", "true");
    await expect(controls, "止めていても放っておけば消える").toHaveAttribute(
      "data-shown",
      "false",
      {
        timeout: 6000,
      },
    );
  });

  /*
   * **指で触ったら出て、離してもその場では消えない。消えるのはマウスと同じ長さ。**
   *
   * 指を離すとブラウザはポインタを取り下げるので、`pointerleave` が**触った
   * 直後に必ず飛ぶ**。マウスと同じに「出ていったら消す」で扱っていたので、
   * タッチの端末では**触った瞬間に操作バーが消えて**いた — 操作バーに触れる間が無い。
   *
   * 押すまで留めていた時期もあるが、**消したいときに毎回映像を押すことになった**。
   * 出し方は指とマウスで違ってよいが、消え方は同じでいい
   */
  test("指で触ったら出て、しばらくで消える (マウスと同じ長さ)", async ({
    browser,
  }) => {
    // 指のある端末として開く。既定の枠にはタッチが無く、tap そのものが使えない
    const context = await browser.newContext({ hasTouch: true });
    await liveWithoutMpeg2(context);
    const page = await context.newPage();
    await goto(page, "/live");
    const controls = page.getByTestId("live-controls");
    // いったん消えるまで待つ。出たままのところから始めると何も分からない
    await expect(controls).toHaveAttribute("data-shown", "false", {
      timeout: 6000,
    });

    const box = (await page.getByTestId("live-video").boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.touchscreen.tap(at.x, at.y);

    // 指を離したあとも出ている。ここが直る前は、離した時点で消えていた
    await expect(controls).toHaveAttribute("data-shown", "true");
    // そのまま置いておけば、マウスと同じ 2.5 秒で引っ込む
    await expect(controls, "指でも放っておけば消える").toHaveAttribute(
      "data-shown",
      "false",
      {
        timeout: 6000,
      },
    );
    await context.close();
  });

  /*
   * 止める・再開するの繋がりだけ見る。
   *
   * **「止めた所から見られる」ところまでは、ここでは確かめられない。** 偽の
   * ffmpeg が流すものは MSE が受け取れないので、そもそも再生が始まらず、
   * 位置も動かない。動く中身での確認は実機で行う
   */
  test("止める・再開するが繋がっている", async ({ page }) => {
    await goto(page, "/live");
    const button = page.getByTestId("live-play");
    await expect(button).toBeVisible();

    await expect(button).toHaveAttribute("aria-label", "一時停止");
    await button.click();
    await expect(button).toHaveAttribute("aria-label", "再生");
    await button.click();
    await expect(button).toHaveAttribute("aria-label", "一時停止");
  });

  /*
   * **小窓 (PiP) で観られる。小窓で押した止める・再開は操作バーにも写る。**
   *
   * 小窓の再生ボタンは `<video>` を直に止めるが、ライブは「止めているか」を player 側で
   * 持っている (`live-player` の `paused`)。合わせないと、小窓で止めたのに操作バーは
   * 「一時停止」のまま、押すと止まっている映像をもう一度止めることになる。
   *
   * 偽の ffmpeg が流すものは MSE が受け取れず再生が始まらない (上) ので、ブラウザの
   * 小窓の API は差し替えて、押された・出た・閉じたの繋がりだけを見る
   */
  test("小窓で観られ、小窓で止めると操作バーも止まる", async ({ page }) => {
    await page.addInitScript(() => {
      let shown: Element | null = null;
      Object.defineProperty(Document.prototype, "pictureInPictureEnabled", {
        get: () => true,
      });
      Object.defineProperty(Document.prototype, "pictureInPictureElement", {
        get: () => shown,
      });
      HTMLVideoElement.prototype.requestPictureInPicture = async function () {
        shown = this;
        this.dispatchEvent(new Event("enterpictureinpicture"));
        return {} as PictureInPictureWindow;
      };
      Document.prototype.exitPictureInPicture = async () => {
        const was = shown;
        shown = null;
        was?.dispatchEvent(new Event("leavepictureinpicture"));
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await wakeControls(page, "live-frame");
    const pip = page.getByTestId("live-pip");
    await expect(pip).toHaveAttribute("aria-label", "小窓で観る");
    await pip.click();
    await expect(pip).toHaveAttribute("aria-pressed", "true");
    await expect(pip).toHaveAttribute("aria-label", "小窓をやめる");
    // 小窓の間は舞台の映像と字幕を隠し、同じ映像を 2 か所で描かない
    await expect(page.getByTestId("live-video")).toBeHidden();
    await expect(page.getByTestId("live-frame-pip-note")).toBeVisible();
    expect(
      await page
        .getByTestId("live-video")
        .evaluate((v) => document.pictureInPictureElement === v),
    ).toBe(true);

    // 小窓の再生ボタンで止める・再開する (`<video>` が直に止まり、`pause` / `play` が来る)
    const play = page.getByTestId("live-play");
    const press = (paused: boolean) =>
      page.getByTestId("live-video").evaluate((v, paused) => {
        Object.defineProperty(v, "paused", {
          configurable: true,
          get: () => paused,
        });
        v.dispatchEvent(new Event(paused ? "pause" : "play"));
      }, paused);
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await press(true);
    await expect(play).toHaveAttribute("aria-label", "再生");
    await press(false);
    await expect(play).toHaveAttribute("aria-label", "一時停止");

    await wakeControls(page, "live-frame");
    await pip.click();
    await expect(pip).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("live-video")).toBeVisible();
    await expect(page.getByTestId("live-frame-pip-note")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.pictureInPictureElement),
    ).toBeNull();
  });

  /*
   * **断られたら理由を出す。** 黙って何も起きないと、どこで転んだのか端末の上で
   * 見分けられない (iPhone の Safari で、MPEG-2 のときだけ出なかった)
   */
  test("小窓を断られたら、理由をトーストで言う", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Document.prototype, "pictureInPictureEnabled", {
        get: () => true,
      });
      HTMLVideoElement.prototype.requestPictureInPicture = async () => {
        throw new DOMException("ユーザーの操作が要る", "NotAllowedError");
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await wakeControls(page, "live-frame");
    await page.getByTestId("live-pip").click();
    await expect(
      page.getByText(
        "小窓を出せませんでした: ブラウザに許可されませんでした (NotAllowedError",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("live-pip")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /*
   * **出せない端末ではボタンを出さない。** iPhone・iPad のホーム画面から開いたもの (PWA) は、
   * API は有るように見えるのに Safari が小窓を許していない。ページから開かせる API の無いブラウザも出さない
   * (ブラウザ自身の小窓の切り替えは別に使える)
   */
  test("小窓を出せない端末では、小窓のボタンを出さない", async ({
    browser,
  }) => {
    for (const script of [
      // iPhone のホーム画面から開いた
      () =>
        Object.defineProperty(Navigator.prototype, "standalone", {
          get: () => true,
        }),
      // ページから開かせる API が無い
      () =>
        Object.defineProperty(Document.prototype, "pictureInPictureEnabled", {
          get: () => false,
        }),
    ]) {
      const context = await browser.newContext();
      await liveWithoutMpeg2(context);
      const page = await context.newPage();
      await page.addInitScript(script);
      await goto(page, "/live");
      await expect(page.getByTestId("live-full")).toBeVisible();
      await expect(page.getByTestId("live-pip")).toHaveCount(0);
      await context.close();
    }
  });

  /*
   * **iPhone の全画面は、枠を画面いっぱいに広げて代わりにする** (#471。`fullscreen.svelte.ts`)。
   * 要素の全画面の API を消して iPhone の横持ち (844x390) に見立てる。字幕の面とデータ放送の
   * 入れ物は枠から測るので、広げても映像に重なったまま。出口は同じボタン・Esc・戻る
   */
  test("全画面の API が無い端末では、枠を画面いっぱいに広げる", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      // iPhone の横持ち (指の端末。下のタブは映像の画面では隠れる)
      hasTouch: true,
      isMobile: true,
    });
    await liveWithoutMpeg2(context);
    const page = await context.newPage();
    await page.addInitScript(() => {
      for (const proto of [Element.prototype, HTMLElement.prototype]) {
        delete (proto as Partial<Element>).requestFullscreen;
        delete (proto as { webkitRequestFullscreen?: unknown })
          .webkitRequestFullscreen;
      }
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const stage = page.getByTestId("live-frame");
    const full = page.getByTestId("live-full");
    const enter = async () => {
      await wakeControls(page, "live-frame");
      await full.click();
      await expect(stage).toHaveAttribute("data-pseudo", "");
      await expect
        .poll(() => stage.boundingBox())
        .toEqual({ x: 0, y: 0, width: 844, height: 390 });
      await expect(page.locator("html")).toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面をやめる");
    };
    const restored = async () => {
      await expect(stage).not.toHaveAttribute("data-pseudo", "");
      await expect
        .poll(async () => (await stage.boundingBox())?.width)
        .toBeLessThan(844);
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面");
      await expect(page).toHaveURL(/\/live/);
    };

    await enter();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    // 字幕の面は映像と同じ枠、映像は枠いっぱい。操作バーは画面の中
    await sameBox(
      page.getByTestId("live-captions"),
      page.getByTestId("live-video"),
    );
    expect(await page.getByTestId("live-video").boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: 844,
      height: 390,
    });
    await wakeControls(page, "live-frame");
    const bar = (await full.boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(390);

    // 同じボタンで出る
    await wakeControls(page, "live-frame");
    await full.click();
    await restored();

    // Esc で出る
    await enter();
    await page.keyboard.press("Escape");
    await restored();

    // 戻るで出る。画面は離れない
    await enter();
    await page.evaluate(() => history.back());
    await restored();
    await context.close();
  });

  /*
   * **バックグラウンド再生は既定で切。** 裏に回すと止め、戻ると再開する。OS が勝手に小窓に
   * しないよう `disablePictureInPicture` も立てておく (全画面からホームへ戻っただけで小窓が
   * 出て鳴り続けていた)。入れれば裏でも止めず、端末ごとに覚える (`background.svelte.ts`)。
   *
   * 裏に回るのはページの外の出来事なので、`visibilityState` を差し替えて通知だけ送る
   */
  test("バックグラウンド再生は既定で切。裏に回すと止まり、入れると止まらない", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const turn = (state: "hidden" | "visible") =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => state,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    const guarded = () =>
      page
        .getByTestId("live-video")
        .evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture);
    const play = page.getByTestId("live-play");

    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect.poll(guarded).toBe(true);
    await turn("hidden");
    await expect(play).toHaveAttribute("aria-label", "再生");
    await turn("visible");
    await expect(play).toHaveAttribute("aria-label", "一時停止");

    await wakeControls(page, "live-frame");
    const toggle = page.getByTestId("live-background");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await flipSetting(page, "live", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(guarded).toBe(false);
    await turn("hidden");
    // 止まらない (止めるなら通知を受けたその場で止めている)
    await page.waitForTimeout(500);
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await turn("visible");

    // 端末ごとに覚える。開き直しても入のまま
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await expect(page.getByTestId("live-background")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  /*
   * **放送に終わりは無いと言っておく。** 何も言わないと MediaSource の尺は
   * 「いま持っている中でいちばん後ろ」になり、0.2 秒ごとに中身が届くたびに
   * 伸びる。備え付けの再生位置が右端まで行っては少し左へ戻る、を繰り返す
   */
  test("再生位置に終わりを作らない", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await expect(async () => {
      const duration = await page
        .getByTestId("live-video")
        .evaluate((v) => (v as HTMLVideoElement).duration);
      expect(duration).toBe(Number.POSITIVE_INFINITY);
    }).toPass({ timeout: 15_000 });
  });
});

/**
 * **横にしたスマホでは映像を画面いっぱいに** (`PlayerLayout`)。見出しと右の一覧を残すと
 * 映像の枠が 510x280 ほどしか無く、操作バーが二段に折れてシークバーが映像の真ん中に来ていた。
 * 一覧は消さずに映像の下へ回す — 消すと局を選べなくなる
 */
test.describe("スマホの横でライブ", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });

  test("見出しを隠して映像が画面の高さいっぱい。操作バーは一段、一覧は下で選べる", async ({
    page,
  }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await channels.first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const stage = page.getByTestId("live-frame");
    await expect(page.locator(".navbar")).toBeHidden();
    // 横にしたスマホもスマホの形 (1000px 未満) だが、下のタブは映像の下端に重なるので出さない
    await expect(page.getByTestId("tabbar")).toBeHidden();
    // 枠は映像の形 (16:9) で、高さいっぱい・真ん中。左右の黒帯にボタンを出さない
    await expect
      .poll(async () => {
        const box = await stage.boundingBox();
        return box === null
          ? null
          : [
              Math.round(box.x),
              Math.round(box.y),
              Math.round(box.width),
              Math.round(box.height),
            ];
      })
      .toEqual([75, 0, 693, 390]);

    const bar = page.getByTestId("live-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      await page.touchscreen.tap(422, 195);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");
    const play = (await page.getByTestId("live-play").boundingBox())!;
    const full = (await page.getByTestId("live-full").boundingBox())!;
    expect(Math.abs(play.y - full.y)).toBeLessThan(2);
    // どのボタンも重ならず、映像の枠の中に丸ごと見える (右上の 3 つも)
    expect(await overlayTroubles(page, "live-frame")).toEqual([]);
    // 操作バーは映像に重ねるので、下の方の字幕は操作バーの上まで持ち上がる。操作バーが引っ込めば戻る
    await captionsClearOfBar(page, "live-captions", "live-controls");
    await expect(bar).toHaveAttribute("data-shown", "false", { timeout: 6000 });
    await expect(page.getByTestId("live-captions")).toHaveCSS(
      "translate",
      "none",
    );

    // 一覧は映像の下。巻き取って別の局を選べ、選んだら映像へ戻る
    const second = channels.nth(1);
    await second.scrollIntoViewIfNeeded();
    await expect(stage).not.toBeInViewport({ ratio: 0.9 });
    await second.tap();
    await expect(second).toHaveAttribute("data-current", "true");
    await expect(stage).toBeInViewport({ ratio: 0.9 });

    // 戻る動きは CSS (巻く外枠の `scroll-behavior`)。動かさない設定 (E2E の既定) ではすぐ、動かしてよい端末では滑って戻る
    const layout = page.locator("[data-player-layout]");
    await expect(layout).toHaveCSS("scroll-behavior", "auto");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(layout).toHaveCSS("scroll-behavior", "smooth");
    const first = channels.first();
    await first.scrollIntoViewIfNeeded();
    await expect(stage).not.toBeInViewport({ ratio: 0.9 });
    await first.tap();
    await expect(first).toHaveAttribute("data-current", "true");
    await expect(stage).toBeInViewport({ ratio: 0.9 });
    // 着く位置は前と同じ (映像の上の端)
    await expect.poll(() => layout.evaluate((el) => el.scrollTop)).toBe(0);
  });
});

/**
 * **スマホの縦 (360px・320px) でも、操作バーのボタンは 1 行。** 残すのは再生・ライブ・読みもの・全画面と
 * ⚙ だけ。音・速さ・小窓などは ⚙ の先頭に畳み、そこから押せる
 */
test.describe("スマホの縦でライブ", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 360, height: 780 },
  });

  /*
   * **映像は本文の上の端から始まる** (390x844)。ほかの画面のように 0.5rem 空けると、映像の上に暗い帯が見えた。
   * テストでは上の安全域は 0 なので、映像の上の端は 0
   */
  test("映像の上に隙間を空けない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-play")).toBeVisible();
    await leaveFullscreen(page);
    const top = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const content =
        main.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(main).paddingTop);
      const stage = document
        .querySelector('[data-testid="live-frame"]')!
        .getBoundingClientRect();
      return { content, stage: stage.top };
    });
    expect(top).toEqual({ content: 0, stage: 0 });
  });

  test("幅 360px・320px でも操作バーのボタンは 1 行で、畳んだ音は ⚙ から押せる", async ({
    page,
  }) => {
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 780 });
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-play")).toBeVisible();
      await leaveFullscreen(page);
      await expect(page.getByTestId("live-frame")).toHaveAttribute(
        "data-narrow",
        "",
      );

      expect(await oneRowTroubles(page, "live-buttons"), `${width}px`).toEqual(
        [],
      );
      await expect(page.getByTestId("live-edge")).toBeVisible();
      await expect(page.getByTestId("live-full")).toBeVisible();
      // 再生の設定 (⚙) は畳まない
      await expect(page.getByTestId("live-settings")).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`live-${width}.png`),
      });

      // 畳んだ音は ⚙ の先頭の「消音」の行。「ほか」(⋯) のボタンはもう無い
      const sound = page.getByTestId("live-sound");
      await expect(sound).toBeHidden();
      await expect(page.getByTestId("live-more")).toHaveCount(0);
      const label = (await sound.getAttribute("aria-label")) ?? "";
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-settings").tap();
      const mute = page.getByTestId("live-mute");
      await expect(mute).toBeVisible();
      await expect(mute).toHaveAttribute("role", "menuitemcheckbox");
      const muted = (await mute.getAttribute("aria-checked")) ?? "";
      await mute.tap();
      await expect(mute).not.toHaveAttribute("aria-checked", muted);
      await expect(sound).not.toHaveAttribute("aria-label", label);
      await page.screenshot({
        path: test.info().outputPath(`live-${width}-more.png`),
      });

      // 閉じても 1 行のまま
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("live-settings-menu")).toBeHidden();
      expect(
        await oneRowTroubles(page, "live-buttons"),
        `${width}px (閉じたあと)`,
      ).toEqual([]);

      // メニュー (再生の設定のコーデック) の外を押しても閉じるだけ。押した局には替わらない (もう一度押せば替わる)
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-settings").tap();
      await page.getByTestId("live-codec").tap();
      await expect(page.getByTestId("live-codec-option").first()).toBeVisible();
      const codecMenu = page.getByTestId("live-settings-menu");
      await expect(codecMenu).toBeVisible();
      const other = page.getByTestId("live-channel").nth(1);
      await other.tap();
      await expect(codecMenu).toBeHidden();
      await expect(other).not.toHaveAttribute("data-current", "true");
      await other.tap();
      await expect(other).toHaveAttribute("data-current", "true");
    }
  });
});
