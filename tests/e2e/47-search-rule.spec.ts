import { BS11 } from "../fake/services";
import {
  cancelAllReservations,
  clearRules,
  expect,
  goto,
  syncEpg,
  test,
} from "./helpers";

/**
 * **検索からルールを作る** (検索の画面の右の「ルールとして保存」)。探した言葉から始めて条件を詰め、
 * 結果の「これからの放送」の行ごとに「録る / 録らない (理由) / 予約済み」を見ながら保存する
 */
test.describe("検索からルールを作る", () => {
  test.beforeEach(async ({ page, request }) => {
    await syncEpg(request);
    await clearRules(page);
  });

  test("条件を変えると行の「録るか」が変わり、保存したルールを開いて直せる", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, `/search?q=${encodeURIComponent("テストアニメ")}`);

    // 広い画面では右の列。キーワードは探した言葉から始まる
    const draft = page.getByTestId("rule-draft");
    await expect(draft).toBeVisible();
    await expect(page.getByTestId("rule-keyword")).toHaveValue("テストアニメ");
    await expect(page.getByTestId("rule-dedupe")).toBeChecked();
    const shape = await page.evaluate(() => {
      const box = document
        .querySelector('[data-testid="rule-draft"]')!
        .getBoundingClientRect();
      return {
        right: Math.round(window.innerWidth - box.right),
        top: Math.round(box.top),
      };
    });
    // 画面の右端に付き、ヘッダーのすぐ下から
    expect(shape.right).toBe(0);
    expect(shape.top).toBeLessThan(80);
    // 先の放送まで並べる (前のテストが取り消した近い放送は「取り消し済み」になる)
    await page.getByTestId("search-more-programs").click();

    /*
     * 行ごとに「録る / 録らない」が付く。同じ回のどれを録るかは、前のテストが残した録画や
     * チューナー不足の予約で変わるので、ここでは決め打ちしない (rule-preview.test.ts が見る)
     */
    const verdict = (kind: string, station?: string) =>
      page
        .locator(`[data-testid="search-program"][data-verdict="${kind}"]`)
        .filter(station === undefined ? {} : { hasText: station })
        .first();
    await expect(page.getByTestId("search-verdict").first()).toHaveText(
      /^録(る|らない)$/,
    );
    await expect(page.getByTestId("rule-submit")).toHaveText(
      /^(\d+ 件を録る)?ルールを保存$/,
    );

    // 除外する言葉に当たる行は「除外」
    await page.getByTestId("rule-ignore").fill("決戦");
    await expect(
      page.locator('[data-testid="search-program"][data-verdict="record"]'),
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("search-verdict-reason")
        .filter({ hasText: "除外" })
        .first(),
    ).toBeVisible();
    await page.getByTestId("rule-ignore").fill("");

    // 地上波だけにすると、BS の行は「局」
    await page.getByTestId("channel-summary").click();
    const gr = page.getByTestId("rule-types").locator('input[value="GR"]');
    await gr.check();
    await expect(
      verdict("skip", BS11.name).getByTestId("search-verdict-reason"),
    ).toHaveText("局");
    await gr.uncheck();

    // BS11 だけにして同じ回をまとめなければ、BS11 の行は「録る」
    await page
      .getByTestId("rule-services")
      .locator(`input[value="${BS11.id}"]`)
      .check();
    await expect(page.getByTestId("channel-summary")).toContainText(BS11.name);
    await page.getByTestId("rule-dedupe").uncheck();
    await expect(
      verdict("record", BS11.name).getByTestId("search-verdict"),
    ).toHaveText("録る");

    // 保存すると、そのルールへの入口が出る
    await page.getByTestId("rule-submit").click();
    const link = page.getByTestId("rule-saved-link");
    await expect(link).toHaveText("テストアニメ");
    /*
     * 保存したら、「録る」と出ていた BS11 の行は予約が立って「予約済み」になる。下見と予約を立てるのは
     * 同じ判定なので、「録る」のまま残る行は無い (前のテストが取り消した放送は、はじめから「取り消し済み」)
     */
    await expect(
      page
        .locator('[data-testid="search-program"][data-verdict="record"]')
        .filter({ hasText: BS11.name }),
    ).toHaveCount(0);

    // 開くと書く欄にそのルール。URL のまま開き直しても同じ
    await link.click();
    await page.waitForURL(/\/search\?rule=\d+$/);
    await expect(page.getByTestId("rule-mode")).toContainText(
      "編集中: テストアニメ",
    );
    await expect(page.getByTestId("rule-dedupe")).not.toBeChecked();
    await page.reload();
    await expect(page.getByTestId("rule-mode")).toContainText(
      "編集中: テストアニメ",
    );
    // 言葉なしで開いたら、結果の代わりにそのルールで録る番組を出す
    await expect(
      page.getByTestId("rule-preview").getByTestId("preview-row").first(),
    ).toBeVisible();

    // 行は1本ずつ扱える: 押すと番組の詳細、予約の立っている行はその場で取消。取り消すと「取り消し済み」に変わる
    const reserved = page
      .getByTestId("rule-preview")
      .getByTestId("preview-row")
      .filter({ has: page.getByTestId("preview-cancel") })
      .last(); // 先の放送 (近い放送は数秒で始まって一覧から抜ける)
    const programId = await reserved.getAttribute("data-program-id");
    await reserved.getByTestId("preview-open").click();
    await expect(page.getByTestId("program-detail")).toBeVisible();
    await page.getByTestId("detail-close").click();
    await expect(page.getByTestId("program-detail")).toHaveCount(0);
    await reserved.getByTestId("preview-cancel").click();
    const same = page.locator(
      `[data-testid="preview-row"][data-program-id="${programId}"]`,
    );
    await expect(same.getByTestId("preview-cancel")).toHaveCount(0);
    await expect(same).toContainText("取り消し済み");

    // 直して更新
    await page.getByTestId("rule-priority").selectOption("3");
    await page.getByTestId("rule-update").click();
    await expect(page.getByTestId("rule-saved")).toContainText("更新しました");
    await page.reload();
    await expect(page.getByTestId("rule-priority")).toHaveValue("3");

    // 無効化・有効化
    await page.getByTestId("rule-toggle").click();
    await expect(page.getByTestId("rule-toggle")).toHaveText("有効化");
    await expect(page.getByTestId("rule-draft")).toContainText("無効");
    await page.getByTestId("rule-toggle").click();
    await expect(page.getByTestId("rule-toggle")).toHaveText("無効化");

    // 削除は2回押し。消したら `?rule=` を外して出直す
    await page.getByTestId("rule-delete").click();
    await page.getByTestId("rule-delete-confirm").click();
    await page.waitForURL((url) => !url.searchParams.has("rule"));
    await expect(page.getByTestId("rule-deleted")).toBeVisible();

    // 無いルールの `?rule=` は外して出直す (直すつもりで新しいルールを作らせない)
    await goto(page, "/search?rule=999999&q=x");
    await expect(page).toHaveURL(/\/search\?q=x$/);

    await cancelAllReservations(page);
  });

  /**
   * **時間帯と曜日** (`rules.time_from` / `time_to` / `weekdays`)。スイッチ (同じ回・前の回) が条件の行
   * (局・ジャンル・時間帯と曜日) の上にあり、優先度はその下、時間帯を入れると行の「録る」が変わる。判定の端は rules.test.ts が見る
   */
  test("時間帯を入れると行の「録る」が変わる", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, `/search?q=${encodeURIComponent("テストアニメ")}`);
    await page.getByTestId("rule-dedupe").uncheck();

    // スイッチ (同じ回・前の回) が上、その下に局・ジャンル・時間帯と曜日、最後に優先度
    const top = async (id: string) =>
      (await page.getByTestId(id).boundingBox())!.y;
    const order = [
      await top("rule-dedupe"),
      await top("rule-skip-earlier"),
      await top("channel-summary"),
      await top("genre-summary"),
      await top("slot-summary"),
      await top("rule-priority"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await expect(page.getByTestId("slot-summary")).toContainText("いつでも");

    // 「録る」の行を1つ選び、その始まりの1分だけを外す時間帯にする (日をまたぐ書き方)
    const row = page
      .locator('[data-testid="search-program"][data-verdict="record"]')
      .first();
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-program-id");
    const text = await row.textContent();
    const [, hh, mm] = text!.match(/(\d{2}):(\d{2})〜/)!;
    const start = Number(hh) * 60 + Number(mm);
    const clock = (minutes: number) =>
      `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const same = page.locator(
      `[data-testid="search-program"][data-program-id="${id}"]`,
    );

    await page.getByTestId("slot-summary").click();
    await page.getByTestId("rule-time-from").fill(clock(start + 1));
    await page.getByTestId("rule-time-to").fill(clock(start));
    await expect(same).toHaveAttribute("data-verdict", "skip");
    await expect(same.getByTestId("search-verdict-reason")).toHaveText(
      "時間帯の外",
    );
    await expect(page.getByTestId("slot-summary")).toContainText(
      `${clock(start + 1)}〜${clock(start)}`,
    );

    // 始まりから1分だけにすると、また「録る」
    await page.getByTestId("rule-time-from").fill(clock(start));
    await page.getByTestId("rule-time-to").fill(clock(start + 1));
    await expect(same).toHaveAttribute("data-verdict", "record");

    // 始まりと終わりが同じなら保存できない
    await page.getByTestId("rule-time-to").fill(clock(start));
    await expect(page.getByTestId("rule-slot-error")).toHaveText(
      "始まりと終わりが同じです",
    );
    await expect(page.getByTestId("rule-submit")).toBeDisabled();
  });

  test("条件が空のルールは作れない", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
    await page.getByTestId("rule-keyword").fill("");
    await expect(page.getByTestId("rule-submit")).toBeDisabled();
    await expect(page.getByTestId("rule-draft-status")).toContainText(
      "キーワードか局を入れると",
    );
  });

  /**
   * **前の回は録らない** (`rules.skip_earlier`)。1話から数え直すシリーズを飛ばさないよう、新しいルールでも
   * 切って始まる。入れて保存すれば、直すときも一覧でも入ったまま。判定そのものは rules-apply.test.ts が見る
   */
  test("「前の回は録らない」は切って始まり、入れて保存すると直すときも入っている", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
    const toggle = page.getByTestId("rule-skip-earlier");
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("rule-dedupe")).toBeChecked();
    await toggle.check();
    await page.getByTestId("rule-submit").click();
    const link = page.getByTestId("rule-saved-link");
    await expect(link).toHaveText("どこにも無い番組");

    await link.click();
    await page.waitForURL(/\/search\?rule=\d+$/);
    await expect(page.getByTestId("rule-skip-earlier")).toBeChecked();
    await page.getByTestId("rule-skip-earlier").uncheck();
    await page.getByTestId("rule-update").click();
    await expect(page.getByTestId("rule-saved")).toContainText("更新しました");
    await page.reload();
    await expect(page.getByTestId("rule-skip-earlier")).not.toBeChecked();
    await page.getByTestId("rule-skip-earlier").check();
    await page.getByTestId("rule-update").click();
    await expect(page.getByTestId("rule-saved")).toContainText("更新しました");

    // ルールの一覧の条件にも出る
    await goto(page, "/rules");
    await expect(
      page.getByTestId("rule-row").filter({ hasText: "どこにも無い番組" }),
    ).toContainText("前の回は録らない");
    await clearRules(page);
  });

  /**
   * **狭い画面では下から出す。** 結果の一覧の下に貼り付いたボタンで開き、上半分の一覧は見えたまま
   */
  test("狭い画面ではボタンで下から出す", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, `/search?q=${encodeURIComponent("どこにも無い番組")}`);
    const draft = page.getByTestId("rule-draft");
    await expect(draft).toBeHidden();
    await page.getByTestId("rule-draft-open").click();
    await expect(draft).toBeInViewport();
    await expect(page.getByTestId("rule-keyword")).toHaveValue(
      "どこにも無い番組",
    );
    await page.getByTestId("rule-submit").click();
    await expect(page.getByTestId("rule-saved-link")).toHaveText(
      "どこにも無い番組",
    );
    await page.getByTestId("rule-draft-close").click();
    await expect(draft).toBeHidden();
    // 横にはみ出さない
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(wide).toBe(false);
    await clearRules(page);
  });

  /**
   * 番組の詳細の「ルールを作る」は、シリーズ名を言葉にして検索の画面へ (`?from=program:<ID>`)
   */
  test("番組から来るとシリーズ名で始まる", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, `/search?q=${encodeURIComponent("テストアニメ")}`);
    const id = await page
      .getByTestId("search-program")
      .first()
      .getAttribute("data-program-id");
    await goto(page, `/search?from=program:${id}`);
    await expect(page).toHaveURL(
      /q=%E3%83%86%E3%82%B9%E3%83%88%E3%82%A2%E3%83%8B%E3%83%A1/,
    );
    await expect(page.getByTestId("rule-keyword")).toHaveValue("テストアニメ");
    await expect(page.getByTestId("rule-origin")).toContainText(
      "シリーズ名から始めました",
    );
  });
});
