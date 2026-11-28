import { FUJI, MX } from "../fake/services";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * 設定のチューナーとチャンネル。
 *
 * **総当たりを回すのは denpa。** 選局はエージェントにリクエストするが、NIT と SDT を
 * 読み取って局名を取るのはこちらで、見つけた顔ぶれをエージェントに預ける。
 * ここは 13〜62ch を本当に 1 つずつ開いていて、偽の放送にあるのは T16 と T21 だけ。
 * チューナーの台数と種別の設定は `16-scan-tuners`。
 */
test.describe("設定のチューナーとチャンネル", () => {
  test.afterEach(async ({ request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/tuners?busy=0`);
  });

  /*
   * 偽エージェントはワーカーに 1 つで、spec をまたいで共有している。スキャンの控えには部分受信の印が付き、
   * 偽の放送のデータ放送の局 (ＭＸデータ１) が入る。残すと後のファイルの局の数がずれるので、始めの控えに戻す
   */
  test.afterAll(async ({ request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/channels`);
    await syncEpg(request);
  });

  test("チャンネルスキャンを実行でき、進み具合と結果が出る", async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    await goto(page, "/settings/reception");

    const card = page.getByTestId("channel-section");
    // 何分もかかって空きチューナーを全部使うので、そうと分かるようにしておく (「詳しく」の中)
    await expect(card).toContainText("空いているチューナーを全部使います");

    // 初めの選び方は「すべて」。ここは地上波の総当たりだけを見る
    await card.getByLabel("スキャンする種別").selectOption("GR");
    await card.getByTestId("scan-start").click();

    await expect(card.getByTestId("scan-state")).toHaveText("完了", {
      timeout: 60_000,
    });
    // 総当たりなので、どこまで進んだかを割合で出せる (地上波は 13〜62ch)
    await expect(card.getByTestId("scan-count")).toContainText("50 / 50");
    // 受信できた分だけ数える。信号が無かった分は数に入らない
    await expect(card.getByTestId("scan-found")).toContainText("2");
    await expect(card.getByTestId("scan-log")).toContainText("2 局");
  });

  /**
   * **BS は総当たりせず、放送の一覧 (NIT) から作る。** 偽の放送の BS は BS-3 と BS-11 の 2 つの TS で、
   * 入口の BS-15・BS-1 には何も無い。3 つ目の入口 (BS-3) の NIT に、両方の TS が周波数付きで載っている
   */
  test("BS は放送の一覧からチャンネルを作る", async ({ page, request }) => {
    await syncEpg(request);
    await goto(page, "/settings/reception");

    const card = page.getByTestId("channel-section");
    await card.getByLabel("スキャンする種別").selectOption("BS");
    await card.getByTestId("scan-start").click();

    await expect(card.getByTestId("scan-state")).toHaveText("完了", {
      timeout: 60_000,
    });
    await expect(card.getByTestId("scan-found")).toContainText("2");
    await expect(card.getByTestId("scan-log")).toContainText(
      "放送の一覧から 2 チャンネル",
    );
  });

  /**
   * 入れたばかりのとき用のボタン。
   *
   * 普段の周回は録画にもスキャンにもロゴにも譲るので、何か動いていると
   * 番組表がなかなか埋まらない。押されている間は**録画以外より上の優先度**で
   * 取得するので、そこまで見ておく (画面には数字を出さない。「詳しく」の順番がそれ)
   */
  test("番組表をいますぐ集められる。譲る順も上がる", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    await goto(page, "/settings/reception");

    await page.getByTestId("epg-collect-now").click();

    /*
     * **取得した記録を見る。使っている一瞬は待たない。**
     *
     * 「番組表が居る」「強さ 8」のような当時の表示を画面で待っていた頃は CI で落ちていた —
     * 偽エージェントは本物より速いので、**使っている状態を画面が描く前に
     * 集め終わる**。見えるかどうかは相手の速さ次第で、確かめたいことではない。
     *
     * 確かめたいのは「**その優先度で取得した**」ほう。画面での見え方は
     * 下の「チューナーの空きと取れているチャンネルが出る」が、塞がった状態を
     * 作って確かめている
     */
    await expect
      .poll(
        async () => {
          const res = await request.get(`${stack.agentUrl}/__control/opens`);
          const { opens } = (await res.json()) as {
            opens: { use: string; priority: number }[];
          };
          return opens.some((o) => o.use.startsWith("epg") && o.priority === 8);
        },
        { timeout: 30_000, message: "番組表を優先度 8 で取得していない" },
      )
      .toBe(true);

    // 終わったら押せる状態に戻る。戻らないと次に押せない
    await expect(page.getByTestId("epg-collect-now")).toBeEnabled({
      timeout: 120_000,
    });
    await expect(page.getByTestId("channel-coverage")).toContainText(
      "番組表のある局",
    );
  });

  test("種別を 1 つも選ばなければ断る", async ({ request }) => {
    // 画面の選ぶ欄は必ずどれかが入っている。画面の外から空で来たものは断る
    const res = await request.post("/settings/reception?/scan", {
      form: {},
      headers: { accept: "application/json", "x-sveltekit-action": "true" },
    });
    expect(await res.text()).toContain("種別を選んでください");
  });

  /**
   * **スマホでは、見えている節の操作を下のタブの上に浮かべる** (ボタンは下に。docs/design.md の「浮かせ方」)。
   * 節へ飛ぶ行のすぐ上の 1 行で、節を移ると入れ替わり、操作の無い節では出さない
   */
  test("スマホではチャンネルの操作が節へ飛ぶ行のすぐ上に出る", async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, "/settings/reception#channels");

    const bar = page.getByTestId("channel-actions");
    await expect(bar).toBeInViewport();
    await expect(bar.getByTestId("scan-start")).toBeVisible();
    await expect(bar.getByTestId("epg-collect-now")).toBeVisible();
    const gap = async () => {
      const own = (await bar.boundingBox())!;
      const jump = (await page.getByTestId("settings-jump").boundingBox())!;
      return jump.y - (own.y + own.height);
    };
    await expect.poll(gap).toBeGreaterThan(0);
    expect(await gap()).toBeLessThan(12);

    // データ放送には見出しの行の操作が無い
    await page.getByTestId("settings-jump-broadcast").click();
    await page.waitForURL(/#broadcast$/);
    await expect(bar).toBeHidden();
    // 節へ飛ぶ巻き取りは読んでいるのではないので、節へ飛ぶ行は引っ込めない (引っ込むと次の節を押せない)
    await expect(page.getByTestId("settings-jump")).toBeInViewport();
    await page.getByTestId("settings-jump-channels").click();
    await expect(bar).toBeInViewport();
  });

  test("チューナーの空きと取れているチャンネルが出る", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    await request.post(`${stack.agentUrl}/__control/tuners?busy=1`);
    await goto(page, "/settings/reception");

    const tuners = page.getByTestId("tuner-list");
    await expect(tuners.getByTestId("tuner-row")).toHaveCount(4);
    /*
     * 使っている相手が何をしているのか分かるようにする。
     *
     * エージェントが持っているのは短い印だけ (`rec 1` / `epg BS11:18000`) なので、
     * 番組名に開くのは画面側の仕事。**何を使っているか**も一緒に出す
     */
    const using = tuners.getByTestId("tuner-row").nth(0);
    await expect(using).toContainText("BS11:18000");
    await expect(using.getByTestId("tuner-user").first()).toContainText("録画");
    // 録画と番組表が同じ選局を共有している。チューナーは増えない
    await expect(using.getByTestId("tuner-user").nth(1)).toContainText(
      "番組表",
    );
    /*
     * **どちらが譲るかは用途の並びで言う。数字は画面に出さない。**
     * 「強さ 10」や「優先度 10」と数字を出していた頃は、ルールの優先度 (0〜9) と
     * 同じ物差しに読めた。数は調べるとき用に `data-priority` にだけ残す。
     *
     * ここで見るのは**塞がった状態を自分で作ってある**から動かない。
     * 「いますぐ集める」の側で見ていた頃は、使っている一瞬を捕まえられずに
     * 落ちていた (上の説明)
     */
    await expect(using.getByTestId("tuner-user").first()).toHaveAttribute(
      "data-priority",
      "10",
    );
    await expect(using.getByTestId("tuner-user").nth(1)).toHaveAttribute(
      "data-priority",
      "3",
    );
    await expect(tuners).not.toContainText("強さ");
    await expect(tuners).not.toContainText("優先度");
    // 譲る順は「詳しく」に。録画がいちばん上、局ロゴがいちばん下 (畳んだままなので役割では引けない。li で)
    const order = page.getByTestId("tuner-yield-order").locator("li");
    await expect(order.first()).toHaveText("録画");
    await expect(order.nth(1)).toHaveText("ライブ視聴");
    await expect(order.last()).toHaveText("局ロゴの取得");

    // スキャンで見つかった物理チャンネルと、denpa が取り込んだ局名 (設定のチャンネル)
    await goto(page, "/settings/reception");
    const channels = page.getByTestId("channel-list");
    await expect(channels.getByTestId("channel-row").first()).toBeVisible();
    // 局名は放送のとおりの幅で出す (全角の英数は全角のまま)
    await expect(channels).toContainText("ＴＯＫＹＯ　ＭＸ");
    /*
     * **1 行に 1 局。** ロゴ (局ロゴ・CM ロゴ) は局ごとのものなので、同じ表の局の行に列で並べる
     * (別の表で種別と局名を繰り返さない)。種別と ch はチャンネルの局の数だけ縦につなぐ
     */
    const card = page.getByTestId("channel-section");
    await expect(
      card.getByRole("columnheader", { name: "局ロゴ" }),
    ).toBeVisible();
    await expect(
      card.getByRole("columnheader", { name: "CM ロゴ" }),
    ).toBeVisible();
    const first = channels.getByTestId("channel-row").first();
    const channel = await first.getAttribute("data-channel");
    const rows = channels.locator(
      `[data-testid="channel-row"][data-channel="${channel}"]`,
    );
    await expect(first.locator("td").first()).toHaveAttribute(
      "rowspan",
      String(await rows.count()),
    );

    /*
     * どこまで進んだかを 1 行で出す。時間がかかるのは 1 チャンネルずつ選局して
     * 番組表を読むところで、表を上から下まで見ないと分からない状態だと、
     * 止まっているのか進んでいるのか区別が付かない。
     *
     * チャンネル・局・番組表は入れ子で数がそろわないので、3 つとも名前を添えて出す
     */
    const coverage = page.getByTestId("channel-coverage");
    await expect(coverage).toContainText("チャンネル");
    await expect(coverage).toContainText("局");
    await expect(coverage).toContainText("番組表のある局");
  });

  /*
   * **使用中のチューナーに、受信の状態と C/N が出る** (#2239。分配器のあとでブースターが要るかを見る)。
   * 生の値は dB と読まれないように「(生の値)」を付けて単位を付けず、何と比べる目安かを表の下に言う。
   * C/N が変わってもエージェントは通知を出さないので、画面は 5 秒ごとに読み直して追う (読み直すのは C/N だけ)
   */
  test("使用中のチューナーに受信の状態と C/N が出て、読み直しで追う", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.agentUrl}/__control/signal?value=raw`);
    await request.post(`${stack.agentUrl}/__control/tuners?busy=1`);
    await goto(page, "/settings/reception");

    const tuners = page.getByTestId("tuner-list");
    const using = tuners.getByTestId("tuner-row").nth(0);
    await expect(using.getByTestId("tuner-signal")).toHaveText(
      "同期しています・C/N (生の値): 2,748",
    );
    await expect(page.getByTestId("tuner-signal-raw-note")).toContainText(
      "dB ではありません",
    );
    // 空いているチューナーには出さない
    await expect(
      tuners.getByTestId("tuner-row").nth(1).getByTestId("tuner-signal"),
    ).toHaveCount(0);

    // 画面を開き直さずに追う
    await request.post(`${stack.agentUrl}/__control/signal?value=db`);
    await expect(using.getByTestId("tuner-signal")).toHaveText(
      "同期しています・C/N: 25.3 dB",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("tuner-signal-raw-note")).toHaveCount(0);

    // 強度は dBm で測れる機材 (DVB の一部・CECH-ZD1 J) だけ、C/N の前に出す
    await request.post(`${stack.agentUrl}/__control/signal?value=strength`);
    await expect(using.getByTestId("tuner-signal")).toHaveText(
      "同期しています・強度: -35.0 dBm・C/N: 25.3 dB",
      { timeout: 15_000 },
    );

    await request.post(`${stack.agentUrl}/__control/signal?value=tune`);
    await expect(using.getByTestId("tuner-signal")).toHaveText(
      "同期しています・C/N: 18.2 dB (選局したとき)",
      { timeout: 15_000 },
    );

    await request.post(`${stack.agentUrl}/__control/signal?value=unlocked`);
    await expect(using.getByTestId("tuner-signal")).toHaveText(
      "同期していません",
      { timeout: 15_000 },
    );
    await request.post(`${stack.agentUrl}/__control/signal?value=raw`);
  });

  /*
   * **受信品質はチャンネルの行ごとに測り、その行の下に出す** (#2286)。
   * 偽の放送は PSI の連続性カウンタを周回ごとに振り直すので、ドロップの値そのものは見ない
   */
  test("チャンネルの受信品質を測ると、行の下に誤り・ドロップ・速さが出る", async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    await goto(page, "/settings/reception");
    const first = page.getByTestId("channel-row").first();
    const channel = await first.getAttribute("data-channel");
    await first.getByTestId("signal-measure").click();
    const result = page.getByTestId("signal-result");
    await expect(result).toHaveAttribute("data-channel", channel!, {
      timeout: 20_000,
    });
    await expect(result).toContainText(
      /誤り [\d.]+%・ドロップ [\d.]+%・[\d.]+ Mbps/,
    );
  });

  /*
   * **局を隠す** (docs/data.md の「局を隠す」)。表には並べたまま「非表示」と出し、番組表とテレビのアプリの局の一覧から外す。
   * 同じ表の「再表示」で戻す
   */
  test("局を非表示にすると番組表と局の一覧から外れ、再表示で戻る", async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    const ids = async () =>
      (
        (await (await request.get("/api/services")).json()) as { id: number }[]
      ).map((service) => service.id);
    const column = (name: string) =>
      page.getByTestId("guide-service").filter({ hasText: name });
    try {
      await goto(page, "/settings/reception");
      const row = page.locator(
        `[data-testid="channel-row"][data-service-id="${FUJI.id}"]`,
      );
      await row.getByTestId("service-hide").click();
      await expect(row.getByTestId("service-hidden")).toHaveText("非表示");
      await expect(page.getByTestId("status-hidden")).toHaveText("1 局");
      expect(await ids()).not.toContain(FUJI.id);
      expect(await ids()).toContain(MX.id);
      await goto(page, "/guide?type=GR");
      await expect(column(MX.name)).toHaveCount(1);
      await expect(column(FUJI.name)).toHaveCount(0);

      await goto(page, "/settings/reception");
      await row.getByTestId("service-show").click();
      await expect(row.getByTestId("service-hidden")).toHaveCount(0);
      await expect(page.getByTestId("status-hidden")).toHaveCount(0);
      expect(await ids()).toContain(FUJI.id);
    } finally {
      // 途中で落ちても、後のテストのために戻しておく
      await request.post("/settings/reception?/hideService", {
        form: { id: String(FUJI.id), hidden: "0" },
        headers: { accept: "application/json", "x-sveltekit-action": "true" },
      });
    }
  });
});
