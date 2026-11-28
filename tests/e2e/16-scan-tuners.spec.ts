import { expect, goto, test } from "./helpers";

/**
 * チューナーの設定 (チャンネルとスキャンは `16-scan`)。
 *
 * 以前は tuners.yml をチューナー側のコンテナで手で編集するしかなかった。
 */
test.describe("チューナーの設定", () => {
  /*
   * **元の顔ぶれに戻してから抜ける。**
   *
   * 偽エージェントはワーカーに 1 つで、spec をまたいで共有している。
   * ここで減らしたままにすると、後のファイルがチューナー不足で落ちる
   * (実際それで、延長のテストが時々失敗した)
   */
  test.afterAll(async ({ request }, info) => {
    const port = 25252 + (info.workerIndex ?? 0) * 10;
    await request.put(`http://127.0.0.1:${port}/denpa/tuners`, {
      data: {
        tuners: [0, 1, 2, 3].map((index) => ({
          name: `adapter${index}`,
          types: index % 2 === 0 ? ["BS", "CS"] : ["GR"],
          device: `/dev/dvb/adapter${index}/frontend0`,
          disabled: false,
        })),
      },
    });
  });

  /*
   * **続けて押しても、押したぶん全部を保存する** (`autosave` の `edits`)。前の保存の返事で画面を読み直すと、
   * その間に押したスイッチが元に戻り、その値のまま次を送っていた (0.2 秒おきに 5 つ押すと 2 つしか残らなかった)
   */
  test("「使う」を続けて押しても、全部を保存する", async ({
    page,
    request,
    stack,
  }) => {
    await goto(page, "/settings/reception");
    const card = page.getByTestId("tuner-section");
    const rows = card.getByTestId("tuner-list").getByTestId("tuner-row");
    await expect(rows).toHaveCount(4);

    const disabled = async () => {
      const res = await request.get(`${stack.agentUrl}/denpa/tuners`);
      const { tuners } = (await res.json()) as {
        tuners: { disabled: boolean }[];
      };
      return tuners.map((tuner) => tuner.disabled);
    };
    for (let i = 0; i < 4; i++) {
      await rows.nth(i).getByTestId("tuner-use").click();
      await page.waitForTimeout(200);
    }
    await expect.poll(disabled).toEqual([true, true, true, true]);
    await expect(card.getByTestId("saved-result")).toBeVisible();
    for (let i = 0; i < 4; i++)
      await expect(rows.nth(i).getByTestId("tuner-use")).not.toBeChecked();

    // 戻すときも同じ
    for (let i = 0; i < 4; i++) {
      await rows.nth(i).getByTestId("tuner-use").click();
      await page.waitForTimeout(200);
    }
    await expect.poll(disabled).toEqual([false, false, false, false]);
    for (let i = 0; i < 4; i++)
      await expect(rows.nth(i).getByTestId("tuner-use")).toBeChecked();
  });

  test("画面から台数と種別を変えられる", async ({ page }) => {
    await goto(page, "/settings/reception");

    /*
     * **空きと設定は 1 つの表。** 1 台に 1 行で、名前・種別・使うかが 2 つの表に 2 度ずつ出ていた頃の
     * 「チューナーの設定」の表は無い
     */
    const card = page.getByTestId("tuner-section");
    const rows = card.getByTestId("tuner-list").getByTestId("tuner-row");
    await expect(rows).toHaveCount(4);
    await expect(card.locator("table")).toHaveCount(2); // チューナーとカードリーダー

    // 1 台目のスイッチを外す (使わない)。**変えたらその場で保存する**
    await rows.nth(0).getByTestId("tuner-use").uncheck();
    await expect(card.getByTestId("saved-result")).toBeVisible();
    await expect(rows.nth(0)).toContainText("無効");

    // 名前・デバイス・LNB と削除は「⋯」の中。閉じている行の欄は隠れている
    const detail = card.getByTestId("tuner-detail").nth(3);
    await expect(detail).toBeHidden();
    await rows.nth(3).getByTestId("tuner-more").click();
    await expect(rows.nth(3).getByTestId("tuner-more")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(detail).toBeVisible();

    // **名前を空にしても消さない。** 断って元の名前に戻す (欄を空にして離れただけで消えていた)
    const name = detail.locator('input[name="name.3"]');
    const before = await name.inputValue();
    await name.fill("");
    await name.blur();
    await expect(card.getByTestId("settings-error")).toContainText(
      "名前は空にできません",
    );
    await expect(name).toHaveValue(before);

    // 消すのは「⋯」の中の「削除」。ほかの削除と同じく 2 回押しで確かめる
    await detail.getByTestId("tuner-delete").click();
    await detail.getByTestId("tuner-delete-confirm").click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("無効");

    // 足すのは「追加」で出す欄から。名前を打っている途中では送らない
    await card.getByTestId("tuner-add-open").click();
    const add = card.getByTestId("tuner-add");
    await add.locator('input[name="name.add"]').fill("adapter3");
    /*
     * **足す欄が途中でも、ほかの行の保存は通る。** 足す欄は「追加」で送ったときだけ読む。
     * 番号付きの名前で同じフォームに乗せていた頃は、デバイスが空だとほかの行まで断られていた
     */
    await rows.nth(0).getByTestId("tuner-use").check();
    await expect(card.getByTestId("saved-result")).toBeVisible();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).not.toContainText("無効");
    await add
      .locator('input[name="device.add"]')
      .fill("/dev/dvb/adapter3/frontend0");
    await add.locator('input[name="type.add.GR"]').check();
    await expect(rows).toHaveCount(3);
    await card.getByTestId("tuner-add-submit").click();
    await expect(rows).toHaveCount(4);
    await expect(add).toHaveCount(0);
    await expect(rows.nth(3)).toContainText("adapter3");
    await expect(rows.nth(3).getByTestId("tuner-use")).toBeChecked();
  });

  test("種別を 1 つも選ばない行は断る", async ({ page }) => {
    await goto(page, "/settings/reception");

    const card = page.getByTestId("tuner-section");
    // 最後の 1 つを外すと、その場で断られてすぐ元に戻る。そこだけは押すだけにする (外れたままを待たない)
    const checked = card.locator('input[name^="type.0."]:checked');
    while ((await checked.count()) > 1) await checked.first().uncheck();
    await checked.first().click();

    // その場で保存して断られる。見出しの横に理由を出し、外したチェックは元に戻す
    await expect(card.getByTestId("settings-error")).toContainText(
      "種別を 1 つ以上",
    );
    // 衛星を使わないときは種別を外すのではなく「使う」をオフにする、と案内する (#2386)
    await expect(card.getByTestId("settings-error")).toContainText(
      "「使う」をオフに",
    );
    await expect(
      card.locator('input[name^="type.0."]:checked').first(),
    ).toBeChecked();
  });

  /*
   * **機材が受けられない種別は選ばせない。** BS/CS 専用の受信機に GR を入れて保存でき、その台に割り振られた
   * 地上波のライブ視聴がエージェントの選局で断られ続けた (#2386)。画面を通さずに送っても保存で断る
   */
  test("機材が受けられない種別は選べず、送っても断る", async ({ page }) => {
    await goto(page, "/settings/reception");

    const card = page.getByTestId("tuner-section");
    // 偽エージェントの adapter0 は BS/CS、adapter1 は GR だけを受けられる
    await expect(card.locator('input[name="type.0.GR"]')).toBeDisabled();
    await expect(card.locator('input[name="type.0.BS"]')).toBeEnabled();
    await expect(card.locator('input[name="type.1.BS"]')).toBeDisabled();
    await expect(card.locator('input[name="type.1.GR"]')).toBeEnabled();

    // 押せないようにしたのを外して入れても、保存で断って元に戻す
    const gr = card.locator('input[name="type.0.GR"]');
    await gr.evaluate((el) => el.removeAttribute("disabled"));
    // 入れたら保存し、断られてすぐ外れる。check() は入った姿を確かめようとして外れたあとに読むことがあるので、押すだけにする
    await gr.click({ force: true });
    await expect(card.getByTestId("settings-error")).toContainText(
      "「地上波」を受信できません",
    );
    await expect(gr).not.toBeChecked();
  });

  /*
   * **広い画面では表のまま、見出しと欄が縦に揃う。狭い画面では 1 台ずつの段の行。**
   *
   * カードにする表に `.stack` と名付けていた頃は、app.css の `.stack` (縦に積む flex) が
   * 広い画面でも当たり、表が flex になっていた。見出しと行が別々に詰められて、
   * 欄が見出しより左にずれ、行の右端も見出しより手前で終わっていた
   */
  test("見出しと欄が揃い、狭い画面では段の行になる", async ({ page }) => {
    const tables = [
      page.getByTestId("tuner-list").locator("xpath=ancestor::table"),
      page
        .getByTestId("card-reader-row")
        .first()
        .locator("xpath=ancestor::table"),
    ];

    await page.setViewportSize({ width: 1600, height: 900 });
    await goto(page, "/settings/reception");
    await expect(
      page.getByTestId("tuner-list").getByTestId("tuner-row").first(),
    ).toBeVisible();
    await expect(page.getByTestId("card-reader-row").first()).toBeVisible();
    for (const table of tables) {
      const gaps = await table.evaluate((el) => {
        const heads = [...el.querySelectorAll("thead th")];
        const cells = [...el.querySelectorAll("tbody tr:first-child > td")];
        return {
          display: getComputedStyle(el).display,
          counts: [heads.length, cells.length],
          gaps: heads.map((th, i) => {
            const a = th.getBoundingClientRect();
            const b = cells[i]!.getBoundingClientRect();
            return Math.max(
              Math.abs(a.left - b.left),
              Math.abs(a.right - b.right),
            );
          }),
        };
      });
      expect(gaps.display).toBe("table");
      expect(gaps.counts[0]).toBe(gaps.counts[1]);
      for (const gap of gaps.gaps) expect(gap).toBeLessThan(1);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    for (const table of tables) {
      const display = (el: Element) => getComputedStyle(el).display;
      expect(await table.locator("thead").evaluate(display)).toBe("none");
      expect(await table.locator("tbody tr").first().evaluate(display)).toBe(
        "grid",
      );
    }
    // 種別の欄だけ、見出しを行の中に書く
    const label = await page
      .getByTestId("tuner-row")
      .first()
      .locator("td[data-label]")
      .first()
      .evaluate((el) => getComputedStyle(el, "::before").content);
    expect(label).toBe('"受信できる種別"');
  });
});
