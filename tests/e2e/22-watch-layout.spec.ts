import {
  captionsClearOfBar,
  expect,
  expectSideAligned,
  expectSideFrame,
  flipSetting,
  goto,
  leaveFullscreen,
  oneRowTroubles,
  overlayTroubles,
  test,
  wakeControls,
} from "./helpers";
import { sharedRecording } from "./watch";

/**
 * 録画をブラウザで観る画面 (`/watch/<id>`) のうち、再生の操作 (残り時間・速さ・続き・バックグラウンド再生) と
 * 画面の並び。スマホの縦と横、指、iPhone の全画面もここで見る。
 *
 * 22-watch から分けた (1 本で 1 分を超えていた)。映像が出るところまでは見ない
 * (偽 ffmpeg が置くのは中身の無いファイルで、ブラウザは読めない)。見るのは画面の作りのほう
 */

/** どのテストも録画を消さないので、**1 本の録画を使い回す** (`sharedRecording`) */
const watchable = sharedRecording();

test.describe("録画を観る", () => {
  /** 残りは「あと何分で終わるか」。**倍速のぶんは割る** */
  test("残り時間も出て、倍速のぶんは割る", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    const clock = page.getByTestId("watch-clock");
    await expect(clock).toContainText("残り");
  });

  /** 早送りはライブの追っかけと同じ並び (`ts/pacing` の `SPEEDS`) */
  test("速さを選べる", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    // 等速のボタンはメーターのアイコンだけ (数字は出さない)。速めるとアイコンをやめて数字だけ、読み上げは速さも
    const speed = page.getByTestId("watch-speed");
    await expect(speed).toHaveText("");
    await expect(speed.locator("svg")).toHaveCount(1);
    await expect(speed).toHaveAccessibleName("再生の速さ");
    // メニューの引き金なので、押されているかではなく開いているかを言う (速さは名前が言う)
    await expect(speed).not.toHaveAttribute("aria-pressed");
    await expect(speed).toHaveAttribute("aria-haspopup", "menu");
    await expect(speed).toHaveAttribute("aria-expanded", "false");
    await speed.click();
    await page
      .getByTestId("watch-speed-option")
      .filter({ hasText: "×1.5" })
      .click();
    await expect(speed).toHaveText("1.5");
    await expect(speed.locator("svg")).toHaveCount(0);
    await expect(speed).toHaveAccessibleName("再生の速さ 1.5 倍");
    await expect(speed).not.toHaveAttribute("aria-pressed");
    // 選んだ速さは覚える。開き直しても同じ速さで始まる
    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-speed")).toHaveText("1.5");
    expect(
      await page
        .getByTestId("watch-video")
        .evaluate((v) => (v as HTMLVideoElement).playbackRate),
    ).toBe(1.5);
    // 読み直しても (src の入れ替えと同じ) 1 倍に戻る瞬間が無い。`loadstart` を待たずに見る
    expect(
      await page.getByTestId("watch-video").evaluate((v) => {
        const video = v as HTMLVideoElement;
        video.load();
        return video.playbackRate;
      }),
    ).toBe(1.5);
  });

  /**
   * **どこまで観たかを覚える。** 端末ではなく DB に置くので、別の端末でも続く。
   *
   * ここで見るのは「覚える・覚えない」の判断まで。**映像は出ません** —
   * 偽 ffmpeg が置くのは中身の無いファイルで、位置を戻すところまでは行けない
   * (戻す判断は `ts/watch.test.ts` が持っている)
   */
  test("途中で止めたところを覚え、観終えたら忘れる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    const put = async (at: number, length: number) => {
      const res = await request.post(`/api/recordings/${id}/resume`, {
        data: { at, length },
      });
      expect(res.ok()).toBe(true);
      return (await res.json()).resume;
    };

    const watchedAt = async () => {
      const list: { id: number; watchedAt: number | null }[] = await (
        await request.get("/api/recordings")
      ).json();
      return list.find((rec) => String(rec.id) === id)?.watchedAt;
    };

    expect(await put(600, 1800)).toBe(600);
    // 途中ではまだ観終えていない (一覧の「未視聴」は進捗バーに替わるだけ)
    expect(await watchedAt()).toBeNull();
    // 末尾まで観たものは忘れる。覚えるとエンドロールから始まってしまう
    expect(await put(1790, 1800)).toBeNull();
    // 代わりに観終えた時刻が入る (一覧の「未視聴」の印が外れる)
    expect(await watchedAt()).toEqual(expect.any(Number));

    // 詳細の「その他…」から未視聴に戻すと、一覧に点が戻る
    await goto(page, "/");
    const row = page.locator(
      `[data-testid="recording-row"][data-recording-id="${id}"]`,
    );
    await expect(row.getByTestId("recording-unwatched")).toHaveCount(0);
    await row.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    await detail.getByTestId("detail-more").click();
    await expect(detail.getByTestId("watched-button")).toHaveText(
      "未視聴に戻す",
    );
    await detail.getByTestId("watched-button").click();
    await expect(row.getByTestId("recording-unwatched")).toHaveCount(1);
    expect(await watchedAt()).toBeNull();
  });

  /**
   * **番組の中身は右に全部出す。モーダルにしない** — 映像の上に被さると
   * 観ながら読めない。長ければそこだけが巻き取られる
   */
  test("詳細は右に出たまま", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-facts")).toBeVisible();
    // 押さなくても出ている。詳細のモーダルは開かない
    await expect(page.getByTestId("program-detail")).toHaveCount(0);
  });

  /**
   * **レイアウトはライブと同じ。** 映像が左、読むものが右で、右は**画面の残りをぜんぶ**
   * 使う。ページごとは動かない。
   *
   * 周りの余白を自分でも足していた頃は、外の `<main>` のぶんと重なって
   * **他の画面より内側から始まり**、足したぶんだけ縦がはみ出して
   * ページごとスクロールバーが出ていた。詳細の高さは**映像に揃えていた** —
   * そのためだけに `absolute` で浮かせる作りをここだけ抱えていたうえ、
   * 縦長の画面では下に余りがあるのに説明だけ狭い窓から覗くことになっていた
   */
  test("右は画面の残りをぜんぶ使い、ページごとは動かない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await page.setViewportSize({ width: 1920, height: 960 });

    /*
     * **周りの余白は他の画面と同じ。** 外の `<main>` が持っているぶんだけで、
     * ここでは足さない・頭打ちにもしない。広い画面で中央に寄せていた頃は、
     * 左右だけ他より広かった
     */
    const edge = async (): Promise<number> =>
      page.evaluate(() => {
        const box = document.querySelector("main")?.firstElementChild;
        return Math.round(box?.getBoundingClientRect().left ?? -1);
      });
    // 比べる先は余白を持つふつうの画面 (ホームは一覧とサイドバーを端まで寄せるので使わない)
    await goto(page, "/live");
    const other = await edge();

    await goto(page, `/watch/${id}`);
    expect(await edge()).toBe(other);

    const box = await page.evaluate(() => {
      const stage = document
        .querySelector('[data-testid="watch-stage"]')
        ?.getBoundingClientRect();
      const aside = document.querySelector("aside")?.getBoundingClientRect();
      const board = document
        .querySelector("main")
        ?.firstElementChild?.getBoundingClientRect();
      const root = document.documentElement;
      return {
        横に並ぶ:
          stage !== undefined && aside !== undefined
            ? stage.right <= aside.left + 1
            : false,
        // 下まで使い切る。決め打ちで切っていた頃は、下に余白があるのに先に終わっていた
        余り:
          aside !== undefined && board !== undefined
            ? Math.round(board.bottom - aside.bottom)
            : -1,
        縦に動く: root.scrollHeight > root.clientHeight + 1,
        横に動く: root.scrollWidth > root.clientWidth,
      };
    });
    expect(box.横に並ぶ).toBe(true);
    expect(box.余り).toBeLessThanOrEqual(1);
    expect(box.縦に動く).toBe(false);
    expect(box.横に動く).toBe(false);
  });

  /**
   * **右端は「観る流れの外」の縦の列。** 閉じる・切り抜く・消すは、
   * 観ながら使う操作 (再生・音・字幕) とは押す頻度も並べる理由も違う。
   * **削除も映像の上** — タブレットは全画面で観るので、全画面から出ずに消せるように。データ放送 (d) は ⚙ の中。
   *
   * 1 つの操作バーに混ぜていた頃は押すものが 12 個並び、**番組の名前が入る幅が
   * 残らなかった** — 実機のタブレットで名前が折り返し、操作バーが二段になっていた。
   * **列は縦に積む** — 車に付けたタブレットでは右の縁がいちばん指が届く (横一行・40px にして戻した)
   */
  test("閉じる・切り抜き・削除は右端の縦の列。下の操作バーは一段のまま", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    // 縦のタブレット (1000px 未満) では映像を端から端まで出し、番組の中身はその下に積む
    await page.setViewportSize({ width: 820, height: 1180 });
    await goto(page, `/watch/${id}`);
    await expect
      .poll(async () => {
        const video = (await page.getByTestId("watch-stage").boundingBox())!;
        const facts = (await page.getByTestId("watch-facts").boundingBox())!;
        return {
          left: Math.round(video.x),
          width: Math.round(video.width),
          below: facts.y >= video.y + video.height - 1,
        };
      })
      .toEqual({ left: 0, width: 820, below: true });

    // 二段組 (1000px から) では、映像の上端と右の列の最初のもの (番組名) の上端がそろう
    await page.setViewportSize({ width: 1024, height: 768 });
    await expectSideAligned(
      page,
      '[data-testid="watch-video"]',
      '[data-testid="watch-facts"] > :first-child',
    );
    // 映像の左・映像から番組名まで・番組名の右の余白が同じ
    await expectSideFrame(
      page,
      '[data-testid="watch-video"]',
      '[data-testid="watch-facts"] h3',
    );

    const side = page.getByTestId("watch-side");
    for (const testid of ["watch-close", "watch-shot", "watch-delete"]) {
      expect(await side.getByTestId(testid).count()).toBe(1);
      // 下の操作バーには無い。同じことをするボタンを 2 つ置かない
      expect(
        await page.getByTestId("watch-controls").getByTestId(testid).count(),
      ).toBe(0);
    }
    // 閉じるはいちばん上。ライブ・追っかけと同じ並び
    const top = await side.evaluate(
      (el) =>
        el.querySelector<HTMLElement>(":scope > [data-bar-items] > *")?.dataset[
          "testid"
        ],
    );
    expect(top).toBe("watch-close");
    // 縦に積む (横一行にしない)。丸は 48px で、間は 8px
    const close = (await page.getByTestId("watch-close").boundingBox())!;
    const shot = (await page.getByTestId("watch-shot").boundingBox())!;
    expect(shot.y).toBeGreaterThan(close.y + close.height - 1);
    expect(Math.abs(shot.x - close.x)).toBeLessThan(2);
    expect(Math.round(close.width)).toBe(48);
    expect(Math.round(shot.y - (close.y + close.height))).toBe(8);
    // データ放送 (d) は映像の上の列に置かない (⚙ の中)
    expect(await side.getByTestId("watch-data").count()).toBe(0);
    /*
     * **押すだけのボタンは「切り替え」と名乗らない** (`aria-pressed` は切り替えにだけ)。
     * アイコンだけのボタンなので、マウスを重ねたときに名前が出る (`title`)
     */
    for (const testid of [
      "watch-close",
      "watch-shot",
      "watch-delete",
      "watch-play",
      "watch-full",
      "watch-settings",
    ]) {
      const button = page.getByTestId(testid);
      expect(await button.getAttribute("aria-pressed"), testid).toBeNull();
      expect(await button.getAttribute("title"), testid).toBe(
        await button.getAttribute("aria-label"),
      );
    }
    await expect(page.getByTestId("watch-background")).toHaveAttribute(
      "aria-checked",
      /^(true|false)$/,
    );
    await expect(page.getByTestId("watch-background")).toHaveAttribute(
      "role",
      "menuitemcheckbox",
    );
    // 再生停止は下の操作バーのいちばん左。ライブと同じ並び
    await expect(
      page.getByTestId("watch-controls").getByTestId("watch-play"),
    ).toBeVisible();
    // 小窓 (PiP) も下の操作バー。並べても一段に収まる (下で見る)
    await expect(
      page.getByTestId("watch-controls").getByTestId("watch-pip"),
    ).toBeVisible();

    /*
     * **読むものが長くても操作バーを割らない。** 折り返すかは中身の幅で決まるので、
     * 縮む指定 (`truncate`) だけでは、縮む前に行が分かれてしまう
     */
    const rowHeight = async (): Promise<number> =>
      page.evaluate(() =>
        Math.round(
          document
            .querySelector('[data-testid="watch-buttons"]')
            ?.getBoundingClientRect().height ?? -1,
        ),
      );
    const before = await rowHeight();
    // 押すものは一段に収まる (`btn-lg` = 48px。折れると倍になる)
    expect(before).toBeLessThan(60);
    await page
      .getByTestId("watch-clock")
      .evaluate((el) => (el.textContent = "あ".repeat(200)));
    expect(await rowHeight()).toBe(before);
  });

  /*
   * **バックグラウンド再生は既定で切。** 裏に回すと止め、戻ると止めた所から再開する。
   * OS が勝手に小窓にしないよう `disablePictureInPicture` も立てる (`background.svelte.ts`)。
   *
   * 偽 ffmpeg の録画は映像が出ない (上) ので、`<video>` の止める・再開を差し替えて、
   * 呼ばれたかだけを見る。裏に回るのは `visibilityState` を差し替えて通知を送る
   */
  test("バックグラウンド再生は既定で切。裏に回すと止まり、入れると止まらない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);

    const video = page.getByTestId("watch-video");
    await expect
      .poll(() =>
        video.evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture),
      )
      .toBe(true);
    // 再生中のふり。止める・再開は印を動かすだけ
    await video.evaluate((v) => {
      const media = v as HTMLVideoElement & { fake: boolean };
      media.fake = false;
      Object.defineProperty(media, "paused", {
        configurable: true,
        get: () => media.fake,
      });
      media.pause = () => {
        media.fake = true;
      };
      media.play = async () => {
        media.fake = false;
      };
    });
    const paused = () => video.evaluate((v) => (v as HTMLVideoElement).paused);
    const turn = (state: "hidden" | "visible") =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => state,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);

    await turn("hidden");
    expect(await paused()).toBe(true);
    await turn("visible");
    expect(await paused()).toBe(false);

    await wakeControls(page, "watch-stage");
    const toggle = page.getByTestId("watch-background");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await flipSetting(page, "watch", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() =>
        video.evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture),
      )
      .toBe(false);
    await turn("hidden");
    expect(await paused()).toBe(false);
    await turn("visible");
  });

  /** 無い録画を開いても、黙って空の画面を出さない */
  test("無い録画は 404", async ({ request }) => {
    const res = await request.get("/watch/999999");
    expect(res.status()).toBe(404);
  });
});

