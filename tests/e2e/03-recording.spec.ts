import { existsSync } from "node:fs";

import {
  cellOf,
  expect,
  goto,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  waitWatchable,
} from "./helpers";

/**
 * 録画→エンコード→保存先に入るまでを通しで確認する。
 * 進行はサーバ側のタイマー任せなので、ページを読み直しながら状態が変わるのを待つ。
 * CM のチャプター、コーデックを両方エンコードするとき、CM 検出のやり直しは `03-recording-chapters`
 * (1 本で CI の組の時間を押し上げていたので分けた)
 */
test.describe("録画とエンコード", () => {
  test("予約した番組が録画され、エンコードされて保存先に入る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    // 節目の通知が実際にどう飛ぶかも、この一連の流れで見ておく
    await request.post(`${stack.webhookUrl}/__control/reset`);
    await goto(page, "/settings/integrations");
    await page
      .getByTestId("webhook-url")
      .fill(`${stack.webhookUrl}/__control/webhook`);
    await page.getByTestId("webhook-add").click();

    // BS は他のテストが触らないので、チューナー競合の心配なく録れる
    const programId = await reserveSoon(page, request, "BS");

    const recordingRow = `[data-testid="recording-row"][data-program-id="${programId}"]`;
    await waitWatchable(page, page.locator(recordingRow));

    // 録り終えた予約は録画の行にまとまる。「完了した予約も表示」でも予約の行は別に出ない (`mergeRecorded`)
    await goto(page, "/?all=1");
    await expect(page.locator(recordingRow)).toHaveCount(1);
    await expect(
      page.locator(
        `[data-testid="reservation-row"][data-program-id="${programId}"]`,
      ),
    ).toHaveCount(0);

    // 保存先のパスが決まっていること。実体との突き合わせにこのパスを使う。
    // 画面には出さない(普段は見ないので)ので、行の属性から取る
    await goto(page, "/");
    const recording = page.locator(recordingRow);
    const videoPath = (await recording.getAttribute("data-library-path")) ?? "";
    expect(videoPath).toContain(stack.encodedDir);
    expect(videoPath).toContain(".mkv");

    /*
     * CM 検出が走り、既定のチャプター付与として記録されていること。
     *
     * **切った位置は画面に出さない** — チャプターとして動画に入っているので、
     * 再生すれば分かる。ここでは行の属性から確かめる。
     * 詳細には「何で見つけたか」だけを出す (ロゴを教えるボタンを出すかの判断にも使う)
     */
    expect(await recording.getAttribute("data-cm-ranges")).toContain("300");
    await recording.getByTestId("detail-button").click();
    await expect(page.getByTestId("detail-cm-note")).toContainText("無音");
    await page.getByTestId("detail-close").click();

    // 実際に録れた長さが記録されていること。番組表の尺は予定でしかなく、
    // 途中で止めたときは実物と合わない
    const recorded = Number(await recording.getAttribute("data-duration-ms"));
    expect(recorded).toBeGreaterThan(0);
    // 番組表の尺(BS の偽番組は 10 秒)から大きく外れていないこと
    expect(recorded).toBeLessThan(5 * 60_000);

    // サムネイル (denpa の画面が出す画像) が隣に置かれていること。
    // 番組情報の .nfo は書かなくなった (Nova/WebDAV 連携をやめた) ので、無いのが正
    const base = videoPath.replace(/\.mkv$/, "");
    expect(existsSync(`${base}-poster.jpg`)).toBe(true);
    expect(existsSync(`${base}.nfo`)).toBe(false);

    // 観られる録画には再生の印が出ていること。
    // 再生ボタンは置いていない (行そのものを押すと再生する)
    await expect(recording.getByTestId("play-hint")).toBeVisible();

    /*
     * 何で録れた 1 本かを出していること。**録画の側では手動とも書く** —
     * 予約は「ルールでないなら黙る」が、録れたものは後から見返すので、
     * 「ルールではない」ことにも意味がある (どのルールを直せばいいのか、を
     * 探し始める前に打ち切れる)
     */
    await expect(recording.getByTestId("rule-name")).toHaveText("手動予約");

    // 行を押すと番組表と同じ詳細が出る。エンコードしたもののコマ数のラベルも付く
    await recording.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("detail-video")).toBeVisible();
    await expect(detail.getByTestId("detail-fps")).toHaveText("60 コマ/秒");

    /*
     * 畳んでいる「その他…」のメニューは display:none であること。
     * dropdown-content に flex を直に載せていた頃、daisyUI の display:none より
     * 強く効いて閉じても display:flex のまま (opacity 0) になり、ボタンの真上の
     * 見えない項目がクリックを食っていた (実機で発覚)
     */
    expect(
      await detail
        .getByTestId("detail-more-menu")
        .evaluate((el) => getComputedStyle(el).display),
    ).toBe("none");

    // 録画をファイルとして持ち出すダウンロードは持たない (Discussion #760)。「その他…」にも出さない
    await detail.getByTestId("detail-more").click();
    await expect(detail.getByTestId("detail-more-menu")).toBeVisible();
    await expect(detail.getByTestId("detail-more-menu")).not.toContainText(
      "ダウンロード",
    );
    // Esc で畳む (キーボードでも閉じられる)
    await page.keyboard.press("Escape");
    await expect(detail.getByTestId("detail-more-menu")).toBeHidden();
    // 外 (詳細の背景) を押すとメニューだけ閉じる。その押下は下に届かず、詳細は開いたまま
    await detail.getByTestId("detail-more").click();
    await expect(detail.getByTestId("detail-more-menu")).toBeVisible();
    await detail
      .locator(".detail-backdrop")
      .click({ position: { x: 5, y: 5 } });
    await expect(detail.getByTestId("detail-more-menu")).toBeHidden();
    await expect(detail).toBeVisible();
    // 引き金をもう一度押しても閉じる
    await detail.getByTestId("detail-more").click();
    await expect(detail.getByTestId("detail-more-menu")).toBeVisible();
    await detail.getByTestId("detail-more").click();
    await expect(detail.getByTestId("detail-more-menu")).toBeHidden();
    await expect(detail).toBeVisible();
    await page.getByTestId("detail-close").click();
    await expect(detail).toHaveCount(0);

    // ファイルは Range で取得できる。プレイヤーはこれでシークするので、
    // 対応していないと全部落とし終わるまで早送りできない
    const id = await recording.getAttribute("data-recording-id");
    expect(id).toBeTruthy();
    // 信頼するネットワーク (E2E はローカル) からは、資格情報なしでそのまま取れる
    const part = await request.get(`/api/recordings/${id}/file`, {
      headers: { Range: "bytes=0-99" },
    });
    expect(part.status()).toBe(206);
    expect(part.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect((await part.body()).byteLength).toBe(100);

    // 再生のためのエンドポイントなので、前の `?download=1` を付けても添付にはしない
    const plain = await request.head(`/api/recordings/${id}/file?download=1`);
    expect(plain.status()).toBe(200);
    expect(plain.headers()["content-disposition"]).toBeUndefined();

    // 節目ごとに通知が飛び、どれも番組名と一緒にチャンネル名が入っていること。
    // 番組名だけだと、どの局のものか通知を見ただけでは分からない
    const state = await (
      await request.get(`${stack.webhookUrl}/__control/state`)
    ).json();
    const events = state.webhookCalls.map(
      (call: { event: string }) => call.event,
    );
    expect(events).toContain("recording.started");
    expect(events).toContain("recording.finished");
    expect(events).toContain("encode.finished");
    for (const call of state.webhookCalls as {
      text: string;
      recording?: { service: string };
    }[]) {
      expect(call.text).toContain("ＢＳ１１イレブン");
      expect(call.recording?.service).toBe("ＢＳ１１イレブン");
    }

    /*
     * 番組表のほうも「完了」になっていること。
     *
     * 予約の行が持っているのは録り始めた時刻だけで、そこから先の状態は
     * 録画の行から引く。番組表が予約の状態をそのまま出していた頃は、
     * 録り終えた番組が「予約済み」のまま並び、詳細に取消ボタンまで出ていた
     * (取り消せるのは scheduled / conflict / recording だけ)
     */
    await goto(page, "/guide?type=BS");
    await expect(cellOf(page, programId)).toContainText("完了");

    // 後続のテストに通知先を持ち越さない
    await goto(page, "/settings/integrations");
    await page.getByTestId("webhook-delete").first().click();
    await page.getByTestId("webhook-delete-confirm").click();
    await expect(page.getByTestId("webhook-delete-confirm")).toHaveCount(0);
  });
});

