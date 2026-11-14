import {
  expect,
  expectSideAligned,
  expectSideFrame,
  goto,
  pickCodec,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * ライブ視聴 ([docs/stream.md](../../docs/stream.md#ライブ))。映像・音声・字幕まで。
 *
 * **映像が出るところまでは見ない。** E2E の ffmpeg は偽物で、流れてくるのも
 * 本物の TS ではないため、MSE が受け取れる fMP4 にはならず、字幕も 1 枚も出ない。
 * ここで固定するのはその手前まで — **チケットを取り、WebSocket が繋がり、チューナーを
 * 使い、選んだ局が「いま映しているもの」になる**という経路と、**ffmpeg に何を
 * 渡したか**。エンコードしたものが正しいかどうかは実機で測る話になる。
 *
 * 1 本のままだと CI の組の時間の下限を押し上げるので、ライブ視聴の E2E は 4 本に分けて別のワーカーで流す
 * ([docs/development.md](../../docs/development.md#並べて流す))。どれも偽 ffmpeg で確かめる範囲は上と同じ。
 *
 * - ここ: 画面の組み方とチャンネル一覧
 * - [20-live-tune.spec.ts](20-live-tune.spec.ts): 番組表から開く、繋ぎ方、データ放送、ffmpeg に渡す TS、切り抜き
 * - [20-live-player.spec.ts](20-live-player.spec.ts): 操作バー・小窓・全画面・バックグラウンド再生と、スマホの向き
 * - [20-live-encode.spec.ts](20-live-encode.spec.ts): 音声・エンコード方式・字幕、端末に覚えるもの、番組の切り替わり、画面の消灯
 */
test.describe("ライブ視聴", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("ヘッダーの「ライブ」から開ける", async ({ page }) => {
    await goto(page, "/");
    await page.getByTestId("nav-live").click();
    await expect(page).toHaveURL(/\/live$/);
    await expect(page.getByTestId("live")).toBeVisible();
  });

  test("右にチャンネルが並ぶ", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await expect(channels.first()).toBeVisible();
    /*
     * **数えるのも待つ。** `expect(await count())` は撮った瞬間の数で
     * 決めるので、1 件目が出た直後だと 1 のまま落ちる (実際に揺れていた)
     */
    await expect.poll(() => channels.count()).toBeGreaterThan(1);
    // 番組表と同じ並び。地上波はリモコン番号順で先頭に来る
    await expect(channels.first()).toHaveAttribute("data-channel", /^GR\//);
  });

  /*
   * **映像を見ながら選ぶ画面なので、ページごと動かさない。** 動くと映像が
   * 画面から出ていく。動くのは右の一覧だけ
   */
  test("広い画面ではページごとスクロールしない", async ({ page }) => {
    // **低めの画面で見る。** 高いと直す前の作りでも収まってしまい、判別できない
    await page.setViewportSize({ width: 1440, height: 700 });
    await goto(page, "/live");
    await expect(page.getByTestId("live-channel").first()).toBeVisible();

    const doc = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
    }));
    expect(doc.scrollH).toBeLessThanOrEqual(doc.clientH + 1);
  });

  test.describe("動かしてよい端末", () => {
    test.use({ reducedMotion: "no-preference" });

    /*
     * **開いた直後にも、窓にスクロールバーを出さない。** ページの中で開いたとき (画面の切り替えの動きの間も含めて)、
     * 毎コマ見る。読み上げ用の `.visually-hidden` (`position: absolute`) が文書を基準に置かれて
     * `.shell.fill` の `overflow: hidden` で切られず、局の一覧の中で隠れている行のぶんだけページが
     * 伸びていた (映像の色が付いて右の列が `position: relative` になるまでの 1 秒ほど)。
     * 偽の局は少なく一覧が溢れないので、**文書を基準に置かれたものが無いこと**も一緒に見る
     */
    test("ページの中で開いた直後も、窓はスクロールしない", async ({ page }) => {
      for (const size of [
        { width: 1541, height: 954 },
        { width: 1400, height: 600 },
      ]) {
        await page.setViewportSize(size);
        await goto(page, "/");
        await page.evaluate(() => {
          const w = window as unknown as {
            samples: { over: number; loose: string[] }[];
          };
          w.samples = [];
          const start = performance.now();
          const tick = () => {
            const root = document.documentElement;
            const shell = document.querySelector(".shell.fill");
            const loose: string[] = [];
            if (shell !== null) {
              // `position: absolute` で、位置を持つ祖先が `.shell` の外にあるもの (SVG の中身は `offsetParent` を持たないので見ない)
              for (const el of shell.querySelectorAll("*")) {
                if (
                  !(el instanceof HTMLElement) ||
                  getComputedStyle(el).position !== "absolute"
                )
                  continue;
                const parent = el.offsetParent;
                if (parent !== null && !shell.contains(parent))
                  loose.push(`${el.tagName}.${el.className}`);
              }
            }
            w.samples.push({
              over: root.scrollHeight - root.clientHeight,
              loose,
            });
            if (performance.now() - start < 2500) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.getByTestId("nav-live").click();
        await expect(page.getByTestId("live")).toBeVisible();
        await page.waitForTimeout(2600);
        const samples = await page.evaluate(
          () =>
            (
              window as unknown as {
                samples: { over: number; loose: string[] }[];
              }
            ).samples,
        );
        expect(samples.length).toBeGreaterThan(10);
        expect(
          Math.max(...samples.map((s) => s.over)),
          `${size.width}x${size.height}`,
        ).toBeLessThanOrEqual(0);
        expect([...new Set(samples.flatMap((s) => s.loose))]).toEqual([]);
      }
    });
  });

  /*
   * **目に見える映像の上端と、種別のタブの上端がそろう** (広い画面・低い画面の両方)。
   * 測るのは絵の出ている所 (エンコードしたものは video、MPEG-2 のままは canvas)
   */
  test("映像の上端と右の列の最初のもの (種別のタブ) の上端がそろう", async ({
    browser,
  }) => {
    // MPEG-2 もデコードできる端末として開く (既定の枠は `stack.ts` の `liveWithoutMpeg2`)。エンコードしたものは AV1 で観る
    const context = await browser.newContext();
    const page = await context.newPage();
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");
    for (const size of [
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-frame")).toBeVisible();
      await expectSideAligned(
        page,
        '[data-testid="live-video"]',
        ".live-side > :first-child",
      );
      // 映像の左・映像から種別のタブまで・タブの右の余白が同じ
      await expectSideFrame(
        page,
        '[data-testid="live-video"]',
        ".live-side > :first-child",
      );
    }
    // MPEG-2 のまま (canvas に描く) でも同じ
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "mpeg2");
    await expect
      .poll(
        async () =>
          Number(
            (await page.getByTestId("live-raw").getAttribute("data-shown")) ??
              0,
          ),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(10);
    await expectSideAligned(
      page,
      '[data-testid="live-raw"]',
      ".live-side > :first-child",
    );

    /*
     * **横に長い低い窓では、枠が映像の形に縮む** (左右に黒い帯を出さない。`PlayerStage`)。
     * 枠は絵と同じ縦横比で、高さいっぱい・上寄せ・列の真ん中。右端の縦の列も枠の中に残る
     */
    await page.setViewportSize({ width: 1680, height: 700 });
    const told = await page.getByTestId("live-raw").getAttribute("data-aspect");
    expect(told).toMatch(/^\d+ \/ \d+$/);
    const [w = 0, h = 0] = (told ?? "").split(" / ").map(Number);
    await expect
      .poll(async () => {
        const box = (await page.getByTestId("live-frame").boundingBox())!;
        return Math.abs(box.width / box.height - w / h);
      })
      .toBeLessThan(0.01);
    const frame = (await page.getByTestId("live-frame").boundingBox())!;
    const column = (await page
      .locator("[data-player-layout] > .main")
      .boundingBox())!;
    expect(frame.width).toBeLessThan(column.width - 100);
    expect(Math.abs(frame.y - column.y)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        frame.x - column.x - (column.x + column.width - frame.x - frame.width),
      ),
    ).toBeLessThanOrEqual(1);
    // 枠の下は窓の中 (高さで収まっている)
    expect(frame.y + frame.height).toBeLessThanOrEqual(700);
    await expectSideAligned(
      page,
      '[data-testid="live-raw"]',
      ".live-side > :first-child",
    );
    await expectSideFrame(
      page,
      '[data-testid="live-raw"]',
      ".live-side > :first-child",
    );
    await wakeControls(page, "live-frame");
    const shot = (await page.getByTestId("live-shot").boundingBox())!;
    expect(shot.x + shot.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(shot.width).toBe(48);
    await context.close();
  });

  /*
   * **種別のタブの端と、下の一覧の行の面の端がそろう** (広い画面・縦のタブレット・スマホ)。選んでいる行は
   * 面で塗るので、面の端がタブより外へ出ていると、タブと一覧がずれて見えた
   */
  test("種別のタブと下の一覧の端がそろう", async ({ page }) => {
    for (const size of [
      { width: 1366, height: 768 },
      { width: 820, height: 1180 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/live");
      const tabs = (await page
        .locator(".live-side > .type-tabs")
        .boundingBox())!;
      const row = (await page
        .locator(".live-side .channel-item")
        .first()
        .boundingBox())!;
      const at = `${size.width}px`;
      expect(Math.abs(tabs.x - row.x), `${at} の左`).toBeLessThanOrEqual(1);
      expect(
        Math.abs(tabs.x + tabs.width - (row.x + row.width)),
        `${at} の右`,
      ).toBeLessThanOrEqual(1);
      // 面の中の余白も左右で同じ (ロゴの先頭と (i) の印の外)
      if (size.width === 820) continue;
      const item = page
        .locator(".live-side .channel-item")
        .filter({ has: page.getByTestId("live-channel-detail") })
        .first();
      const logo = (await item.locator(".channel .logo").boundingBox())!;
      const icon = (await item.locator(".channel-detail svg").boundingBox())!;
      const box = (await item.boundingBox())!;
      const left = logo.x - box.x;
      const right = box.x + box.width - (icon.x + icon.width);
      expect(
        Math.abs(left - right),
        `${at} の内側 (左 ${left}・右 ${right})`,
      ).toBeLessThanOrEqual(2);
    }
  });

  /*
   * **二段組にする幅は観る画面 (`/watch/<id>`) と同じ 1000px** (ヘッダーを出す幅と同じ線。`+layout.svelte` の `FILLED`)。
   * それより狭いと、縦のタブレットでも横長の窓でも映像を端から端まで出し、局の一覧をその下に積んでページごと巻く。
   * 1000px からは今までどおり横に並べ、ページごとは動かさない
   */
  test("1000px 未満は映像を幅いっぱいにし、一覧をその下に積む", async ({
    page,
  }) => {
    const shape = () =>
      page.evaluate(() => {
        const video = document
          .querySelector('[data-testid="live-frame"]')
          ?.getBoundingClientRect();
        const aside = document.querySelector("aside")?.getBoundingClientRect();
        const root = document.documentElement;
        return {
          left: Math.round(video?.left ?? -1),
          width: Math.round(video?.width ?? -1),
          below:
            video !== undefined && aside !== undefined
              ? aside.top >= video.bottom - 1
              : false,
          beside:
            video !== undefined && aside !== undefined
              ? video.right <= aside.left + 1
              : false,
          scrolls: root.scrollHeight > root.clientHeight + 1,
        };
      });
    for (const size of [
      { width: 820, height: 1180 },
      { width: 900, height: 640 },
      { width: 999, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/live");
      await expect(page.getByTestId("live-channel").first()).toBeVisible();
      const at = `${size.width}x${size.height}`;
      await expect
        .poll(shape, at)
        .toMatchObject({ left: 0, width: size.width, below: true });
      // 横長の窓では一覧が画面の下にはみ出すので、ページごと巻いて見る
      if (size.height < 1000) expect((await shape()).scrolls, at).toBe(true);
    }

    await page.setViewportSize({ width: 1000, height: 700 });
    await goto(page, "/live");
    await expect(page.getByTestId("live-channel").first()).toBeVisible();
    await expect.poll(shape).toMatchObject({ beside: true, scrolls: false });
  });

  /**
   * **縦長の窓では映像を窓の上に留め、局の一覧だけを映像の裏へ巻く** (#2754)。一覧を探しながら映像を観られる。
   * 横長の窓は映像が窓の半分を超えることがあるので留めず、今までどおり映像ごと巻く
   */
  test("縦長の窓では、一覧を巻いても映像は窓の上に残る", async ({ page }) => {
    const scrolled = (by: number) =>
      page.evaluate((by) => {
        window.scrollTo(0, by);
        const frame = document
          .querySelector('[data-testid="live-frame"]')
          ?.getBoundingClientRect();
        const list = document
          .querySelector('[data-testid="live-channels"]')
          ?.getBoundingClientRect();
        return {
          scrollY: Math.round(window.scrollY),
          top: Math.round(frame?.top ?? -1),
          listTop: Math.round(list?.top ?? -1),
        };
      }, by);

    // 一覧が窓の下へはみ出す低い縦長の窓 (E2E の局は少ないので、窓を低くしてはみ出させる)
    await page.setViewportSize({ width: 380, height: 400 });
    await goto(page, "/live");
    await expect(page.getByTestId("live-channel").first()).toBeVisible();
    const before = await scrolled(0);
    const after = await scrolled(1000);
    expect(after.scrollY).toBeGreaterThan(0);
    expect(after.top).toBe(0);
    // 一覧は巻いたぶんだけ上へ動く (映像の裏へ入る)
    expect(after.listTop).toBe(before.listTop - after.scrollY);
    // 映像は一覧より上に描く (一覧の行が映像に被らない)
    const onTop = await page.evaluate(() => {
      const frame = document
        .querySelector('[data-testid="live-frame"]')
        ?.getBoundingClientRect();
      if (frame === undefined) return false;
      const hit = document.elementFromPoint(
        frame.left + frame.width / 2,
        frame.top + frame.height / 2,
      );
      return Boolean(hit?.closest('[data-testid="live-frame"]'));
    });
    expect(onTop).toBe(true);

    // 横長の窓は留めない (映像も一緒に上へ巻かれる)
    await page.setViewportSize({ width: 900, height: 640 });
    await goto(page, "/live");
    await expect(page.getByTestId("live-channel").first()).toBeVisible();
    const wide = await scrolled(1000);
    expect(wide.scrollY).toBeGreaterThan(0);
    expect(wide.top).toBeLessThan(0);
  });

  /**
   * **番組の中身は右の列を入れ替えて出す。モーダルにしない** — 映像の上に
   * 被さると観ながら読めない (観る画面と同じ考え方)。
   *
   * 開くボタンは**行とは別**に置いてある。行そのものは選局なので、あらすじを
   * 見たいだけのときにチャンネルが変わっては困る
   */
  test("右の列で番組の中身を読める。チャンネルは変わらない", async ({
    page,
  }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await expect(channels.first()).toBeVisible();
    const tuned = await page.getByTestId("live-title").textContent();

    /*
     * **引き直す前から、行が持っている分は出る。** 番組表から引き直すエンドポイントを
     * 止めておいて開く。行の分に `description: undefined` が混じると
     * `programDetail` の既定 ('') がそれで潰され、引き直せるまであらすじが
     * 空になる (#43 で型の上では塞いだ)。確かめてから通し、ラベル (ジャンル・音声) は
     * 引き直しで出る
     */
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("/api/programs/*", async (route) => {
      await held;
      await route.continue();
    });
    await page.getByTestId("live-channel-detail").first().click();
    await expect(page.getByTestId("live-detail")).toBeVisible();
    await expect(page.getByTestId("live-detail")).toContainText("のテスト番組");
    release();
    await expect(page.getByTestId("detail-badges")).toBeVisible();
    // 読んでいる間は一覧を退ける (同じ列を使う)
    await expect(page.getByTestId("live-channels")).toHaveCount(0);
    // 押したのは選局ではない。映しているものは変わらない
    await expect(page.getByTestId("live-title")).toHaveText(tuned ?? "");

    await page.getByTestId("live-detail-close").click();
    await expect(page.getByTestId("live-channels")).toBeVisible();
  });

  /*
   * **一覧は残りの高さをぜんぶ使う。** 決め打ちで切っていた頃は、画面の下に
   * 余白があるのに一覧のほうが先に終わっていた
   */
  test("チャンネル一覧は表示領域いっぱいまで伸びる", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await goto(page, "/live");
    const list = page.getByTestId("live-channels");
    await expect(list).toBeVisible();

    const box = (await list.boundingBox())!;
    const viewport = page.viewportSize()!;
    // 下端まで、余白ぶん (24px) 以上は空けない
    expect(viewport.height - (box.y + box.height)).toBeLessThanOrEqual(28);
  });

  /*
   * **一覧は種別で切り替える。** 全部縦に並べると、CS の局が 100 を超える環境で
   * 地上波が上のほうへ流れて見えなくなる。**開いたときは、いま映している局の種別**
   */
  test("チャンネル一覧を地上波/BS/CS で切り替えられる", async ({ page }) => {
    await goto(page, "/live");
    await expect(page.getByTestId("live-type-GR")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 地上波を見ているので、一覧に出るのは地上波だけ
    const shown = page.getByTestId("live-channel");
    await expect(shown.first()).toBeVisible();
    for (const channel of await shown.all()) {
      await expect(channel).toHaveAttribute("data-channel", /^GR\//);
    }

    await page.getByTestId("live-type-BS").click();
    await expect(page.getByTestId("live-type-BS")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(shown.first()).toHaveAttribute("data-channel", /^BS\//);
    // 切り替えただけでは選局しない。見ているものはそのまま
    await expect(page.getByTestId("live-title")).toBeVisible();
  });

  /*
   * **テレビに出ている番号を添える。** 地上波はリモコン番号、BS/CS は
   * サービス ID がそのまま 3 桁番号にあたる (BS朝日1=151)。局名だけだと、
   * テレビで覚えている番号から探せない。
   *
   * 並び自体は SQL の話なので `epg.test.ts` で見ている
   */
  test("チャンネルにテレビと同じ番号が出る", async ({ page }) => {
    await goto(page, "/live");
    const first = page.getByTestId("live-channel").first();
    await expect(first).toBeVisible();
    // 地上波はリモコン番号
    await expect(first.getByTestId("live-number")).toHaveText(/^\d+$/);
    // 番号は局名の先頭 (ロゴの右)。ロゴの前に番号の列を取ると、狭い列で局名が潰れた
    const logo = (await first.locator(".logo").boundingBox())!;
    const number = (await first.getByTestId("live-number").boundingBox())!;
    expect(number.x).toBeGreaterThan(logo.x + logo.width);
    await expect(first.locator(".channel-name")).toContainText(
      /リモコン\s*\d+/,
    );

    await page.getByTestId("live-type-BS").click();
    await expect(page.getByTestId("live-channel").first()).toBeVisible();
    // BS は 3 桁番号
    await expect(
      page.getByTestId("live-channel").first().getByTestId("live-number"),
    ).toHaveText(/^\d{3}$/);
  });

  /*
   * **押せると分かる見た目にする。** 平らに並べていた頃は、文字が並んでいるだけに
   * 見えて押せると気付けなかった。行に枠は付けない (サイドバーの一覧) が、指の形を変え、
   * 指を乗せた行には淡い地を敷く。指でも押しやすい高さ (44px) は取る
   */
  test("チャンネルは押せると分かる見た目にする", async ({ page }) => {
    await goto(page, "/live");
    // いま映していない行で見る (映している行は初めから塗ってある)
    const row = page
      .locator('[data-testid="live-channel"][data-current="false"]')
      .first();
    await expect(row).toBeVisible();
    expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe(
      "pointer",
    );
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const fill = () =>
      row.evaluate((el) => getComputedStyle(el.closest("li")!).backgroundColor);
    const before = await fill();
    await row.hover();
    await expect.poll(fill).not.toBe(before);
  });

  /*
   * **いま映しているものが分かるようにする。** 色だけだと、色の見え方が違う人に
   * 伝わらないので、行の地 (明るさの差) で示し、読み上げには `aria-current` と文字で渡す。
   * **バッジにはしない** — 狭い列で局名と番組名を潰していた
   */
  test("選局中のチャンネルが分かる", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    const second = channels.nth(1);
    await second.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await expect(second).toHaveAttribute("data-current", "true");
    await expect(second).toHaveAttribute("aria-current", "true");
    await expect(second).toContainText("視聴中");
    await expect(page.getByTestId("live-tuned-mark")).toHaveCount(1);
    // 印は 1 つだけ。ほかの行に残っていたら、どれを見ているのか分からない
    expect(
      await page
        .locator('[data-testid="live-channel"][data-current="true"]')
        .count(),
    ).toBe(1);
  });

  /*
   * 左の縦線は行ごとではなく一覧の 1 本 (`app.css` の `.side-list`)。局を替えると前の行から滑る (docs/design.md の「動き」)。
   * ほかのテストは動きを止めて流すので、ここだけ動きを戻す
   */
  test("局を替えると、左の縦線が前の行から滑る", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    const list = page.getByTestId("live-channels");
    /** 一覧の線の上端と、行の上端 (どちらも画面の座標) */
    const mark = () =>
      list.evaluate((el) => {
        const style = getComputedStyle(el, "::after");
        const box = el.getBoundingClientRect();
        return {
          content: style.content,
          top: box.top + Number.parseFloat(style.top) - el.scrollTop,
        };
      });
    await channels.nth(0).click();
    await expect(channels.nth(0)).toHaveAttribute("data-current", "true");
    // 行には線を引かない (2 本にならない)
    expect(
      await channels
        .nth(0)
        .locator("..")
        .evaluate((el) => getComputedStyle(el, "::before").content),
    ).toBe("none");
    expect((await mark()).content).not.toBe("none");
    await page.evaluate(() => {
      const box = window as unknown as { slides: number };
      box.slides = 0;
      document.addEventListener("transitionrun", (event) => {
        if (event.propertyName === "top") box.slides++;
      });
    });
    await channels.nth(1).click();
    await expect(channels.nth(1)).toHaveAttribute("data-current", "true");
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { slides: number }).slides),
      )
      .toBeGreaterThan(0);
    // 滑り終えたら、選んだ行の高さの中にいる
    await expect
      .poll(async () => {
        const row = (await channels.nth(1).locator("..").boundingBox())!;
        const at = (await mark()).top;
        return at > row.y && at < row.y + row.height;
      })
      .toBe(true);
  });
});