/**
 * **スマホの縦で、全画面をやめて観る。** 枠は 390x219 (画面の端から端まで、ちょうど 16:9。
 * 余白の内側に置いていた頃は 358x224)。
 *
 * 48px の押すものを全部並べていた頃は、操作バーが折れて映像を覆い、右の縦列 (閉じる・
 * 切り抜き・削除) がシークバーや再生ボタンに重なっていた (実機の報告)。狭い枠では
 * 40px に縮め、毎回は使わないもの (速さなど) を再生の設定 (⚙) に畳む (`PlayerStage`)
 */
test.describe("スマホの縦で観る", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("押すものは 40px 以上で重ならず、速さは ⚙ に畳まれる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);
    // 指の端末は開いた時点で全画面に入る。やめたところを見る
    await page.evaluate(
      () => document.fullscreenElement && document.exitFullscreen(),
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);

    const stage = page.getByTestId("watch-stage");
    await expect(stage).toHaveAttribute("data-compact", "");
    // 出ていなければ押して出す (開いた直後は出ている。2.5 秒で引っ込む)
    const bar = page.getByTestId("watch-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      const box = (await stage.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");

    const shape = await page.evaluate(() => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const shown = (el: Element) => rect(el).width > 0;
      const side = [
        ...document.querySelectorAll('[data-testid="watch-side"] .ov-btn'),
      ].filter(shown);
      const bottom = [
        ...document.querySelectorAll(
          '[data-testid="watch-controls"] .ov-btn, [data-testid="watch-controls"] input',
        ),
      ].filter(shown);
      const sideBottom = Math.max(...side.map((el) => rect(el).bottom));
      const barTop = Math.min(...bottom.map((el) => rect(el).top));
      const buttons = [...side, ...bottom].filter((el) =>
        el.classList.contains("ov-btn"),
      );
      const stage = rect(
        document.querySelector('[data-testid="watch-stage"]') as Element,
      );
      return {
        右の列は操作バーより上: sideBottom <= barTop,
        いちばん小さい: Math.min(
          ...buttons.map((el) => Math.min(rect(el).width, rect(el).height)),
        ),
        枠からはみ出す: buttons.some(
          (el) => rect(el).left < stage.left || rect(el).right > stage.right,
        ),
        横に動く:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        枠: { left: Math.round(stage.left), width: Math.round(stage.width) },
      };
    });
    expect(shape.右の列は操作バーより上).toBe(true);
    expect(shape.いちばん小さい).toBeGreaterThanOrEqual(40);
    expect(shape.枠からはみ出す).toBe(false);
    expect(shape.横に動く).toBe(false);
    // **映像は画面の端から端まで** (余白の内側に置くと 358px に縮み、周りに縁が出る)
    expect(shape.枠).toEqual({ left: 0, width: 390 });
    // **上も空けない。** 本文の上の端 (この画面は見出しを出すので、その下の端) から映像が始まる
    const gap = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const content =
        main.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(main).paddingTop);
      return (
        document
          .querySelector('[data-testid="watch-stage"]')!
          .getBoundingClientRect().top - content
      );
    });
    expect(Math.round(gap)).toBe(0);
    /*
     * **枠はちょうど映像の形 (16:9) で、操作バーは映像に重ねる** (`PlayerStage` の `narrow`)。
     * 以前は映像の下に段を足して操作バーを出しっぱなしにしていたが、枠が映像より高くなり、
     * 映像の下に操作バーの段がいつも残って見えた。いまは触らなければ引っ込む。字幕の面も映像の中に収まる
     */
    await expect(stage).toHaveAttribute("data-narrow", "");
    const frame = (await stage.boundingBox())!;
    const picture = (await page.getByTestId("watch-video").boundingBox())!;
    const strip = (await bar.boundingBox())!;
    expect(Math.round(frame.height)).toBe(Math.round((390 * 9) / 16));
    expect(Math.round(picture.height)).toBe(Math.round((390 * 9) / 16));
    expect(strip.y + strip.height).toBeLessThanOrEqual(
      frame.y + frame.height + 1,
    );

    const captions = (await page
      .getByTestId("watch-captions-canvas")
      .boundingBox())!;
    expect(captions.y + captions.height).toBeLessThanOrEqual(
      picture.y + picture.height + 1,
    );
    // 押すものは一段 (40px)。折れると倍になる
    const row = await page.getByTestId("watch-play").boundingBox();
    const full = await page.getByTestId("watch-full").boundingBox();
    expect(Math.abs((row?.y ?? 0) - (full?.y ?? -100))).toBeLessThan(2);

    // 速さは畳まれていて、⚙ の先頭の「再生の速さ」の行から選ぶ
    await expect(page.getByTestId("watch-speed")).toBeHidden();
    // 操作バーは引っ込んでいることがある (映像に重ねるので)。起こしてから押す
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-settings").tap();
    const pace = page.getByTestId("watch-pace");
    await expect(pace).toContainText("×1");
    await pace.tap();
    // メニューは枠の中に収まる (見出しの裏に潜らない)
    const menu = page.getByTestId("watch-settings-menu");
    await expect(menu).toBeVisible();
    const inside = await page.evaluate(() => {
      const menu = document
        .querySelector('[data-testid="watch-settings-menu"]')
        ?.getBoundingClientRect();
      const stage = document
        .querySelector('[data-testid="watch-stage"]')
        ?.getBoundingClientRect();
      return (
        menu !== undefined &&
        stage !== undefined &&
        menu.top >= stage.top - 1 &&
        menu.bottom <= stage.bottom + 1
      );
    });
    expect(inside).toBe(true);
    await page
      .locator('[data-testid="watch-pace-option"][data-pace="1.5"]')
      .tap();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("watch-pace")).toContainText("×1.5");
    // 操作バーの速さのボタン (畳まれている) にも同じ値が出る
    await expect(page.getByTestId("watch-speed")).toHaveText("1.5");

    // 映像に重ねるので、放っておけば引っ込む (ほかの枠と同じ)。押せばまた出る
    await expect(bar).toHaveAttribute("data-shown", "false", { timeout: 6000 });
    // 透明度は影とボタンの並びがそれぞれ持つ (外の箱は持たない。`ControlBar`)
    await expect
      .poll(() =>
        bar.evaluate((el) => [
          getComputedStyle(el, "::before").opacity,
          getComputedStyle(el.querySelector(":scope > [data-bar-items]")!)
            .opacity,
        ]),
      )
      .toEqual(["0", "0"]);
    const again = (await stage.boundingBox())!;
    await page.touchscreen.tap(
      again.x + again.width / 2,
      again.y + again.height / 2,
    );
    await expect(bar).toHaveAttribute("data-shown", "true");
  });

  /*
   * **いちばん狭いスマホ (360px・320px) でも、操作バーのボタンは 1 行。** 折り返していた頃は、
   * 時刻が押すものの上に一行を取って操作バーが二段になっていた。残すのは再生・チャプター送り・
   * 時刻・⚙・全画面だけで、時刻は短い形 (残りを省く)。畳んだもの (音など) は ⚙ の先頭の行から押せる
   */
  test("幅 360px・320px でも操作バーのボタンは 1 行で、畳んだ音は ⚙ から押せる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 780 });
      await goto(page, `/watch/${id}`);
      await leaveFullscreen(page);
      await expect(page.getByTestId("watch-stage")).toHaveAttribute(
        "data-narrow",
        "",
      );
      await expect(page.getByTestId("watch-play")).toBeVisible();

      expect(await oneRowTroubles(page, "watch-buttons"), `${width}px`).toEqual(
        [],
      );
      await expect(page.getByTestId("watch-full")).toBeVisible();
      await expect(page.getByTestId("watch-clock")).toBeVisible();
      await expect(
        page.getByTestId("watch-clock").locator(".long"),
      ).toBeHidden();
      await page.screenshot({
        path: test.info().outputPath(`watch-${width}.png`),
      });

      // 畳んだ音は ⚙ の先頭の「消音」の行。「ほか」(⋯) のボタンはもう無い
      const sound = page.getByTestId("watch-sound");
      await expect(sound).toBeHidden();
      await expect(page.getByTestId("watch-more")).toHaveCount(0);
      const label = (await sound.getAttribute("aria-label")) ?? "";
      // 操作バーは引っ込んでいることがある (映像に重ねるので)。起こしてから押す
      await wakeControls(page, "watch-stage");
      await page.getByTestId("watch-settings").tap();
      const mute = page.getByTestId("watch-mute");
      await expect(mute).toBeVisible();
      await expect(mute).toHaveAttribute("role", "menuitemcheckbox");
      const muted = (await mute.getAttribute("aria-checked")) ?? "";
      await mute.tap();
      await expect(mute).not.toHaveAttribute("aria-checked", muted);
      await expect(sound).not.toHaveAttribute("aria-label", label);
      await page.screenshot({
        path: test.info().outputPath(`watch-${width}-more.png`),
      });

      // 閉じても 1 行のまま
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("watch-settings-menu")).toBeHidden();
      expect(
        await oneRowTroubles(page, "watch-buttons"),
        `${width}px (閉じたあと)`,
      ).toEqual([]);
    }
  });
});