test.describe("エンコードしない", () => {
  test.afterEach(async ({ request }) => {
    await setRecording(request);
  });

  /*
   * コーデックはチェックで選ぶ。**どちらも外すと「エンコードしない」** —
   * 別に「エンコードする」のチェックを持たないので、外れていることが
   * そのまま「エンコードしない」になる
   */
  test("コーデックをどちらも外すと、元の TS のまま保存先に置く", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    await goto(page, "/settings/recording");
    await page.getByTestId("codec-av1").uncheck();
    await page.getByTestId("codec-h264").uncheck();
    await expect(page.getByTestId("saved-result")).toBeVisible();
    // 選び直しても残っていること (どちらも外れたまま)
    await goto(page, "/settings/recording");
    await expect(page.getByTestId("codec-av1")).not.toBeChecked();
    await expect(page.getByTestId("codec-h264")).not.toBeChecked();

    const programId = await reserveSoon(page, request, "BS");
    const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;
    await waitWatchable(page, page.locator(row));

    // エンコードせずに置いたので mkv ではない。エンコードの進み具合も出ない
    const path =
      (await page.locator(row).getAttribute("data-library-path")) ?? "";
    expect(path).toContain(".m2ts");
    await expect(page.locator(row).getByTestId("encode-progress")).toHaveCount(
      0,
    );
    // 録画の状態の API も「エンコード済みは無い」と答える。観られるかどうかは state のほう
    const id = await page.locator(row).getAttribute("data-recording-id");
    const status = await request.get(`/api/recordings/${id}`);
    expect(await status.json()).toMatchObject({
      encoded: false,
      state: "available",
    });

    /*
     * 再エンコードのボタンは出ない。**エンコードしない設定では元の TS がそのまま保存先へ移る**ので、
     * 元にできる TS がもう無い (「元の TS も残す」はエンコードしたときの話)。
     * エンコードしたくなったらコーデックを選んで録り直すことになる
     */
    await page.locator(row).getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("reencode-button")).toHaveCount(0);

    // 後片付け。**エンコードする設定に戻す** (他のテストや本番の既定に揃える)
    await goto(page, "/settings/recording");
    await page.getByTestId("codec-av1").check();
    await expect(page.getByTestId("saved-result")).toBeVisible();
  });
});
