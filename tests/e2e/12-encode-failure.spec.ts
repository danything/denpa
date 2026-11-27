import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  encodeSpans,
  expect,
  goto,
  recordOne,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  waitRowState,
} from "./helpers";

/**
 * エンコードが失敗したときの見え方と後始末。
 * 失敗の表示が消せないと、直したあとも延々と残って邪魔になる。
 */
test.describe("エンコードの失敗", () => {
  test.afterAll(({ stack }) => {
    if (existsSync(stack.failFile)) rmSync(stack.failFile);
  });

  test("失敗したエンコードは行の状態に出て、理由は詳細で見られる", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    // ここから先のエンコードを失敗させる
    writeFileSync(stack.failFile, "1");

    await reserveSoon(page, request, "BS");

    /*
     * 失敗したものは進み具合を出さない。行に残るのは状態だけ。
     *
     * 出るのは「エンコード失敗」であって「失敗」ではない。落ちたのは再エンコードの
     * ほうなので、録画そのものの状態 (録画済み) には手を付けない
     */
    await waitRowState(
      page,
      "/",
      page.locator('[data-testid="recording-row"]').last(),
      "エンコード失敗",
    );
    await goto(page, "/");
    await expect(page.getByTestId("encode-progress")).toHaveCount(0);
    const failed = page
      .getByTestId("recording-row")
      .filter({
        has: page.getByTestId("recording-state").getByText("エンコード失敗"),
      })
      .first();
    await expect(failed.getByTestId("recording-state")).toHaveText(
      "エンコード失敗",
    );

    /*
     * **観られる。** エンコードできていなくても元の TS は無事で、追っかけ再生の画面 (/chase) が
     * サーバで再エンコードして運ぶ (25-chase)。行には再生の印が出て、押すと追っかけへ。
     * 以前は「エンコードできていない = 観られない」で印を消していたが、元の TS がある限り観られる
     */
    await expect(failed.getByTestId("play-hint")).toBeVisible();

    // 理由は行の「詳細」から。ffmpeg の出力は長いので一覧には貼らない
    // (観られる行は押すと再生に行くので、詳細は別のボタン)
    await failed.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    // 理由は 1 つだけ。録画そのものは失敗していないので、出るのはジョブ側の理由だけ
    const note = detail.getByTestId("detail-error");
    await expect(note).toHaveCount(1);
    await expect(note).toContainText("エンコードに失敗しました");
    await expect(note).toContainText("Error initializing the encoder");
    // 警告に埋もれず、止まった理由だけが出ていること
    await expect(note).not.toContainText("has not been used for any stream");
    await page.getByTestId("detail-close").click();
    await expect(detail).toHaveCount(0);

    // 削除は 2 回押させる。1 回目は聞き返すだけで、まだ消えない
    await failed.getByTestId("delete-button").click();
    await expect(failed.getByTestId("delete-confirm")).toBeVisible();
    await expect(failed).toHaveCount(1);

    /*
     * **他所を触ったら取り下げる。**
     *
     * 時間で戻すだけだと、間違えて押したことに気付いて別のところを触っても
     * まだ構えたままで、その数秒のうちに同じ場所をもう一度押すと消える
     */
    // 画面から出ない場所を触る (行を押すと再生・詳細に行ってしまう)
    await page.getByTestId("timeline-now").click();
    await expect(failed.getByTestId("delete-confirm")).toHaveCount(0);
    await expect(failed.getByTestId("delete-button")).toBeVisible();

    await failed.getByTestId("delete-button").click();
    await expect(failed.getByTestId("delete-confirm")).toBeVisible();

    const id = await failed.getAttribute("data-recording-id");
    await failed.getByTestId("delete-confirm").click();
    await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);

    rmSync(stack.failFile);
  });
});

/**
 * コーデックをいくつも選んだときは、コーデックごとに ffmpeg を 1 本ずつ同時に走らせる。
 * **1 本が落ちても、ほかは止めずに置く** (観られるものを捨てない)。ジョブは失敗にして理由を残し、
 * 元の TS は消さない (再エンコードすれば全部作り直せる)
 */
test.describe("コーデックの片方だけ失敗する", () => {
  test.afterAll(async ({ request, stack }) => {
    if (existsSync(stack.failEncoderFile)) rmSync(stack.failEncoderFile);
    await setRecording(request);
  });

  test("H.264 が落ちても AV1 は置かれて観られ、理由は H.264 のぶんとして出る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await setRecording(request, { codecs: ["av1", "h264"] });
    // H.264 (libx264) を使うエンコードだけ失敗させる
    writeFileSync(stack.failEncoderFile, "libx264");

    const programId = await reserveSoon(page, request, "BS");
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitRowState(page, "/", row, "エンコード失敗");
    await goto(page, "/");

    // AV1 は置かれている (H.264 が落ちても止めていない)。H.264 は置かれない
    const av1 = (await row.getAttribute("data-library-path")) ?? "";
    expect(av1).toMatch(/\.mkv$/);
    expect(existsSync(av1)).toBe(true);
    expect(await row.getAttribute("data-alt-path")).toBeFalsy();
    await expect(row.getByTestId("play-hint")).toBeVisible();

    // AV1 は最後までエンコードしている (落ちた H.264 に巻き込まれて止められていない)
    const id = (await row.getAttribute("data-recording-id")) ?? "";
    const spans = encodeSpans(stack.encodeSpansFile, id);
    const done = spans.filter((s) => s.output.endsWith(".av1.encoding"));
    expect(done).toHaveLength(1);
    expect(done[0]!.end).not.toBeNull();

    // 理由はどのコーデックが落ちたかを添えて出る
    await row.getByTestId("detail-button").click();
    const note = page.getByTestId("program-detail").getByTestId("detail-error");
    await expect(note).toContainText("H.264:");
    await expect(note).toContainText("libx264");
    await page.getByTestId("detail-close").click();

    // 落ちた H.264 の作業ファイルは残さない
    expect(
      readdirSync(dirname(av1)).filter((name) => name.endsWith(".encoding")),
    ).toEqual([]);
  });
});