/**
 * **横にしたスマホでは映像を画面いっぱいに** (`PlayerLayout`)。見出しと右の列を残すと
 * 映像の枠が 510x280 ほどしか無く、操作バーが二段に折れてシークバーが映像の真ん中に来ていた
 */
test.describe("スマホの横で観る", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });

  test("見出しを隠して映像が画面の高さいっぱい。操作バーは一段で下端に、右の列は下へ", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);
    // 指の端末は開いた時点で全画面に入る。やめたところを見る
    await page.evaluate(
      () => document.fullscreenElement && document.exitFullscreen(),
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);

    const stage = page.getByTestId("watch-stage");
    await expect(stage).not.toHaveAttribute("data-pseudo", "");
    await expect(page.locator(".navbar")).toBeHidden();
    // 枠は映像の形 (16:9) で、高さいっぱい・真ん中。左右の黒帯にボタンを出さない
    await expect
      .poll(async () => roundBox(await stage.boundingBox()))
      .toEqual({ x: 75, y: 0, width: 693, height: 390 });

    const bar = page.getByTestId("watch-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      await page.touchscreen.tap(422, 195);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");
    // 押すものは一段
    const play = (await page.getByTestId("watch-play").boundingBox())!;
    const full = (await page.getByTestId("watch-full").boundingBox())!;
    expect(Math.abs(play.y - full.y)).toBeLessThan(2);
    // シークバーは映像の下の方 (真ん中に来ると、映像を押したつもりで位置が飛ぶ)
    const seek = (await bar.getByRole("slider").boundingBox())!;
    expect(seek.y).toBeGreaterThan(390 * 0.6);
    // どのボタンも重ならず、映像の枠の中に丸ごと見える (右上の 3 つも)
    expect(await overlayTroubles(page, "watch-stage")).toEqual([]);
    // 操作バーは映像に重ねるので、下の方の字幕は操作バーの上まで持ち上がる
    await captionsClearOfBar(page, "watch-captions-canvas", "watch-controls");

    // 右の列 (番組の中身) は消さずに映像の下へ。巻き取れば読める
    const facts = page.getByTestId("watch-facts");
    await facts.scrollIntoViewIfNeeded();
    await expect(facts).toBeInViewport();
    // ページごとは横に動かない
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= 844),
    ).toBe(true);
  });
});

