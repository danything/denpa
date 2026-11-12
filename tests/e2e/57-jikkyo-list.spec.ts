import type { Page } from "@playwright/test";

import { BS11, FUJI, MX } from "../fake/services";
import { expect, goto, pickCodec, test, wakeControls } from "./helpers";
import { deviceOn, fakeNx, ranked, setJikkyo } from "./jikkyo";

/**
 * **実況のコメントの一覧と「実況」タブ** (docs/watch.md の「実況」)。流れるコメントと操作バーの重なりもここで見る。
 * 偽物の作り方と、テストどうしが状態を当てにしないことは 57-jikkyo の冒頭にある
 */

// ライブは MPEG-2 のまま観る (`pickCodec`)。MPEG-2 をデコードできる端末として開く (`stack.ts` の `liveWithoutMpeg2`)
test.use({ liveMpeg2: true });

test.describe("実況のコメントの一覧", () => {
  test("右端の列のボタンで右の列の先頭に出し、端末に覚える。「最新へ」は上へ巻いたときだけ出す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page);
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      await expect(page.getByTestId("jikkyo-list")).toHaveCount(0);
      await wakeControls(page, "live-frame");
      const button = page.getByTestId("live-jikkyo-list");
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect(
        await page.evaluate(() => localStorage.getItem("player-jikkyo-list")),
      ).toBe("1");

      // 局の一覧はそのまま下に残る
      const list = page.getByTestId("jikkyo-list");
      const box = (await list.boundingBox())!;
      const channels = (await page.getByTestId("live-channels").boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(channels.y);

      const rows = page.getByTestId("jikkyo-list-row");
      await expect(rows.first()).toContainText("テストのコメント", {
        timeout: 20_000,
      });
      await expect(
        page.getByRole("list", { name: "実況のコメント" }),
      ).toBeVisible();
      // 時刻は h:mm:ss
      await expect(rows.first().locator("time")).toHaveText(
        /^\d{1,2}:\d{2}:\d{2}$/,
      );
      await expect(page.getByTestId("jikkyo-list-force")).not.toHaveText(
        /勢い 0$/,
      );
      const scroller = page.getByTestId("jikkyo-list-rows");
      const latest = page.getByTestId("jikkyo-list-latest");
      const gap = () =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        );
      // 行が少ないうちも下に寄せる (いちばん新しい行が一覧の下の端)。行は次々に届くので、一覧と最後の行の
      // 位置は 1 度の evaluate で読む (別々に読むと、間に届いた 1 行ぶんずれる)
      await expect
        .poll(() =>
          scroller.evaluate((el) => {
            const all = el.querySelectorAll("[data-testid=jikkyo-list-row]");
            const last = all[all.length - 1];
            if (last === undefined) return Infinity;
            return (
              el.getBoundingClientRect().bottom -
              last.getBoundingClientRect().bottom
            );
          }),
        )
        .toBeLessThan(2);
      // 巻けるほど貯まるのを待つ。付いていく間は、増えても「最新へ」を出さない
      await expect
        .poll(() => rows.count(), { timeout: 20_000 })
        .toBeGreaterThan(30);
      for (let i = 0; i < 4; i++) {
        await expect(latest).toHaveCount(0);
        expect(await gap()).toBeLessThan(10);
        await page.waitForTimeout(250);
      }
      // ポインタが乗っている間は止めるが、下にいるなら「最新へ」は出さない (いちばん新しい行に重なる)
      // 乗せるのは座標で (行の `hover()` は、増えて動いている行を見える所へ巻き直し、一覧が 1 行ぶん上へずれる)
      const area = (await scroller.boundingBox())!;
      await page.mouse.move(area.x + area.width / 2, area.y + area.height - 4);
      await page.waitForTimeout(300);
      const before = await rows.last().textContent();
      await page.waitForTimeout(1_500);
      await expect(latest).toHaveCount(0);
      expect(await rows.last().textContent()).toBe(before);
      // 離れて 1 秒たったら、また付いていく
      await page.mouse.move(0, 0);
      await expect
        .poll(() => rows.last().textContent(), { timeout: 5_000 })
        .not.toBe(before);
      await expect(latest).toHaveCount(0);
      // ライブにこの先は無い
      await expect(page.getByTestId("jikkyo-list-ahead")).toHaveCount(0);
      await expect(page.getByTestId("jikkyo-list-ahead-row")).toHaveCount(0);
      // 上へ巻くと出す
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(latest).toBeVisible();
      await expect(latest).toHaveText("最新へ");
      await latest.click();
      await expect(latest).toBeHidden();
      expect(await gap()).toBeLessThan(10);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("スマホの縦では、映像の下・局の一覧の上に出し、書き込む 1 行は一覧の下に付く", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true });
      await deviceOn(page);
      await page.addInitScript(() =>
        localStorage.setItem("player-jikkyo-list", "1"),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await goto(page, `/live?service=${MX.id}`);
      const list = page.getByTestId("jikkyo-list");
      await expect(list).toBeVisible();
      const box = (await list.boundingBox())!;
      const frame = (await page.getByTestId("live-frame").boundingBox())!;
      const channels = (await page.getByTestId("live-channels").boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(frame.y + frame.height);
      expect(box.y + box.height).toBeLessThanOrEqual(channels.y);
      // 幅からはみ出さない
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const compose = (await page.getByTestId("jikkyo-compose").boundingBox())!;
      const rows = (await page.getByTestId("jikkyo-list-rows").boundingBox())!;
      expect(compose.y).toBeGreaterThanOrEqual(rows.y + rows.height);
      expect(compose.y + compose.height).toBeLessThanOrEqual(
        box.y + box.height,
      );
      expect(compose.x + compose.width).toBeLessThanOrEqual(390);
    } finally {
      await setJikkyo(page, false);
    }
  });
});