/**
 * **再エンコードは出来上がってから前のものと置き換える** (#3238)。失敗しても前のものは残って観られる。
 * 元の TS を手で消した録画では、再エンコードを押せず (理由を出す)、サーバも断る
 */
test.describe("再エンコードの失敗と元の TS", () => {
  test.afterAll(async ({ request, stack }) => {
    if (existsSync(stack.failEncoderFile)) rmSync(stack.failEncoderFile);
    await setRecording(request);
  });

  test("再エンコードが失敗しても前のものは残り、元の TS を消したら押せない", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(240_000);
    await setRecording(request, { keepOriginal: true });
    const { id, libraryPath } = await recordOne(page, request);
    expect(libraryPath).toMatch(/\.mkv$/);
    const row = page.locator(`[data-recording-id="${id}"]`);

    // 再エンコードの AV1 (libsvtav1) を失敗させる。前のものは消えず、行も同じものを指す
    writeFileSync(stack.failEncoderFile, "libsvtav1");
    const res = await request.post("/?/reencode", { form: { id } });
    expect(res.ok()).toBe(true);
    await waitRowState(page, "/", row, "エンコード失敗");
    expect(await row.getAttribute("data-library-path")).toBe(libraryPath);
    expect(existsSync(libraryPath)).toBe(true);
    rmSync(stack.failEncoderFile);

    // 元の TS を手で消す (作業領域の `<シリーズ名>-<日時>-<録画ID>.m2ts`)
    const raw = readdirSync(stack.rawDir).filter((name) =>
      name.endsWith(`-${id}.m2ts`),
    );
    expect(raw).toHaveLength(1);
    rmSync(join(stack.rawDir, raw[0]!));

    // 詳細の「その他…」の再エンコードは押せず、理由が出る
    await goto(page, "/");
    await row.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    await expect(detail.getByTestId("reencode-button")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(detail.getByTestId("reencode-note")).toHaveText(
      "元の TS が見つからないため、再エンコードできません",
    );

    // 画面の外から送っても断る
    const refused = await request.post("/?/reencode", {
      form: { id },
      headers: { accept: "application/json", "x-sveltekit-action": "true" },
    });
    const body = (await refused.json()) as { type: string; status: number };
    expect(body).toMatchObject({ type: "failure", status: 409 });
    expect(existsSync(libraryPath)).toBe(true);
  });
});

/**
 * **開いてから通知が繋がるまでの間に変わったものも、行に出る** (`live-updates` の `hello`)。
 * 偽 ffmpeg が全部の呼び出しを失敗させると、再エンコードは 0.1 秒ほどで失敗して終わる。画面を描いたあと通知が繋がる前に
 * 終わると、行は描いたときの「CM 検出中」のまま、次の通知まで変わらなかった
 */
test.describe("開いた直後の変化", () => {
  test.afterAll(async ({ request, stack }) => {
    if (existsSync(stack.failFile)) rmSync(stack.failFile);
    await setRecording(request);
  });

  test("通知が繋がる前に再エンコードが失敗しても、繋がったら行に出る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await setRecording(request, { keepOriginal: true });
    const { id } = await recordOne(page, request);

    // 通知の接続を止めておく。開いたあとに起きたことは、繋がるまで届かない
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/events", async (route) => {
      await gate;
      await route.continue();
    });
    await goto(page, "/");
    const state = page
      .locator(`[data-recording-id="${id}"]`)
      .getByTestId("recording-state");
    await expect(state).toHaveText("視聴可能");

    // 開いたあとで、再エンコードを失敗させる
    writeFileSync(stack.failFile, "1");
    const res = await request.post("/?/reencode", { form: { id } });
    expect(res.ok()).toBe(true);
    /*
     * 終わったことはサーバの描いた画面で確かめる。別のタブで開くと、戻ってきたときの読み直し (`Shell.svelte`) が
     * 先に追いついてしまう
     */
    const rowState = new RegExp(
      String.raw`data-recording-id="${id}"[\s\S]*?data-testid="recording-state"[^>]*>([^<]*)<`,
    );
    await expect
      .poll(
        async () => rowState.exec(await (await request.get("/")).text())?.[1],
        { timeout: 30_000 },
      )
      .toBe("エンコード失敗");
    rmSync(stack.failFile);
    await expect(state).toHaveText("視聴可能");

    // 繋がったら、読み直さなくても追いつく
    release();
    await expect(state).toHaveText("エンコード失敗", { timeout: 10_000 });
  });
});