/**
 * **指で。** マウスと指では操作バーの出し方が違い (`controls.svelte.ts`)、メニューの
 * 開け方も pointer の種類で違いが出やすい (Bits UI を使っていた頃は分けていた) ので、指の経路を別に見る
 */
test.describe("指で観る", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1024, height: 768 },
  });

  /*
   * **押したメニューが開いたまま残り、操作バーも引っ込まない。** 実機のタブレットで、
   * 速さを押した瞬間にメニューが閉じていた。開いている間は操作バーの 2.5 秒の
   * 時計 (`LINGER`) も止める — メニューは操作バーの中にあるので、操作バーが消えれば
   * 選んでいる最中でもメニューごと消える
   */
  test("速さのボタンを押すと開いたまま残り、選ぶまで操作バーも消えない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);

    /*
     * 指は映像を 1 回押して操作バーを出す (マウスのように動かしただけでは出ない)。
     * 開いた直後は出ていて、そこで押すと引っ込む (出し入れなので)。消えるまで待ってから押す
     */
    const bar = page.getByTestId("watch-controls");
    await expect(bar).toHaveAttribute("data-shown", "false");
    const stage = (await page.getByTestId("watch-stage").boundingBox())!;
    await page.touchscreen.tap(
      stage.x + stage.width / 2,
      stage.y + stage.height / 2,
    );
    await expect(bar).toHaveAttribute("data-shown", "true");

    await page.getByTestId("watch-speed").tap();
    const menu = page.getByTestId("watch-speed-menu");
    await expect(menu).toBeVisible();
    // 触らずに時計のぶんより長く待っても、開いている間は残る
    await page.waitForTimeout(3500);
    await expect(menu).toBeVisible();
    await expect(bar).toHaveAttribute("data-shown", "true");

    // 選べば閉じて、そこから時計が動き出す
    await page
      .getByTestId("watch-speed-option")
      .filter({ hasText: "×1.5" })
      .tap();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("watch-speed")).toHaveText("1.5");
    await expect(bar).toHaveAttribute("data-shown", "false", { timeout: 5000 });
  });
});

