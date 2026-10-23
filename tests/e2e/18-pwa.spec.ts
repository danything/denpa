import { readFile } from "node:fs/promises";
import { expect, goto, test } from "./helpers";

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
    // 丸く切り抜かれる端末があるので、そのための版も要る
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
      for (const path of ["/", "/guide", "/rules"]) {
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
    await expect(menu.getByRole("link", { name: "チューナー" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "設定" })).toBeVisible();
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

  test("狭い画面の下のタブは、下へ読むと引っ込み、上へ戻すと出る", async ({
    page,
  }) => {
    /*
     * **読んでいる間は操作の層を引っ込める** (docs/design.md の「地・件の面・操作の層」)。
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
  });
});
