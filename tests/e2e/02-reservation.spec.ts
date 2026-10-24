import {
  cellOf,
  expect,
  goto,
  past,
  setRecording,
  shownDay,
  syncEpg,
  test,
  upcoming,
} from "./helpers";

test.describe("手動予約", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("番組表から予約して、予約一覧に出て、取り消せる", async ({ page }) => {
    // グリッドは実番組の尺を前提にしていて、10秒の偽番組だとマスが潰れて押せない。
    // 地上波は30分枠にしてある
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);

    const cell = cellOf(page, target.programId);
    await cell.getByTestId("program-button").click();
    await page.getByTestId("detail-reserve").click();

    // 予約済みになると見た目が変わる
    await expect(cell).toContainText("予約済み");

    await goto(page, "/");
    const reservation = page.locator(
      `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
    );
    await expect(reservation).toHaveCount(1);
    // 手で入れたものには種別を出さない。ルールで立ったときだけ名前を出す
    await expect(reservation.getByTestId("rule-name")).toHaveCount(0);
    await expect(reservation.getByTestId("reservation-state")).toHaveText(
      "予約済み",
    );

    await reservation.getByTestId("cancel-button").click();
    await expect(reservation).toHaveCount(0);

    // 取り消したものは「完了分も表示」でだけ見える
    await goto(page, "/?all=1");
    await expect(
      page.locator(
        `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
      ),
    ).toContainText("取り消し済み");
  });

  test("ルール未設定でも複数チャンネルの予約が並行して立つ", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    const cells = await upcoming(page);

    /*
     * 同じ時間帯で局が違うものを2つ選ぶ。GRのチューナーは2台あるので、
     * 時間が丸かぶりでも競合にはならない、というのがここで見たいこと。
     *
     * **先頭の番組を起点にしない。** 走らせた時刻によっては、いちばん近い
     * 番組の枠に相手がいないことがある (その局だけ番組が始まったばかり)。
     * 組になるものを全体から探す
     */
    const pair = cells
      .flatMap((a, i) =>
        cells
          .slice(i + 1)
          .filter((b) => b.startAt === a.startAt && b.serviceId !== a.serviceId)
          .map((b) => [a, b] as const),
      )
      .at(0);
    expect(pair, "同じ時刻に始まる局違いの番組が2つ要る").toBeTruthy();
    const [first, second] = pair!;

    for (const target of [first, second]) {
      const cell = cellOf(page, target.programId);
      await cell.getByTestId("program-button").click();
      await page.getByTestId("detail-reserve").click();
      await expect(cell).toContainText("予約済み");
    }

    // 検索 (`/search?q=`) は予約も探す。ホームの `?q=` は検索の画面へ移る
    const rowOf = (programId: string) =>
      page.locator(
        `[data-testid="reservation-row"][data-program-id="${programId}"]`,
      );
    const hitOf = (programId: string) =>
      page.locator(
        `[data-testid="search-reservation"][data-program-id="${programId}"]`,
      );
    await goto(page, "/");
    const firstName = (
      await rowOf(first.programId).getByTestId("row-open").innerText()
    ).trim();
    await goto(page, `/?q=${encodeURIComponent(firstName)}`);
    await expect(page).toHaveURL(/\/search\?q=/);
    await expect(hitOf(first.programId)).toHaveCount(1);
    // どれにも当たらない言葉なら、どちらの予約も出ない
    await goto(page, `/search?q=${encodeURIComponent("当たらない言葉ZZ")}`);
    await expect(page.getByTestId("search-summary")).toBeVisible();
    await expect(hitOf(first.programId)).toHaveCount(0);
    await expect(hitOf(second.programId)).toHaveCount(0);

    await goto(page, "/");
    for (const target of [first, second]) {
      const reservation = page.locator(
        `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
      );
      await expect(reservation.getByTestId("reservation-state")).toHaveText(
        "予約済み",
      );
      await reservation.getByTestId("cancel-button").click();
      await expect(reservation).toHaveCount(0);
    }
  });
});

test.describe("予約の細かい指定", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  /**
   * 録画のしかたは**設定画面ひとつ**で決める。
   *
   * 番組ごとの指定は置いていないし、**予約にも写さない。** 写していた頃は
   * 予約を立てた時点の値で固まり、設定を変えても直らなかった (実機で、
   * 「元のTSも残す」を ON にしたのに既に立っていた予約24件が OFF のままだった)。
   * 実際に読むのは**エンコードするとき** (encoder.ts)。
   */
  test("録画のしかたは設定画面だけで決める。番組ごとの指定は無い", async ({
    page,
    request,
  }) => {
    await setRecording(request, { keepOriginal: true });
    try {
      await goto(page, "/guide?type=GR");
      const [target] = await upcoming(page);

      await cellOf(page, target.programId)
        .getByTestId("program-button")
        .click();
      await page.getByTestId("detail-reserve").click();

      await goto(page, "/");
      const reservation = page.locator(
        `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
      );
      await expect(reservation).toHaveCount(1);
      // 予約の行にコーデックのラベルは出さない。エンコードするときの設定で決まるので、
      // 立てた時点の値を出すと設定を変えたときに嘘になる
      await expect(reservation).not.toContainText("元のTSも残す");

      await reservation.getByTestId("cancel-button").click();
      await expect(reservation).toHaveCount(0);
    } finally {
      await setRecording(request);
    }
  });

  test("予約の行を押すと番組表と同じ詳細が出る", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);

    // まず番組表側での見え方を控える
    await cellOf(page, target.programId).getByTestId("program-button").click();
    const title = (
      (await page.getByTestId("program-detail").locator("h3").textContent()) ??
      ""
    ).trim();
    const badges = (
      await page
        .getByTestId("detail-badges")
        .locator(":scope > .fact, :scope > .tag")
        .allTextContents()
    ).map((text) => text.trim());
    expect(badges.length).toBeGreaterThan(0);
    await page.getByTestId("detail-reserve").click();

    // 予約一覧の行からも、同じものが同じ形で出ること。
    // 一覧は番組の中身を持っていないので、EPG から引き直して出している
    await goto(page, "/");
    const reservation = page.locator(
      `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
    );
    await reservation.getByTestId("row-body").click();

    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("h3")).toHaveText(title);
    await expect(async () => {
      const shown = (
        await detail
          .getByTestId("detail-badges")
          .locator(":scope > .fact, :scope > .tag")
          .allTextContents()
      ).map((text) => text.trim());
      expect(shown).toEqual(badges);
    }).toPass();

    await page.getByTestId("detail-close").click();
    await expect(detail).toHaveCount(0);

    // 行の中のボタンを押したときは詳細を出さない。出すと取消の確認が隠れる
    await reservation.getByTestId("cancel-button").click();
    await expect(reservation).toHaveCount(0);
    await expect(detail).toHaveCount(0);
  });

  /*
   * 詳細を開いて中身を確かめてから要らないと分かったとき、一度閉じて行の
   * ボタンを探し直さなくていいように。行の「取消」と同じボタンを詳細にも出す
   */
  test("予約の詳細から取り消せる", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);
    // 3時台は翌日の表から選ぶので、開き直すときは同じ日を名指しする (`shownDay`)
    const day = await shownDay(page);
    await cellOf(page, target.programId).getByTestId("program-button").click();
    await page.getByTestId("detail-reserve").click();
    await expect(cellOf(page, target.programId)).toContainText("予約済み");

    await goto(page, "/");
    const reservation = page.locator(
      `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
    );
    await reservation.getByTestId("row-body").click();
    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();

    // 取り消せたら詳細は閉じ、行も一覧から消える (読み込み直さずに)
    await detail.getByTestId("detail-cancel").click();
    await expect(detail).toHaveCount(0);
    await expect(reservation).toHaveCount(0);

    // 行から取り消したときと同じ扱い (完了分にだけ出て、戻せる)
    await goto(page, "/?all=1");
    const canceled = page.locator(
      `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
    );
    await expect(canceled).toContainText("取り消し済み");
    await expect(canceled.getByTestId("restore-button")).toHaveCount(1);
    // 取り消した予約の詳細には、もう取消を出さない
    await canceled.getByTestId("row-body").click();
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("detail-cancel")).toHaveCount(0);
    await page.getByTestId("detail-close").click();

    // 番組表の詳細でも、取り消したあとは「予約する」に戻っている
    await goto(page, day);
    const cell = cellOf(page, target.programId);
    await expect(cell).not.toContainText("予約済み");
    await cell.getByTestId("program-button").click();
    await expect(detail.getByTestId("detail-reserve")).toBeVisible();
    await expect(detail.getByTestId("detail-cancel")).toHaveCount(0);
  });

  /*
   * 番組表・予約の詳細からもルールを作れる。行き先は録画と同じルールの画面で、
   * 番組から下書きを入れる (`?program=<番組ID>`)
   */
  test("番組表と予約の詳細から、その番組のルールを作りに行ける", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);
    const day = await shownDay(page);
    // 行き先は検索の画面の「ルールとして保存」(シリーズ名を言葉にして出直す)。ホームの「ルールを作る」も同じ形で直接来る
    const ruleUrl = new RegExp(
      `/search\\?(.*&)?from=program%3A${target.programId}(&|$)`,
    );
    const detail = page.getByTestId("program-detail");
    await cellOf(page, target.programId).getByTestId("program-button").click();
    await detail.getByTestId("detail-rule").click();
    await expect(page).toHaveURL(ruleUrl);
    await expect(page.getByTestId("rule-origin")).toBeVisible();
    // 下書きにジャンルは入れない (すべて)
    expect(new URL(page.url()).searchParams.has("genres")).toBe(false);
    await expect(page.getByTestId("genre-summary")).toContainText("すべて");

    await goto(page, day);
    await cellOf(page, target.programId).getByTestId("program-button").click();
    await detail.getByTestId("detail-reserve").click();
    await expect(cellOf(page, target.programId)).toContainText("予約済み");
    await goto(page, "/");
    const reservation = page.locator(
      `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
    );
    try {
      await reservation.getByTestId("row-body").click();
      await detail.getByTestId("detail-rule").click();
      await expect(page).toHaveURL(ruleUrl);
      await expect(page.getByTestId("rule-origin")).toBeVisible();
    } finally {
      // 後続に残さない
      await goto(page, "/");
      await reservation.getByTestId("cancel-button").click();
      await expect(reservation).toHaveCount(0);
    }
  });

  test("番組表の詳細から取り消すと、その場で予約ボタンに戻る", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);
    const cell = cellOf(page, target.programId);
    const detail = page.getByTestId("program-detail");

    await cell.getByTestId("program-button").click();
    await detail.getByTestId("detail-reserve").click();
    await expect(cell).toContainText("予約済み");

    await cell.getByTestId("program-button").click();
    await expect(detail.getByTestId("detail-reserve")).toHaveCount(0);
    await detail.getByTestId("detail-cancel").click();
    await expect(detail).toHaveCount(0);
    await expect(cell).not.toContainText("予約済み");

    await cell.getByTestId("program-button").click();
    await expect(detail.getByTestId("detail-reserve")).toBeVisible();
    await expect(detail.getByTestId("detail-cancel")).toHaveCount(0);
  });

  test("放送が終わった番組には予約ボタンを出さない", async ({ page }) => {
    // 番組表には過去の番組も並んでいる。押せてしまうと、押した先で断られるだけ
    await goto(page, "/guide?type=GR");
    const done = await past(page);

    await cellOf(page, done[0]!.programId)
      .getByTestId("program-button")
      .click();
    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("detail-ended")).toHaveText("放送終了");
    await expect(detail.getByTestId("detail-reserve")).toHaveCount(0);
    await page.getByTestId("detail-close").click();
    await expect(detail).toHaveCount(0);

    await goto(page, "/");
    await expect(
      page.locator(
        `[data-testid="reservation-row"][data-program-id="${done[0]!.programId}"]`,
      ),
    ).toHaveCount(0);
  });
});