/**
 * **iPhone の全画面は、枠を画面いっぱいに広げて代わりにする** (#471。`fullscreen.svelte.ts`)。
 *
 * iPhone の Safari は要素の全画面 (`requestFullscreen` / `webkitRequestFullscreen`) を
 * 持たない。API を消して iPhone の横持ち (844x390) に見立てる。指の端末は開いた時点で
 * 全画面に入るので、開いたら広がっていること。出口は同じボタン・Esc・戻る
 */
test.describe("iPhone で全画面", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });

  test("開くと枠が画面いっぱいに広がり、重ねものも付いてくる。ボタン・Esc・戻るで出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.addInitScript(() => {
      for (const proto of [Element.prototype, HTMLElement.prototype]) {
        delete (proto as Partial<Element>).requestFullscreen;
        delete (proto as { webkitRequestFullscreen?: unknown })
          .webkitRequestFullscreen;
      }
    });
    await goto(page, `/watch/${id}`);

    const stage = page.getByTestId("watch-stage");
    const full = page.getByTestId("watch-full");
    const covers = async () => {
      await expect(stage).toHaveAttribute("data-pseudo", "");
      await expect
        .poll(() => stage.boundingBox())
        .toEqual({ x: 0, y: 0, width: 844, height: 390 });
      // 後ろのページは止める
      await expect(page.locator("html")).toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面をやめる");
    };
    const restored = async () => {
      await expect(stage).not.toHaveAttribute("data-pseudo", "");
      // 横にしたスマホは全画面でなくても枠が画面の高さいっぱい (`PlayerLayout`)。大きさでは見分けない
      await expect
        .poll(() => stage.evaluate((el) => getComputedStyle(el).position))
        .not.toBe("fixed");
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面");
      await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));
    };
    const showControls = async () => {
      const bar = page.getByTestId("watch-controls");
      if ((await bar.getAttribute("data-shown")) !== "true") {
        const box = (await stage.boundingBox())!;
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
      }
      await expect(bar).toHaveAttribute("data-shown", "true");
    };

    // 開いた時点で広がっている。本物の全画面には入っていない
    await covers();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

    // 字幕の面は映像に、映像は枠に重なる。操作バーは画面の中
    await showControls();
    const layout = await page.evaluate(() => {
      const rect = (id: string) => {
        const r = document
          .querySelector(`[data-testid="${id}"]`)!
          .getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      return {
        video: rect("watch-video"),
        captions: rect("watch-captions-canvas"),
        bar: rect("watch-controls"),
      };
    });
    expect(layout.video).toEqual({ x: 0, y: 0, w: 844, h: 390 });
    expect(layout.captions).toEqual(layout.video);
    expect(layout.bar.y + layout.bar.h).toBeLessThanOrEqual(390);

    // 同じボタンで出る
    await full.tap();
    await restored();

    // もう一度入って、Esc で出る
    await showControls();
    await full.tap();
    await covers();
    await page.keyboard.press("Escape");
    await restored();

    // もう一度入って、戻るで出る。画面は離れない
    await showControls();
    await full.tap();
    await covers();
    await page.evaluate(() => history.back());
    await restored();
  });
});

function roundBox(
  box: { x: number; y: number; width: number; height: number } | null,
) {
  return box === null
    ? null
    : {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
}
