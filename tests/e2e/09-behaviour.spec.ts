import {
  cancelAllReservations,
  cellOf,
  clearRules,
  deleteRule,
  expect,
  goto,
  makeRule,
  reserveSoon,
  syncEpg,
  test,
  upcoming,
} from "./helpers";

/**
 * 画面の反応の確かめ。
 * 「押したのに何も起きない」「リロードすると変わっている」の類は
 * 見た目の問題に見えて実際には状態の取り扱いの誤りなので、ここで固定する。
 */
test.describe("操作したときの反応", () => {
  test.beforeEach(async ({ page, request }) => {
    await syncEpg(request);
    // 前のテストが残した予約やルールを片付ける。件数で判定するため
    await clearRules(page);
    await cancelAllReservations(page);
  });

  test("番組表で予約すると詳細が閉じ、予約済みになる", async ({ page }) => {
    await goto(page, "/guide?type=GR");

    const [target] = await upcoming(page);
    const block = cellOf(page, target.programId);
    await block.getByTestId("program-button").click();

    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();

    /*
     * EPG の符号はそのままでは読めないので、言葉に直して出す。
     *
     * **同じ分類が2つ来ても1つにまとめる。** 偽の放送は本物と同じく
     * `[アニメ, 拡張, 拡張]` を積んである (0xE は分類ではなく局が自分で決めた
     * 符号を載せる枠なので、同じものが並ぶ)。ラベルの字を一覧の目印にしていた頃は、
     * **同じラベルが2つあると Svelte が落ちて詳細が開かなかった**
     * (実機の高校野球中継。押しても何も起きない出方をする)
     */
    await expect(detail.getByTestId("detail-genre")).toHaveCount(2);
    await expect(detail.getByTestId("detail-genre").first()).toHaveText(
      "アニメ／特撮 > 国内アニメ",
    );
    await expect(detail.getByTestId("detail-genre").nth(1)).toHaveText("拡張");
    await expect(detail.getByTestId("detail-video")).toHaveText("1080i MPEG-2");
    /*
     * **音声が2本あるなら、見分けが付くように出す。**
     *
     * 解説放送や二重音声は、種別も言語も同じ音声が2本並ぶ。符号だけを見て
     * いた頃は**「ステレオ (日本語)」が2つ**出ていて、どちらが何なのか
     * 分からなかった (実機の日テレ「金曜ロードショー[解]」)。放送のほうは
     * `audio_component_descriptor` の `text_char` に名前を書いている
     */
    await expect(detail.getByTestId("detail-audio")).toHaveText([
      "主音声ステレオ (日本語)",
      "解説ステレオ (日本語)",
    ]);
    // どの局のものかは詳細だけ見ても分かるようにする。
    // 先頭に来るのがどちらの局かは時刻次第なので、地上波のどちらかであればよい
    await expect(detail).toContainText(/ＴＯＫＹＯ　ＭＸ|フジテレビ/);

    await detail.getByTestId("detail-reserve").click();

    // 押したら閉じる。開いたままだと予約できたのか分からない
    await expect(detail).toHaveCount(0);

    await expect(block).toContainText("予約済み");
  });

  /**
   * **詳細は押したらすぐ出し、足りない分は届いてから足す** (`guide/+page.svelte` の `open`)。
   *
   * 1 件ぶんの取得を待ってから出していた頃は、遠い回線 (車のタブレット) で押してから一拍以上
   * 何も起きなかった。取得を 3 秒遅らせて、押してから 2 コマ以内に箱が見えることと、
   * 届いたら音声・映像の札が足されることを見る。
   * サービスワーカーは止める (動いていると取得があちら経由になり、`page.route` で遅らせられない)
   */
  test.describe("詳細の開き方", () => {
    test.use({ serviceWorkers: "block" });

    test("番組表の詳細は取得を待たずに開き、届いたら中身が足される", async ({
      page,
    }) => {
      await goto(page, "/guide?type=GR");
      const [target] = await upcoming(page);
      await page.route("**/api/programs/*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.continue();
      });
      await page.evaluate(() => {
        const w = window as unknown as { shownAfter: number | null };
        w.shownAfter = null;
        document.addEventListener(
          "click",
          () => {
            let frames = 0;
            const tick = (): void => {
              frames++;
              if (
                document
                  .querySelector('[data-testid="program-detail"]')
                  ?.checkVisibility()
              ) {
                w.shownAfter = frames;
                return;
              }
              if (frames < 600) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          { capture: true, once: true },
        );
      });

      await cellOf(page, target.programId)
        .getByTestId("program-button")
        .click();
      const detail = page.getByTestId("program-detail");
      await expect(detail).toBeVisible();
      const shownAfter = await page.evaluate(
        () => (window as unknown as { shownAfter: number | null }).shownAfter,
      );
      expect(shownAfter, "押してから詳細が見えるまでのコマ数").not.toBeNull();
      expect(shownAfter).toBeLessThanOrEqual(2);
      // まだ届いていない分は無く、表が持っている分 (局名) は出ている
      await expect(detail.getByTestId("detail-video")).toHaveCount(0);
      await expect(detail).toContainText(/ＴＯＫＹＯ　ＭＸ|フジテレビ/);
      // 届いたら足される
      await expect(detail.getByTestId("detail-video")).toHaveText(
        "1080i MPEG-2",
      );
    });
  });

  test("番組表の時刻は縦横どちらへスクロールしても左に残る", async ({
    page,
  }) => {
    // 24時間ぶんを1画面には出せないので、どこを見ていても時刻が分かる必要がある。
    // 横は列ごと、縦は数字を1時間の枠の中で下ろして追従させている
    await page.setViewportSize({ width: 900, height: 700 });
    await goto(page, "/guide?type=GR");

    const grid = page.getByTestId("guide-grid");
    /*
     * **`style` の字面では探さない。** 表は後から流れてきて画面側で組むので
     * (`guide/+page.server.ts`)、`grid-column` と `grid-row` はブラウザが
     * `grid-area` にまとめ直す。SSR の頃の字面を当てにすると1つも見つからない
     */
    const hours = grid.locator("div.hour > span.hour-label");
    /*
     * 見えている表の上端は左上の角 (局名の行の頭)。広い画面では箱がヘッダーの裏まで伸びていて、
     * 箱の上端はヘッダーと操作の1行に隠れている (docs/design.md の「浮かせ方」)
     */
    const frame = (await grid.locator(".corner").boundingBox())!;

    for (const top of [0, 400, 900]) {
      await grid.evaluate((el, t) => {
        el.scrollTop = t;
        // 横に流しても時刻の列は左に残る
        el.scrollLeft = 300;
      }, top);
      // 画面の上端付近に、いま見ているところの時刻がちょうど1つ出ていること
      const shown: string[] = [];
      for (let i = 0; i < (await hours.count()); i++) {
        const box = await hours.nth(i).boundingBox();
        if (box === null) continue;
        if (
          box.y >= frame.y - 1 &&
          box.y < frame.y + 60 &&
          box.x < frame.x + 60
        ) {
          shown.push((await hours.nth(i).textContent())?.trim() ?? "");
        }
      }
      expect(shown).toHaveLength(1);
    }
  });

  test("番組表は列の合計ぶんの幅を持つ", async ({ page }) => {
    /*
     * 時刻の列が横に付いてこられるのは、外側の枠の中にいる間だけ。
     * 枠を画面の幅のままにして中身をはみ出させていた頃は、
     * 「画面の幅 − 時刻の列」ぶんスクロールしたところで置いていかれていた
     * (390px の端末で302pxから先)。枠を列の合計まで広げておけば端まで残る
     */
    await page.setViewportSize({ width: 320, height: 700 });
    await goto(page, "/guide?type=GR");

    const grid = page.getByTestId("guide-grid");
    const size = await grid.evaluate((el) => ({
      inner: Math.round(
        el.querySelector('[data-testid="guide-rows"]')!.getBoundingClientRect()
          .width,
      ),
      scroll: el.scrollWidth,
    }));
    expect(size.inner).toBe(size.scroll);
  });

  /*
   * **番組の詳細は、狭い画面でも画面の中に収まる。**
   *
   * daisyUI の既定は外枠が `inset: 0`、中身が `max-height: 100vh` で、どちらも
   * **アドレスバーが引っ込んだときの高さ**を指す。スマホでバーが出ていると
   * 中身が画面より高くなり、外枠の `overflow: clip` に上下とも切り落とされて
   * **タイトルも閉じるボタンも見えなくなる** (実機の Android Chrome)。
   *
   * 直したのは `dvh` (いま見えている高さ) と、上下の余白。ここで確かめられるのは
   * **余白のほう** — Playwright には引っ込むバーが無いので `dvh` と `vh` は同じ値
   * になる。余白が無いと、バーの出入りがそのまま切り落としになる。
   *
   * **画面は思い切り低くする。** 偽の放送は説明文が短いので、普通の高さだと
   * 中身が収まってしまい、直す前でも通ってしまう (実際に一度そうなった)
   */
  test("番組の詳細は、狭くて低い画面でも枠に収まる", async ({ page }) => {
    const view = { width: 390, height: 380 };
    await page.setViewportSize(view);
    await goto(page, "/guide?type=GR");

    // 説明がいちばん長いものを開く。短いものだと収まって当たり前になる
    const cells = await page.getByTestId("grid-program").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-program-id") ?? "",
        length: (node.textContent ?? "").length,
      })),
    );
    const target = cells.sort((a, b) => b.length - a.length)[0]!;
    await cellOf(page, target.id).getByTestId("program-button").click();

    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    const box = (await detail.locator("> div").first().boundingBox())!;

    // 狭い画面では下から出る一枚 (下端に付ける。下のバーの分は箱の中の余白 `safe-area-inset-bottom` で空ける)
    expect(
      box.y,
      "上が画面に貼り付いている (バーが出ると切れる)",
    ).toBeGreaterThanOrEqual(8);
    expect(
      box.y + box.height,
      "下が画面からはみ出している",
    ).toBeLessThanOrEqual(view.height);
    // タイトルは箱の中にある。中身が長くても、頭から読める
    const title = (await detail.locator("h3").boundingBox())!;
    expect(title.y).toBeGreaterThanOrEqual(box.y);
  });

  /*
   * **番組の詳細を閉じるのは左下の「閉じる」** (主のボタンは右)。Esc でも閉じる。
   * 狭い画面では下から出る一枚 (下端に付き、ボタンは全幅で、閉じるがいちばん下)
   */
  test("番組の詳細は左下の「閉じる」と Esc で閉じ、狭い画面では下から出る", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    await page.getByTestId("program-button").first().click();
    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    // 閉じるは並びの左端 (主のボタンより左)
    const close = (await detail.getByTestId("detail-close").boundingBox())!;
    const others = detail.locator(
      '.modal-actions :is(button, a.button):not([data-testid="detail-close"])',
    );
    for (const other of await others.all())
      expect(close.x).toBeLessThan((await other.boundingBox())!.x);
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    const view = { width: 390, height: 844 };
    await page.setViewportSize(view);
    await page.getByTestId("program-button").first().click();
    await expect(detail).toBeVisible();
    const box = (await detail.locator("> div").first().boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(view.height);
    expect(Math.round(box.width)).toBe(view.width);
    // 狭い画面では閉じるがいちばん下
    const closeY = (await detail.getByTestId("detail-close").boundingBox())!.y;
    for (const other of await detail
      .locator(
        '.modal-actions :is(button, a.button):not([data-testid="detail-close"])',
      )
      .all())
      expect(closeY).toBeGreaterThan((await other.boundingBox())!.y);
    await detail.getByTestId("detail-close").click();
    await expect(detail).toBeHidden();
  });

  test("スマホの幅でも番組表の操作は1行で、表の下・下のタブのすぐ上にある", async ({
    page,
  }) => {
    // 操作を2段に積んだり表の下を空けたりすると、1画面に入る時間が減る。親指が届くよう下に置く
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, "/guide?type=GR");

    // 今日を見ているときは「今日」を出さない (押しても同じ表)。そのぶん1行に収まる
    await expect(page.getByTestId("guide-today")).toHaveCount(0);
    const types = (await page.getByTestId("type-tabs").boundingBox())!;
    for (const id of ["next-day", "guide-date", "guide-genres"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(
        Math.abs(types.y + types.height / 2 - (box.y + box.height / 2)),
        id,
      ).toBeLessThan(4);
    }

    // ページごとは動かず、表だけが動く。表の下に操作の1行、その下端が下のタブの上端
    const fit = await page.evaluate(() => {
      const rect = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)!
          .getBoundingClientRect();
      const grid = rect("guide-grid");
      const bar = rect("guide-toolbar");
      const tabbar = rect("tabbar");
      return {
        scroll: document.documentElement.scrollHeight - innerHeight,
        above: bar.top - grid.bottom,
        gap: tabbar.top - bar.bottom,
        right: Math.max(
          ...[
            ...document.querySelectorAll('[data-testid="guide-toolbar"] *'),
          ].map((el) => el.getBoundingClientRect().right),
        ),
      };
    });
    expect(fit.scroll).toBe(0);
    expect(Math.abs(fit.above)).toBeLessThanOrEqual(1);
    expect(Math.abs(fit.gap)).toBeLessThanOrEqual(1);
    expect(fit.right, "操作が画面の右からはみ出している").toBeLessThanOrEqual(
      390,
    );

    // 日付を押すと、1週間ぶんと時刻のメニューが上へ開く
    await page.getByTestId("guide-date").click();
    const menu = page.getByTestId("guide-date-menu");
    await expect(menu).toBeVisible();
    const opened = (await menu.boundingBox())!;
    const trigger = (await page.getByTestId("guide-date").boundingBox())!;
    expect(opened.y + opened.height).toBeLessThanOrEqual(trigger.y);
    await expect(menu.locator('[aria-current="date"]')).toContainText("今日");
    await page.keyboard.press("Escape");

    await page.getByTestId("next-day").click();
    await expect(page.getByTestId("guide-today")).toBeVisible();
  });

  test("広い画面では日付を並べて押せ、今日には日付も添える", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await goto(page, "/guide?type=GR");
    const days = page.getByTestId("guide-day");
    // 今日から1週間ぶん (番組の無い日も押せないまま並ぶ)。前の日は番組が残っていれば今日の左に
    expect(await days.count()).toBeGreaterThanOrEqual(8);
    const today = page.locator('[data-testid="guide-day"].present');
    await expect(today).toHaveText(/^今日\d+\(.\)$/);
    await expect(today).toHaveAttribute("aria-current", "date");
    const index = await today.evaluate((el) =>
      [...el.parentElement!.children].indexOf(el),
    );
    for (let i = 0; i < index; i++)
      await expect(days.nth(i)).toHaveClass(/past/);
    // 入りきるので → は出さない。狭い画面の日付のメニューも出さない
    await expect(page.getByTestId("next-day")).toBeHidden();
    await expect(page.getByTestId("guide-date")).toBeHidden();

    // 1366px で全部が1行に収まる (時刻のボタンも「⋯」に畳まない)
    await expect(page.getByTestId("guide-jump-19")).toBeVisible();
    await expect(page.getByTestId("guide-more")).toBeHidden();
    const toolbar = page.getByTestId("guide-toolbar");
    const bar = (await toolbar.boundingBox())!;
    // 上の余白 (画面の頭の余白 `--dp-page-top`。浮いたヘッダーのぶん) を除いて、1行なら 70px ほど。2行に折れると 110px を超える
    const top = await toolbar.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).paddingTop),
    );
    expect(bar.height - top).toBeLessThan(80);

    // 番組の無い日は押せない (偽の放送は 30 時間ぶんなので、朝に流すと翌日はまだ無い)
    const later = page.locator(
      'a[data-testid="guide-day"]:not([aria-current])',
    );
    await expect(
      page.locator('span[data-testid="guide-day"]').first(),
    ).toHaveAttribute("aria-disabled", "true");
    if ((await later.count()) === 0) return;
    // 別の日を押すとその日が選ばれ、「今」は押せなくなる
    const start = await later.first().getAttribute("data-start");
    await later.first().click();
    await expect(
      page.locator(`[data-testid="guide-day"][data-start="${start}"]`),
    ).toHaveAttribute("aria-current", "date");
    await expect(page.getByTestId("guide-jump-now")).toBeDisabled();
    // 今日は選んでいなくても「今日」の印で分かる (選んでいる日は塗りで)
    await expect(today).not.toHaveAttribute("aria-current", "date");
    await expect(today).toHaveText(/^今日/);
  });

  test("時刻のボタンで表がその時刻へ送られる", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await goto(page, "/guide?type=GR");
    const grid = page.getByTestId("guide-grid");
    const rem = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const room = await grid.evaluate((el) => el.scrollHeight - el.clientHeight);
    // 表の頭は 4:00、5分で 0.75rem
    const at = (hour: number) => Math.min(room, (hour - 4) * 12 * 0.75 * rem);
    await page.getByTestId("guide-jump-6").click();
    await expect
      .poll(() => grid.evaluate((el) => el.scrollTop))
      .toBeCloseTo(at(6), 0);
    await page.getByTestId("guide-jump-19").click();
    await expect
      .poll(() => grid.evaluate((el) => el.scrollTop))
      .toBeCloseTo(at(19), 0);
    // 操作の1行は動かない (畳まない)
    const top = (await page.getByTestId("guide-toolbar").boundingBox())!.y;
    await page.getByTestId("guide-jump-now").click();
    const line = page.getByTestId("now-line");
    await expect(line).toBeInViewport();
    expect((await page.getByTestId("guide-toolbar").boundingBox())!.y).toBe(
      top,
    );
  });

  test("選んでいる印は 1 本だけ (切り替えの短い下線と重ねない)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    // ライブの種別のタブ (並びの印) と、ホームの頭の 1 行のチップ (自分の `::after`)
    for (const [url, selector] of [
      ["/live", '[data-testid^="live-type-"][aria-pressed="true"]'],
      ["/", '.t-chip[aria-pressed="true"]'],
    ] as const) {
      await goto(page, url);
      const pressed = page.locator(selector).first();
      await expect(pressed).toBeVisible();
      expect(
        await pressed.evaluate((el) => getComputedStyle(el).backgroundImage),
      ).toBe("none");
    }
  });

  test("放送中の番組は、過ぎた所を終わった番組より浅く沈める", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    /*
     * 番組表のデータに左右されないよう、1 つのマスに放送の時刻 (`--s` / `--e`) を置き直して比べる
     * (表のいま `--now` の前後に掛かれば放送中、前で終われば終わった番組)。ほかのスペックが番組表を
     * 入れ替えると、いま放送中の番組が無いことがある
     */
    const shade = (offset: { s: number; e: number }) =>
      page
        .getByTestId("program-button")
        .first()
        .evaluate((el, { s, e }) => {
          const now = parseFloat(
            getComputedStyle(el).getPropertyValue("--now"),
          );
          el.style.setProperty("--s", String(now + s));
          el.style.setProperty("--e", String(now + e));
          return getComputedStyle(el, "::before").backgroundColor;
        }, offset);
    const alpha = (color: string) =>
      Number(/[\d.]+(?=\)$)/.exec(color.replace(/ \/ /, ", "))?.[0] ?? 1);
    const airing = await shade({ s: -1, e: 1 });
    const done = await shade({ s: -2, e: -1 });
    expect(alpha(airing)).toBeLessThan(alpha(done));
  });

  test("ジャンルの見本はマスと同じ色で、押すとそのジャンルだけ目立つ", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    await page.getByTestId("guide-genres").click();
    const menu = page.getByTestId("guide-genre-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(13);

    // 表にあるジャンルを1つ選ぶ。見本の点の色はマスの時刻の前の点の色と同じ
    const genre = await page
      .locator('[data-testid="program-button"][data-genre]')
      .first()
      .getAttribute("data-genre");
    const swatch = await page
      .locator(
        `[data-testid="guide-genre-menu"] .swatch[data-genre="${genre}"]`,
      )
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const dot = await page
      .locator(`[data-testid="program-button"][data-genre="${genre}"] .num`)
      .first()
      .evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
    expect(dot).toBe(swatch);

    await menu.getByTestId(`genre-${genre}`).click();
    const opacity = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).opacity);
    expect(
      await opacity(`[data-testid="program-button"][data-genre="${genre}"]`),
    ).toBe("1");
    const other = `[data-testid="program-button"]:not([data-genre="${genre}"])`;
    if ((await page.locator(other).count()) > 0)
      expect(Number(await opacity(other))).toBeLessThan(1);

    // 「すべて」で戻す
    await page.getByTestId("guide-genres").click();
    await menu.getByTestId("genre-all").click();
    await expect(
      page.locator('[data-testid="program-button"].dim'),
    ).toHaveCount(0);
  });

  test("放送波を切り替えると横位置が先頭に戻る", async ({ page }) => {
    // 局の並びは放送波ごとに別物なので、前の位置から始まると左端の局が隠れる
    await page.setViewportSize({ width: 320, height: 700 });
    await goto(page, "/guide?type=GR");

    const grid = page.getByTestId("guide-grid");
    await grid.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    expect(await grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    await page.getByTestId("type-BS").click();
    await expect(page.getByTestId("type-BS")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  test("ホームで取り消すと、その場で一覧から消える", async ({
    page,
    request,
  }) => {
    await reserveSoon(page, request, "GR", 6);

    await goto(page, "/");
    const rows = page.getByTestId("reservation-row");
    await expect(rows).toHaveCount(1);

    await page.getByTestId("cancel-button").first().click();
    // リロードせずに反映されること
    await expect(rows).toHaveCount(0);
  });

  test("ルールを消すと、そのルールが作った予約も消える", async ({ page }) => {
    // ルールを作ると、条件に合う番組の予約がその場で立つ
    // 偽の放送は同じタイトルを何度も流す。見たいのは予約が立つことなので、同じ回を1度にまとめない
    await page.setViewportSize({ width: 1440, height: 900 });
    await makeRule(page, "テストアニメ", { dedupe: false });

    await goto(page, "/");
    await expect(page.getByTestId("reservation-row").first()).toBeVisible();
    const before = await page.getByTestId("reservation-row").count();
    expect(before).toBeGreaterThan(0);

    await goto(page, "/rules");
    await deleteRule(page.getByTestId("rule-row").first());
    await expect(page.getByTestId("rule-row")).toHaveCount(0);

    // ルールが無くなったのに予約だけ残ると、止めたつもりが録れ続ける
    await goto(page, "/");
    await expect(page.getByTestId("reservation-row")).toHaveCount(0);
  });
});

test.describe("プルダウン", () => {
  test("マウスの画面では開いた一覧を自前の姿にし、選んでいるものは主の色の太字", async ({
    page,
  }) => {
    await goto(page, "/settings/reception");
    const select = page.locator('select[name="types"]');
    test.skip(
      !(await page.evaluate(() => CSS.supports("appearance", "base-select"))),
      "base-select を知らないブラウザはブラウザの一覧のまま",
    );
    expect(await select.evaluate((el) => getComputedStyle(el).appearance)).toBe(
      "base-select",
    );
    await select.click();
    expect(await select.evaluate((el) => el.matches(":open"))).toBe(true);
    const checked = select.locator("option:checked");
    expect(
      await checked.evaluate((el) => getComputedStyle(el).fontWeight),
    ).not.toBe("400");
  });

  test.describe("指の端末", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 800 },
    });
    test("ブラウザ・OS の選び方のまま", async ({ page }) => {
      await goto(page, "/settings/reception");
      const select = page.locator('select[name="types"]');
      expect(
        await select.evaluate((el) => getComputedStyle(el).appearance),
      ).not.toBe("base-select");
    });
  });
});