/**
 * **押したつもりが「ドラッグして動かした」になっていた。**
 *
 * 番組表はドラッグして動かせる (`dragScroll`)。動かしたあとのクリックで番組を開いては
 * 困るので、動いていたら食う作りにしてある。そのしきい値が 5px しかなく、しかも指と
 * ペンにも掛かっていたため、**スマホでマスを押しても詳細が出なかった** (実機)。
 * 指は押しただけで数px ずれる。
 *
 * 指とペンはブラウザに任せ (こちらが動かすと二重に動く)、マウスのしきい値も広げてある。
 */
test.describe("番組表のマスを押す", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("少しずれても開く。ドラッグしたときだけ開かない", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);
    const cell = cellOf(page, target.programId);
    /*
     * **見えるところまで送っておく。** 番組表は 4:00 始まりなので、4時台に
     * 走らせると「これから始まる番組」がグリッドの先頭にあり、真ん中を
     * 押したつもりが貼り付いた見出しに当たっていた (時計次第で落ちていた)。
     * 半分隠れたマスを見出しの下までスクロールさせるのは表の側 (`scroll-padding`。下の
     * 「見出しの裏に半分隠れたマスも…」で確かめている)
     */
    await cell.scrollIntoViewIfNeeded();
    const box = (await cell.boundingBox()) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const detail = page.getByTestId("program-detail");

    // 押した拍子に少しずれた。開くのが正しい (直す前は 6px で開かなかった)
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 6, y);
    await page.mouse.up();
    await expect(detail).toBeVisible();
    await page.getByTestId("detail-close").click();
    await expect(detail).toHaveCount(0);

    /*
     * はっきりドラッグしたときは開かない (動かした先の番組が開いてしまう)。
     *
     * **送る向きは余地のあるほうへ。** 番組表は 4:00 から翌 4:00 までの範囲なので、
     * 深夜に走らせると**もう下端まで送られていて、それ以上は動かない** —
     * 上へ送ると決め打っていた頃は 01:37 に落ちた (実際に CI で落ちた)。
     * マウスを上へ動かすと中身は下へ送られる (`scrollTop` が増える)
     */
    const grid = page.getByTestId("guide-grid");
    const room = await grid.evaluate((el) => ({
      top: el.scrollTop,
      rest: el.scrollHeight - el.clientHeight - el.scrollTop,
    }));
    // 下へ送る余地があるなら上へ動かす。無ければ逆へ
    const step = room.rest > 120 ? -20 : 20;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x, y + i * step);
    await page.mouse.up();
    await expect(detail).toHaveCount(0);
    const after = await grid.evaluate((el) => el.scrollTop);
    if (step < 0)
      expect(after, "ドラッグで下へ送れていない").toBeGreaterThan(room.top);
    else expect(after, "ドラッグで上へ送れていない").toBeLessThan(room.top);
  });

  /*
   * **指はブラウザに任せる。** これが実機で出ていたほう。
   *
   * 押しただけのつもりでも指は数px ずれるので、ドラッグで動かす仕掛けが
   * タップを食っていた。`touchscreen.tap` はぴたりと押してしまい
   * (ずれないので古い版でも通る)、ずれを作れないので、触った印を自分で流す。
   */
  test("指が少しずれても、タップを食わない", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);
    const cell = cellOf(page, target.programId);
    // 上と同じ理由 (4時台は「これから始まる番組」が見出しの下に隠れる)
    await cell.scrollIntoViewIfNeeded();
    const box = (await cell.boundingBox()) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };

    await page.evaluate(
      ({ x, y }) => {
        const at = (cx: number, cy: number) => ({
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        });
        const target = document.elementFromPoint(x, y);
        if (target === null) throw new Error("マスがそこに無い");
        target.dispatchEvent(new PointerEvent("pointerdown", at(x, y)));
        target.dispatchEvent(new PointerEvent("pointermove", at(x + 6, y)));
        target.dispatchEvent(new PointerEvent("pointerup", at(x + 6, y)));
        (target as HTMLElement).closest("button")?.click();
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );

    await expect(page.getByTestId("program-detail")).toBeVisible();
  });

  /*
   * **見出しの裏に半分隠れたマスも、スクロールすれば見出しの下に出る。**
   *
   * 3時台に走らせると、`upcoming` は翌日へ送って 4:00 のマスを選ぶ。日を送っても縦の
   * 位置は引き継ぐので、そのマスは貼り付いたチャンネル名の行の裏に半分隠れていた。
   * `scrollIntoViewIfNeeded` は見出しの裏も見えている場所に数えて、マスを見出しの下まで出さないので、真ん中を押すと
   * 見出しに当たり、上の2つが 3:30〜4:00 にだけ落ちていた (CI で実際に落ちた)。
   * 時計に頼らずにその形を作る: マスの下の 16px だけが見出しの下に覗くところまでスクロールする
   */
  test("見出しの裏に半分隠れたマスも、スクロールすれば見出しの下に出る", async ({
    page,
  }) => {
    await goto(page, "/guide?type=GR");
    /*
     * 先頭の局のいちばん早いマス (マスは局ごとに開始時刻順に並ぶ)。偽の放送は「いま」の
     * 8 時間前からなので、表の下端 (翌 4:00) までは少なくとも 8 時間あり、
     * 見出しの裏に入るまでスクロールする余地がある
     */
    const cell = page.getByTestId("grid-program").first();
    await cell.evaluate((el) => {
      const grid = el.closest<HTMLElement>('[data-testid="guide-grid"]');
      const head = grid?.querySelector('[data-testid="guide-service"]');
      if (grid == null || head == null) throw new Error("番組表の見出しが無い");
      const rect = el.getBoundingClientRect();
      grid.scrollTop += rect.bottom - 16 - head.getBoundingClientRect().bottom;
    });
    /** マスの真ん中にあるのが、そのマスか (見出しではなく) */
    const centerIsCell = () =>
      cell.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return el.contains(hit);
      });
    // ここで見出しの裏に入っていなければ、確かめたいことを作れていない
    expect(await centerIsCell(), "マスを見出しの裏まで動かせていない").toBe(
      false,
    );

    await cell.scrollIntoViewIfNeeded();
    expect(await centerIsCell(), "マスの真ん中が見出しの裏に残っている").toBe(
      true,
    );
    const box = (await cell.boundingBox()) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await expect(page.getByTestId("program-detail")).toBeVisible();
  });
});
