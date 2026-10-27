import { readFile } from "node:fs/promises";

import { expect, goto, stopGuideClock, test } from "./helpers";

/**
 * ホーム画面に置いて、アプリのように開けること。
 *
 * 中身はキャッシュしない。録画一覧も番組表もサーバの今の状態が要るので、
 * 古いものを見せるくらいなら繋がらないと分かるほうがまし。
 */
test.describe("PWA", () => {
  test("マニフェストとアイコンが揃っている", async ({ page, request }) => {
    await goto(page, "/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "./manifest.webmanifest",
    );

    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain(
      "application/manifest+json",
    );
    const manifest = await res.json();
    expect(manifest.name).toBe("denpa");
    // ホーム画面から開いたときにブラウザのUIを出さない
    expect(manifest.display).toBe("standalone");
    // 丸く切り抜かれる端末があるので、そのためのアイコンも要る
    expect(
      manifest.icons.some(
        (i: { purpose?: string }) => i.purpose === "maskable",
      ),
    ).toBeTruthy();

    for (const icon of manifest.icons) {
      const image = await request.get(icon.src);
      expect(image.status(), icon.src).toBe(200);
    }
    // iOS はマニフェストのアイコンを使わない
    expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);
  });

  /*
   * **画面の HTML を溜め込ませない。**
   *
   * SvelteKit が付けるのは中身の指紋 (`etag`) だけで、どれくらい持って
   * いてよいかは何も言わない。言われなかった端末は自分で決めるので、
   * ホーム画面から入れたアプリを開き直したときに**前に閉じたときの一覧**
   * が出ることがある。`no-cache` は「持ってよいが出す前に必ず聞く」
   */
  test("画面の HTML は毎回聞き直させる", async ({ request }) => {
    for (const path of ["/", "/guide", "/settings"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["cache-control"], path).toBe("no-cache");
    }

    /*
     * **304 にはならない。** 画面の HTML には CSP の nonce が入って毎回変わる
     * (vite.config.ts の `csp`、docs/architecture.md の「画面で動いてよいもの」)。中身の指紋
     * (`etag`) も毎回変わるので、前の指紋で聞かれても中身を返し直す。HTML は小さく、
     * 重いもの (下の `_app/immutable/`) は永く持たせたままなので困らない
     */
    const first = await request.get("/");
    const again = await request.get("/", {
      headers: { "if-none-match": first.headers()["etag"] ?? "" },
    });
    expect(again.status()).toBe(200);

    /*
     * **名前に指紋が入っているものには口を出さない。** 永く持たせたい側で、
     * ここへ `no-cache` を撒くと毎回聞きに行くことになる
     */
    const chunk = await request.get("/");
    const asset = /\/_app\/immutable\/[^"']+\.js/.exec(await chunk.text())?.[0];
    expect(asset).toBeTruthy();
    const immutable = await request.get(asset as string);
    expect(immutable.headers()["cache-control"]).toContain("immutable");
  });

  /*
   * **中だけ動かす画面は、ページごと動かない。**
   *
   * 土台は `html` から `%` で採る。単位 (`vh` / `dvh`) で言い当てると、
   * **中身のほうが土台より高くなる**ことがある — 実機の PWA で
   * `100dvh` が 56px 大きく出て、二段組の画面がページごと動いていた。
   *
   * ブラウザの自動運転では引っ込むバーを作れないので、ここで見るのは
   * 「はみ出していないこと」。単位の食い違いはこの形で表に出る
   */
  test("二段組の画面はページごとスクロールしない", async ({ page }) => {
    for (const width of [768, 915, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      // 一覧の画面 (録画・ルール) はページごと巻く (`+layout.svelte` の `FILLED`)。自分で巻き取るのは番組表と映像の画面
      for (const path of ["/guide"]) {
        await goto(page, path);
        const doc = await page.evaluate(() => {
          const root = document.querySelector("[data-root]") as HTMLElement;
          return {
            scrollH: document.documentElement.scrollHeight,
            clientH: document.documentElement.clientHeight,
            rootH: Math.round(root.getBoundingClientRect().height),
          };
        });
        expect(
          doc.scrollH,
          `${path} が ${width}px で縦に流れる`,
        ).toBeLessThanOrEqual(doc.clientH + 1);
        /*
         * **土台は画面ちょうど。** 単位 (`vh` / `dvh`) で言い当てず、
         * `html` から `%` で降ろしているので、ずれようがない。
         * 実機では `100dvh` が 56px 大きく出て、ここがずれていた
         */
        expect(doc.rootH, `${path} の土台が ${width}px で画面と違う`).toBe(
          doc.clientH,
        );
      }
    }
  });

  /*
   * **土台は単位で高さを決めない。**
   *
   * `100vh` も `100dvh` も「画面の高さ」を*言い当てようとする*もので、
   * 携帯では当たらないことがある (実機の PWA で 56px 大きく出た)。
   * `html` に高さを与えて `%` で降ろせば、言い当てる余地が無い
   */
  test("土台の高さに画面単位を使わない", async () => {
    const layout = await readFile("src/routes/+layout.svelte", "utf8");
    // 土台は `<div class="shell">`。高さの決まりはそのファイルの <style> の `.shell` にある
    expect(
      /<div\s+class="shell\b/.test(layout),
      "土台の class が見つからない",
    ).toBe(true);
    const rules = [...layout.matchAll(/\.shell[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .join("\n");
    expect(rules).toContain("min-height: 100%");
    expect(rules).not.toMatch(/\d+(dvh|svh|lvh|vh)\b/);
  });

  /*
   * **`html` を `overflow: hidden` で止めてはいけない。**
   *
   * はみ出しは消えるが、Android の「引っ張って更新」まで消える。
   * PWA にはアドレスバーが無いので、**あれが唯一の更新手段** — 実機で
   * 「リロードできなくなった」として出た。塞ぐ側ではなく高さを合わせる
   */
  test("ページを動かす側は止めない (引っ張って更新が死ぬ)", async ({
    page,
  }) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      for (const path of ["/", "/guide", "/settings"]) {
        await goto(page, path);
        const overflow = await page.evaluate(
          () => getComputedStyle(document.documentElement).overflowY,
        );
        expect(overflow, `${path} が ${width}px で止められている`).not.toBe(
          "hidden",
        );
      }
    }
  });

  /*
   * **端末でしか出ない縦のはみ出しを、その端末で読むための表示。**
   *
   * 自動運転のブラウザには引っ込むアドレスバーが作れないので、
   * 「手元では出ないが実機では出る」を追う手が要る。ここで見るのは
   * 「付けたときだけ出る」ことと「数がそろっている」ことまで
   */
  test("?measure を付けたときだけ高さの表示が出る", async ({ page }) => {
    await goto(page, "/guide");
    await expect(page.getByTestId("measure")).toHaveCount(0);

    await goto(page, "/guide?measure");
    const badge = page.getByTestId("measure");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("はみ出し");
    await expect(badge).toContainText("dvh");

    // 読むための表示が、下のものを触れなくしては本末転倒
    expect(
      await badge.evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("none");

    // **URL には居座らせない。** 1回だけ見たいときの手なので、外せば消える
    await goto(page, "/guide");
    await expect(page.getByTestId("measure")).toHaveCount(0);
  });

  /*
   * **PWA にはアドレスバーが無い。**
   *
   * `?measure` を打つところがないので、設定画面から入れられないと
   * ホーム画面から開いたアプリでは一生出せない (実機で詰まった)。
   * 覚えるので、**リロードしても消えない** — 見たいのはまさにその後
   */
  test("高さの表示は設定からオンにできて、リロードしても消えない", async ({
    page,
  }) => {
    await goto(page, "/settings/general");
    await page.getByTestId("measure-toggle").check();
    await expect(page.getByTestId("measure")).toBeVisible();

    // アドレスバーを使わずに別の画面へ行っても付いてくる
    await goto(page, "/guide");
    await expect(page.getByTestId("measure")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("measure")).toBeVisible();

    // 後片付け。**入れっぱなしにしない**
    await goto(page, "/settings/general");
    await page.getByTestId("measure-toggle").uncheck();
    await expect(page.getByTestId("measure")).toHaveCount(0);
  });

  test("サービスワーカーが登録され、APIは横取りしない", async ({ page }) => {
    await goto(page, "/");
    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration !== undefined;
    });
    expect(registered).toBeTruthy();

    // 録画の配信は数十GB、通知は繋ぎっぱなしのSSE。載せると壊れる
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const entries = await Promise.all(
        keys.map(async (key) =>
          (await (await caches.open(key)).keys()).map((r) => r.url),
        ),
      );
      return entries.flat();
    });
    expect(cached.some((url) => url.includes("/api/"))).toBeFalsy();
  });

  test("狭い画面ではナビを畳んで、ページが横にはみ出さない", async ({
    page,
  }) => {
    /*
     * 項目を横に並べると、スマートフォンの幅ではヘッダーのほうが画面より
     * 広くなり、ページ全体が横にスクロールしていた。番組表を横に流すのと
     * 混ざって扱いにくいので、狭い画面ではハンバーガーに畳む
     */
    for (const width of [390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 780 });
      await goto(page, "/guide?type=GR");
      const doc = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(doc.scrollW).toBeLessThanOrEqual(doc.clientW);
    }

    /*
     * **番組表以外の画面も同じ。**
     *
     * ルール・設定 (チューナー・チャンネル) は表を並べていて、それが画面より広い。
     * 表が枠の中で横に流れるのは構わないが、**ページごと流れると**
     * ヘッダーも本文も一緒に動いて読めなくなる。
     *
     * 起きていたのはグリッドの列が縮まないため。列の既定は
     * `min-width: auto` なので、中の表が広いと列ごと広がり、
     * 中の `overflow-x-auto` は出番が来ない
     */
    for (const width of [390, 430, 768]) {
      await page.setViewportSize({ width, height: 780 });
      for (const path of [
        "/",
        "/rules",
        "/settings",
        "/settings/general",
        "/settings/recording",
        "/settings/reception",
        "/settings/integrations",
      ]) {
        await goto(page, path);
        const doc = await page.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        }));
        expect(
          doc.scrollW,
          `${path} が ${width}px で横に流れる`,
        ).toBeLessThanOrEqual(doc.clientW);
      }
    }

    /*
     * **狭い幅では、主な画面へのタブが画面の下に並ぶ。** 指が届くのは画面の下のほうで、
     * 上のハンバーガーに畳んでいた頃は、画面を移るたびに2回押していた。
     * ルールは「その他」の中 (チューナーは設定の節に移した)
     */
    await page.setViewportSize({ width: 390, height: 780 });
    await goto(page, "/");
    const tabbar = page.getByTestId("tabbar");
    await expect(tabbar).toBeVisible();
    const bar = (await tabbar.boundingBox())!;
    // 下の端から 0.5rem 離して浮かせる (操作の層。docs/design.md)
    expect(bar.y + bar.height, "タブが画面の下に浮いていない").toBeCloseTo(
      780 - 8,
      0,
    );
    await expect(page.getByTestId("tab-home")).toHaveAttribute(
      "aria-current",
      "page",
    );
    // 上のヘッダーにリンクは並べない (タブと二重になる)
    await expect(page.getByTestId("nav-guide")).toBeHidden();

    await page.getByTestId("tab-guide").click();
    await page.waitForURL(/guide/);
    await expect(page.getByTestId("tab-guide")).toHaveAttribute(
      "aria-current",
      "page",
    );

    const menu = page.getByTestId("nav-menu");
    await menu.getByRole("button", { name: "その他" }).click();
    // 中身はルール・設定のリンクだけ (テーマは設定の「この端末」、新しいバージョンは設定の入口の点)
    await expect(menu.getByRole("link")).toHaveText(["ルール", "設定"]);
    await expect(menu.getByRole("button", { name: /テーマ/ })).toHaveCount(0);
    await menu.getByRole("link", { name: "ルール" }).click();
    await page.waitForURL(/rules/);
    await expect(menu.getByRole("button", { name: "その他" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // 検索のタブは上の帯の欄に入った状態で開く (狭い画面ではヘッダーごと隠している)
    await expect(page.getByTestId("header-search")).toBeHidden();
    await page.getByTestId("tab-search").click();
    await page.waitForURL(/\/search$/);
    await expect(page.getByTestId("tab-search")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("search-input")).toBeFocused();

    // 広い幅では上のヘッダーにリンクと検索の欄を並べるので、タブは出さない
    await page.setViewportSize({ width: 1280, height: 780 });
    await expect(tabbar).toBeHidden();
    await goto(page, "/");
    await expect(page.getByTestId("header-search")).toBeVisible();
  });

  /*
   * **1000px 未満は下のタブにまとめる** (`#lib/phone-form.ts`)。タブレットや狭めた窓でもヘッダーを出さない。
   * 640px からはルール・設定もタブに並べて 6 つ (アイコンの下に字)。「その他」は中身が無くなるので出さず、
   * いまの画面の印 (タブの上端の短い線) はそのタブの真ん中に 1 つだけ付く
   */
  test("1000px 未満は下のタブ。640px からはルール・設定も並ぶ", async ({
    browser,
  }) => {
    const SIX = [
      "tab-home",
      "tab-guide",
      "tab-live",
      "tab-rules",
      "tab-search",
      "tab-settings",
    ];
    const sizes = [
      { width: 700, height: 600, touch: false },
      { width: 900, height: 640, touch: false },
      { width: 999, height: 700, touch: false },
      // 縦のタブレット (指の端末)
      { width: 820, height: 1180, touch: true },
      // 横にしたスマホ。一覧の画面では下のタブが出る (映像の画面では隠す。20-live)
      { width: 844, height: 390, touch: true },
    ];
    for (const size of sizes) {
      const label = `${size.width}x${size.height}`;
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        hasTouch: size.touch,
        isMobile: size.touch,
      });
      const page = await context.newPage();
      await goto(page, "/rules");
      const tabbar = page.getByTestId("tabbar");
      await expect(tabbar, label).toBeVisible();
      await expect(page.getByTestId("header-search"), label).toBeHidden();
      await expect(page.getByTestId("nav-rules"), label).toBeHidden();

      // 左から 録画・番組表・ライブ・ルール・検索・設定。的の幅はそろう。「その他」は出さない
      await expect(page.getByTestId("nav-menu"), label).toBeHidden();
      const boxes = [];
      for (const id of SIX) {
        await expect(page.getByTestId(id), `${label} ${id}`).toBeVisible();
        boxes.push((await page.getByTestId(id).boundingBox())!);
      }
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i]!.x, `${label} の並び`).toBeGreaterThan(boxes[i - 1]!.x);
        expect(
          Math.abs(boxes[i]!.width - boxes[0]!.width),
          `${label} の的の幅`,
        ).toBeLessThan(1);
      }

      // 印はルールのタブだけ
      await expect(page.getByTestId("tab-rules")).toHaveAttribute(
        "aria-current",
        "page",
      );
      const bar = (await tabbar.boundingBox())!;
      const mark = await tabbar.evaluate((el) => {
        const style = getComputedStyle(el, "::before");
        return {
          left: Number.parseFloat(style.left),
          width: Number.parseFloat(style.width),
        };
      });
      const rules = boxes[3]!;
      expect(
        Math.abs(
          bar.x + mark.left + mark.width / 2 - (rules.x + rules.width / 2),
        ),
        `${label} の印の位置`,
      ).toBeLessThan(2);

      // 設定へ移ると印も設定のタブへ
      await page.getByTestId("tab-settings").click();
      await page.waitForURL(/settings/);
      await expect(page.getByTestId("tab-settings")).toHaveAttribute(
        "aria-current",
        "page",
      );
      await context.close();
    }

    // 1000px からは今までどおり上のヘッダー (リンクと検索の欄)。下のタブは出さない
    const context = await browser.newContext({
      viewport: { width: 1000, height: 700 },
    });
    const page = await context.newPage();
    await goto(page, "/rules");
    await expect(page.getByTestId("tabbar")).toBeHidden();
    await expect(page.getByTestId("header-search")).toBeVisible();
    await expect(page.getByTestId("nav-rules")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.setViewportSize({ width: 999, height: 700 });
    await expect(page.getByTestId("tabbar")).toBeVisible();
    await expect(page.getByTestId("header-search")).toBeHidden();
    await context.close();
  });

  test("狭い画面の下のタブは、下へ読むと引っ込み、上へ戻すと出る", async ({
    page,
  }) => {
    /*
     * **読んでいる間は操作の層を引っ込める** (docs/design.md の「3 つの層」)。
     * 窓ごと巻く画面 (受信の設定) で、下へ送るとタブは画面の外へ、上へ戻すと元の位置に戻る
     */
    await page.setViewportSize({ width: 390, height: 780 });
    await goto(page, "/settings/reception");
    const tabbar = page.getByTestId("tabbar");
    const bottom = async () => {
      const box = (await tabbar.boundingBox())!;
      return box.y + box.height;
    };
    await expect.poll(bottom).toBeLessThanOrEqual(780);
    await page.mouse.move(195, 300);
    await page.mouse.wheel(0, 600);
    await expect
      .poll(async () => (await tabbar.boundingBox())!.y)
      .toBeGreaterThanOrEqual(780);
    await page.mouse.wheel(0, -600);
    await expect.poll(bottom).toBeLessThanOrEqual(780);

    // 画面を移ると出す
    await page.mouse.wheel(0, 600);
    await expect
      .poll(async () => (await tabbar.boundingBox())!.y)
      .toBeGreaterThanOrEqual(780);
    await goto(page, "/settings/general");
    await expect.poll(bottom).toBeLessThanOrEqual(780);
  });

  /*
   * 番組表は窓ではなく表の箱 (`.grid-box`) の中で巻くので、箱の縦の巻き取りで出し入れする (`+layout.svelte`)。
   * 表は画面の下の端まで伸びていて、出し入れで箱の大きさも巻いた位置も変わらない (中身が跳ねない)。
   * 開いたときの箱の位置は時刻で変わるので、時計を止めて 2 通り見る。昼は「いま」への位置合わせで巻かれていて、
   * 表の頭 (4:00) は頭のまま (初めての巻き取りで隠す)。夜遅くは開いた時点で表の最後に着いていて下へ送れない
   * (0 時台に CI で落ちていた) ので使わない
   */
  for (const [hours, when] of [
    [8, "昼"],
    [0, "表の頭"],
  ] as const) {
    test(`スマホの番組表は、表の箱を下へ送ると下のタブと操作の1行が引っ込み、上へ戻すと出る (${when})`, async ({
      page,
    }) => {
      await stopGuideClock(page, hours);
      await page.setViewportSize({ width: 390, height: 844 });
      await goto(page, "/guide?type=GR");
      const grid = page.getByTestId("guide-grid");
      await expect(page.getByTestId("program-button").first()).toBeVisible();
      const tabbar = page.getByTestId("tabbar");
      const bar = page.getByTestId("guide-toolbar");
      const top = async (locator: typeof bar) =>
        (await locator.boundingBox())!.y;
      const shown = async () => {
        await expect.poll(() => top(tabbar)).toBeLessThan(844);
        await expect.poll(() => top(bar)).toBeLessThan(await top(tabbar));
      };
      const size = () =>
        grid.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, height: el.clientHeight };
        });

      // 開いた直後 (「いま」への位置合わせで巻かれていても) は出ている。表は画面の下の端まで
      await shown();
      const opened = await size();
      expect(Math.abs(opened.bottom - 844)).toBeLessThanOrEqual(1);

      // 横に送っても出し入れしない
      await grid.evaluate((el) => {
        el.scrollLeft += 300;
      });
      await page.waitForTimeout(400);
      await shown();

      // 下へ送ると隠れる。箱の大きさと巻いた位置は、隠れる前後で変わらない
      await page.mouse.move(200, 400);
      await page.mouse.wheel(0, 400);
      await expect
        .poll(() => grid.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      await expect.poll(() => top(tabbar)).toBeGreaterThanOrEqual(844);
      await expect.poll(() => top(bar)).toBeGreaterThanOrEqual(844);
      const scrolled = await grid.evaluate((el) => el.scrollTop);
      await page.waitForTimeout(400);
      expect(await grid.evaluate((el) => el.scrollTop)).toBe(scrolled);
      expect(await size()).toEqual(opened);

      // 上へ戻すと出る
      await page.mouse.wheel(0, -200);
      await shown();
      expect(await size()).toEqual(opened);

      // 時刻へ送るボタン (狭い画面は日付のメニューの中) で動いたぶんでは隠さない (押した1行ごと消さない)
      await page.getByTestId("guide-date").click();
      await page.getByRole("menuitem", { name: /^夜/ }).click();
      await page.waitForTimeout(400);
      await shown();
    });
  }

  test("ホーム画面から開いた iPhone では、暗いテーマのときだけステータスバーの裏まで描く", async ({
    page,
  }) => {
    /*
     * 時刻の字は `black-translucent` でいつも白になるので、明るいテーマでは透かさない (iPhone が読むのは開いたときだけ)。
     * ホーム画面から開いたことは `navigator.standalone` で分かる (iPhone だけが持つ)
     */
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    const state = () =>
      page.evaluate(() => ({
        bar: document.documentElement.dataset["statusBar"] ?? null,
        viewport: document
          .querySelector('meta[name="viewport"]')
          ?.getAttribute("content"),
        style:
          document
            .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
            ?.getAttribute("content") ?? null,
      }));
    await goto(page, "/");
    expect(await state()).toEqual({
      bar: "translucent",
      viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
      style: "black-translucent",
    });
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await goto(page, "/");
    expect(await state()).toEqual({
      bar: null,
      viewport: "width=device-width, initial-scale=1",
      style: null,
    });
  });
});