test.describe("「実況」タブ", () => {
  /** 一覧に並んだ局の ID (上から) */
  const order = (page: Page) =>
    page
      .getByTestId("live-channel")
      .evaluateAll((rows) =>
        rows.map((row) => Number((row as HTMLElement).dataset["service"])),
      );

  test("どちらかの設定がオフならタブを出さない", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      // 端末の ⚙ はオフのまま
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-type-GR")).toBeVisible();
      await expect(page.getByTestId("live-type-jikkyo")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
    await deviceOn(page);
    await goto(page, `/live?service=${MX.id}`);
    await expect(page.getByTestId("live-type-GR")).toBeVisible();
    await expect(page.getByTestId("live-type-jikkyo")).toHaveCount(0);
  });

  /**
   * 勢いの中継を偽物に (サーバから NX-Jikkyo へは行かせない)。
   * 1 回目は フジ > BS11 > MX、2 回目からは MX > BS11 > フジ
   */
  async function fakeRanking(page: Page): Promise<void> {
    const replies = [
      [
        { serviceId: MX.id, force: 5 },
        { serviceId: FUJI.id, force: 40 },
        { serviceId: BS11.id, force: 20 },
      ],
      [
        { serviceId: MX.id, force: 100 },
        { serviceId: FUJI.id, force: 1 },
        { serviceId: BS11.id, force: 2 },
      ],
    ];
    let asked = 0;
    await page.unroute("**/api/jikkyo/ranking");
    ranked.add(page);
    await page.route("**/api/jikkyo/ranking", (route) => {
      const channels = replies[Math.min(asked, replies.length - 1)];
      asked++;
      return route.fulfill({ json: { at: Date.now(), channels } });
    });
  }

  /** タブを開き、1 回目の返事で並ぶまで */
  async function openTab(page: Page): Promise<void> {
    await deviceOn(page);
    await goto(page, `/live?service=${MX.id}`);
    await page.getByTestId("live-type-jikkyo").click();
    await expect(page.getByTestId("live-force").first()).toContainText("40");
    expect((await order(page)).slice(0, 3)).toEqual([FUJI.id, BS11.id, MX.id]);
  }

  /** 見えるようになったことにして、30 秒待たずに取り直させる (2 回目の返事)。MX の数字が替わるまで */
  async function refresh(page: Page): Promise<void> {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page
        .locator(`[data-testid="live-channel"][data-service="${MX.id}"]`)
        .getByTestId("live-force"),
    ).toContainText("100");
  }

  /** 行が滑り始めた回数を数える (並べ直した行の `translate` の transition) */
  async function countSlides(page: Page): Promise<() => Promise<number>> {
    await page.evaluate(() => {
      const box = window as unknown as { slides: number };
      box.slides = 0;
      document.addEventListener("transitionrun", (event) => {
        if (event.propertyName === "translate") box.slides++;
      });
    });
    return () =>
      page.evaluate(() => (window as unknown as { slides: number }).slides);
  }

  /*
   * ライブに戻ったとき、コメントを流している端末では「実況」タブを開いておく (局の種別のタブではなく)。
   * 押して選んだタブはページにいる間はそのまま
   */
  test("両方オンなら開いたときは「実況」タブ。押して選んだタブはそのまま", async ({
    page,
  }) => {
    await fakeRanking(page);
    await setJikkyo(page, true);
    try {
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-type-jikkyo")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByTestId("live-type-GR")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await expect(page.getByTestId("live-force").first()).toBeVisible();
      await page.getByTestId("live-type-GR").click();
      await expect(page.getByTestId("live-type-GR")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      await setJikkyo(page, false);
    }
    // 世帯の設定がオフならタブは無く、いま映している局の種別
    await goto(page, `/live?service=${MX.id}`);
    await expect(page.getByTestId("live-type-GR")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("数字が新しくなるたびに勢いの順に並べ直す。動きを減らす設定では滑らせずに置き換える", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeRanking(page);
      await openTab(page);
      const slid = await countSlides(page);
      await refresh(page);
      expect((await order(page)).slice(0, 3)).toEqual([
        MX.id,
        BS11.id,
        FUJI.id,
      ]);
      // E2E の既定は動きを減らす設定 (`playwright.config.ts`)。時間が 0 なので滑らない
      expect(await slid()).toBe(0);
      // ほかのタブには数を付けない
      await page.getByTestId("live-type-GR").click();
      await expect(page.getByTestId("live-force")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("動きを減らす設定でなければ、並べ直した行は前の場所から滑る", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await setJikkyo(page, true);
    try {
      await fakeRanking(page);
      await openTab(page);
      const slid = await countSlides(page);
      await refresh(page);
      expect((await order(page)).slice(0, 3)).toEqual([
        MX.id,
        BS11.id,
        FUJI.id,
      ]);
      await expect.poll(slid).toBeGreaterThan(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("一覧にポインタが乗っている間は並べ直さず、離れたら並べ直す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeRanking(page);
      await openTab(page);
      const first = await order(page);
      // 押そうとして 3 番目の行 (MX) に乗せる
      const mx = page.locator(
        `[data-testid="live-channel"][data-service="${MX.id}"]`,
      );
      await mx.hover();
      await refresh(page);
      // 数字は替わるが、並びはそのまま。待っても乗っている間は替えない
      expect(await order(page)).toEqual(first);
      await page.waitForTimeout(1_500);
      expect(await order(page)).toEqual(first);
      // 離れたら (少し待って) 並べ直す
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await order(page)).slice(0, 3))
        .toEqual([MX.id, BS11.id, FUJI.id]);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("読めないときは番号順で並べ、一覧の先頭に 1 行だけ出す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await deviceOn(page);
      // deviceOn の空の返事より後に足す (後で足した route が先に効く)
      await page.route("**/api/jikkyo/ranking", (route) =>
        route.fulfill({ status: 503, body: "いまは勢いを読めません" }),
      );
      await goto(page, `/live?service=${MX.id}`);
      await page.getByTestId("live-type-jikkyo").click();
      await expect(page.getByTestId("live-ranking-note")).toHaveText(
        "いまは勢いを読めません",
      );
      await expect(page.getByTestId("live-force")).toHaveCount(0);
      // 番号順 (地上波 → BS)
      const ids = await order(page);
      expect(ids.indexOf(BS11.id)).toBeGreaterThan(ids.indexOf(MX.id));
    } finally {
      await setJikkyo(page, false);
    }
  });
});

/*
 * **流れるコメントは操作バーの影より上、ボタンより下** (`ControlBar`)。影とボタンが 1 つの段だった頃は、右端の列の所で
 * コメントが影に潜り、暗く欠けて見えた。重なりの順は当たり判定の順と同じなので、確かめる間だけコメントと影に
 * 当たり判定を持たせ、`elementFromPoint` で上にあるものを読む
 */
test.describe("実況のコメントと操作バーの重なり", () => {
  test.use({ reducedMotion: "no-preference" });

  test("コメントは右端の列と下の操作バーの影より上を通り、ボタンはその上で押せる", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await setJikkyo(page, true);
    try {
      await fakeNx(page, {
        texts: ["右の列の下を通るコメント", "下の字"],
        mails: [undefined, "shita"],
      });
      await deviceOn(page);
      await page.setViewportSize({ width: 1600, height: 900 });
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      await expect(page.getByTestId("jikkyo-comment").first()).toBeVisible({
        timeout: 30_000,
      });

      // 段の数: 影 7 → 実況 8 → 字幕 9 → ボタン 10
      expect(
        await page.evaluate(() => {
          const z = (el: Element | null, pseudo?: string) =>
            el === null ? null : getComputedStyle(el, pseudo).zIndex;
          const side = document.querySelector(
            '[data-testid="live-shot"]',
          )!.parentElement!;
          const bottom = document.querySelector(
            '[data-testid="live-controls"]',
          )!;
          return {
            右の影: z(side.parentElement, "::before"),
            下の影: z(bottom, "::before"),
            実況: z(document.querySelector('[data-testid="jikkyo-layer"]')),
            字幕: z(document.querySelector('[data-testid="live-captions"]')),
            右のボタン: z(side),
            下のボタン: z(bottom.querySelector(":scope > [data-bar-items]")),
            外の箱: [z(side.parentElement), z(bottom)],
          };
        }),
      ).toEqual({
        右の影: "7",
        下の影: "7",
        実況: "8",
        字幕: "9",
        右のボタン: "10",
        下のボタン: "10",
        外の箱: ["auto", "auto"],
      });

      // 流れるものが切り抜きのボタンを横切り、下の行に止めたものが下の操作バーの影に掛かったところで止める
      await expect
        .poll(
          async () => {
            await wakeControls(page, "live-frame");
            return page.evaluate(() => {
              const button = document
                .querySelector('[data-testid="live-shot"]')!
                .getBoundingClientRect();
              const comments = [
                ...document.querySelectorAll('[data-testid="jikkyo-comment"]'),
              ];
              const across = comments.some((c) => {
                const r = c.getBoundingClientRect();
                return (
                  r.left < button.left - 60 &&
                  r.right > button.right + 10 &&
                  r.top < button.top + button.height / 2 &&
                  r.bottom > button.top + button.height / 2
                );
              });
              const below = comments.some((c) => c.textContent === "下の字");
              if (!across || !below) return false;
              for (const a of document.getAnimations()) a.pause();
              return true;
            });
          },
          { timeout: 90_000, intervals: [30] },
        )
        .toBe(true);
      await wakeControls(page, "live-frame");

      const hits = await page.evaluate(() => {
        const button = document.querySelector<HTMLElement>(
          '[data-testid="live-shot"]',
        )!;
        const b = button.getBoundingClientRect();
        const y = b.top + b.height / 2;
        const at = (x: number, yy: number) => {
          const hit = document.elementFromPoint(x, yy);
          if (hit === null) return "なし";
          if (button.contains(hit)) return "ボタン";
          if (hit.closest('[data-testid="jikkyo-comment"]')) return "コメント";
          if (hit.closest(":has(> [data-bar-items]), [data-bar-items]"))
            return "操作バー";
          return hit.getAttribute("data-testid") ?? hit.tagName;
        };
        const real = at(b.left + b.width / 2, y);
        // 確かめる間だけ、コメントと影に当たり判定を持たせる
        const probe = document.createElement("style");
        probe.textContent =
          '[data-testid="jikkyo-layer"] * { pointer-events: auto !important; } :has(> [data-bar-items])::before { pointer-events: auto !important; }';
        document.head.append(probe);
        const bottom = [
          ...document.querySelectorAll('[data-testid="jikkyo-comment"]'),
        ]
          .find((c) => c.textContent === "下の字")!
          .getBoundingClientRect();
        const bar = document
          .querySelector('[data-testid="live-controls"]')!
          .getBoundingClientRect();
        const onButton = at(b.left + b.width / 2, y);
        // 影の所は、ボタンの並びの箱 (透明) を外して、その下のコメントと影のどちらが上かを読む
        const items = document.createElement("style");
        items.textContent =
          "[data-bar-items], [data-bar-items] * { pointer-events: none !important; }";
        document.head.append(items);
        const result = {
          押すとき: real,
          ボタンの所: onButton,
          右の影の所: at(b.left - 30, y),
          下の行: bottom.bottom > bar.top,
          下の影の所: at(
            bottom.left + bottom.width / 2,
            bottom.top + bottom.height / 2,
          ),
        };
        items.remove();
        probe.remove();
        return result;
      });
      expect(hits).toEqual({
        押すとき: "ボタン",
        ボタンの所: "ボタン",
        右の影の所: "コメント",
        下の行: true,
        下の影の所: "コメント",
      });
    } finally {
      await setJikkyo(page, false);
    }
  });
});
