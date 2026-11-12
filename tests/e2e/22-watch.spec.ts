import { expect, goto, recordOne, test, wakeControls } from "./helpers";
import { sharedRecording } from "./watch";

/**
 * 録画をブラウザで観る画面 (`/watch/<id>`)。
 *
 * **映像が出るところまでは見ません。** 偽 ffmpeg が置くのは中身の無いファイルで、
 * ブラウザは当然読めない。ここで確かめるのは**画面の作り**のほう —
 * 一覧から 1 回で来られるか、右に番組の中身が出るか、観たその場で消せるか。
 * 押したときの読み方 (どこでも一時停止・左右 2 回で 10 秒・チャプター送り) は
 * `src/lib/ts/watch.test.ts` が持っている。
 *
 * 1 本で 1 分を超えていたので分けた。シークバーをつまむ操作、字幕、ショートカット、切り抜きは 22-watch-clips に、
 * 再生の操作と画面の並び (スマホ・指・iPhone を含む) は 22-watch-layout にある。
 * データ放送のサイドカーを置くテストは 23-watch-data と 23-watch-data-receive にある
 */

/**
 * 読み取りだけのテストは**1 本の録画を使い回す** (`sharedRecording`)。
 * 録画を消すテストだけが自分のぶんを録る (使い回しの 1 本を壊さない)
 */
const watchable = sharedRecording();

test.describe("録画を観る", () => {
  test("一覧の行から観る画面へ行き、右に番組の中身が出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, "/");
    const row = page.locator(
      `[data-testid="recording-row"][data-recording-id="${id}"]`,
    );
    /*
     * **行そのものが観る入口。** 再生ボタンは置いていない (印は出す) ので、
     * 行を押したら観る画面へ来ること
     */
    await expect(row.getByTestId("play-hint")).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));

    /*
     * **観るのはエンコードしたものだけ。** 元の TS は MPEG-2 で、ブラウザにデコーダが
     * 無い (docs/stream.md#放送そのままmpeg-2を送る)。名指ししていないと、エンコードしている最中は
     * 元の TS が返ってきて何も映らない
     */
    const video = page.getByTestId("watch-video");
    await expect(video).toHaveAttribute(
      "src",
      `/api/recordings/${id}/file?source=encoded`,
    );

    // 右には番組の中身。一覧のモーダルと同じものを枠なしで置いてある
    await expect(page.getByTestId("detail-badges")).toBeVisible();
    await expect(page.getByTestId("watch-meta")).toBeVisible();
  });

  /*
   * **番組表から消えても、ジャンルと音声のラベルは出る。** 録画の行は録り始めに
   * 番組表から写している (recorder)。番組表の行は 24 時間で消えるので、そのあとは
   * この写しだけが頼り — なのに詳細の種を組み直すところで null に潰していて、
   * **1 日過ぎた録画だけラベルが消えていた** (実機、2026-09-11)。
   *
   * 番組表から引き直すエンドポイントを 404 にして「消えたあと」を作る
   */
  test("番組表から消えた録画でも、行のジャンルと音声のラベルが出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.route("/api/programs/*", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    await goto(page, `/watch/${id}`);

    const badges = page.getByTestId("detail-badges");
    await expect(badges).toBeVisible();
    // 偽の番組表は全部「アニメ／特撮 > 国内アニメ」(05-rules と同じ前提)
    await expect(badges.getByTestId("detail-genre").first()).toHaveText(
      "アニメ／特撮 > 国内アニメ",
    );
    await expect(badges.getByTestId("detail-audio").first()).toBeVisible();
  });

  /**
   * **観終わったその場で消せる。** 末尾はたいてい CM なので、流したまま消せる
   * のが狙い。押し間違い防止に 2 回押させるのは一覧と同じ
   */
  test("観ながら消せる。1 回目は聞き返すだけ", async ({ page, request }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);

    await goto(page, `/watch/${id}`);
    // 削除は映像の上の右端の列 (全画面のタブレットでも押せる)
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-delete").click();
    await expect(page.getByTestId("watch-delete-confirm")).toBeVisible();

    // 他所を触ったら取り下げる (一覧と同じ癖)
    await page.getByTestId("detail-badges").click();
    await expect(page.getByTestId("watch-delete-confirm")).toHaveCount(0);

    // 右の列は映像から離れた間に引っ込んでいる。起こしてから押す
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-delete").click();
    await page.getByTestId("watch-delete-confirm").click();

    // 消えたら一覧へ戻る。消したものの画面に留まっても見るものが無い
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);
  });

  /**
   * **チャプターの位置はエンコードしたものから読む** (`api/recordings/<id>/chapters`)。
   *
   * 偽 ffmpeg が置くファイルにチャプターは入っていないので、ここで見るのは
   * 「無くても落ちない」こと。**取れないだけで観られなくなってはいけない**
   */
  test("チャプターが読めなくても観る画面は出る", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    const res = await request.get(`/api/recordings/${id}/chapters`);
    expect(res.ok()).toBe(true);
    expect((await res.json()).chapters).toEqual([]);

    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-video")).toBeVisible();
    // 入っていないときは送りのボタンを出さない (押しても何も起きない操作を並べない)
    await expect(page.getByTestId("watch-next-chapter")).toHaveCount(0);
  });

  /**
   * **シークバーの CM は琥珀で分ける** (denpa-tv と同じ色)。続いている CM は 1 本にまとめ、
   * CM の端で溝を区切る (`seek-track.ts`。区切りの計算は単体試験が持つ)。観たぶんは CM の中では濃い琥珀。
   *
   * 偽の録画にはチャプターも尺も無いので、チャプターは API ごと差し替え、尺と位置は映像の要素に
   * 持たせて「読み込めた」と知らせる (中身の無いファイルはブラウザが読めない)
   */
  test("シークバーの CM の区間が琥珀で分かれ、読み上げでも CM と分かる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.route("**/api/recordings/*/chapters", (route) =>
      route.fulfill({
        json: {
          chapters: [
            { start: 0, end: 10, title: "CM" },
            { start: 10, end: 400, title: "本編" },
            { start: 400, end: 415, title: "CM" },
            { start: 415, end: 430, title: "CM" },
            { start: 430, end: 1000, title: "本編" },
          ],
        },
      }),
    );
    await goto(page, `/watch/${id}`);

    const seek = page.getByTestId("watch-seek");
    // 続いている CM (400–415・415–430) は 1 本の区間
    await expect(seek).toHaveAttribute("data-cm", "0-10 400-430");
    // 先頭は CM。色だけに頼らず、読み上げる位置にチャプターの名前を添える
    await expect(seek).toHaveAttribute("aria-valuetext", "0:00、CM");

    await page.getByTestId("watch-video").evaluate((video) => {
      Object.defineProperty(video, "duration", { value: 1000 });
      Object.defineProperty(video, "currentTime", {
        value: 200,
        writable: true,
      });
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("timeupdate"));
    });
    const parts = seek.locator("xpath=..").locator("[data-part]");
    // 溝は CM の端で区切った 4 つ (先頭の CM・本編・続いた CM・本編)
    await expect
      .poll(() =>
        parts.evaluateAll((els) =>
          els.map((el) => (el as HTMLElement).dataset["part"]),
        ),
      )
      .toEqual(["cm", "main", "cm", "main"]);
    // 2 本目は 400 秒 (40%) から 430 秒 (43%) まで
    const second = parts.nth(2);
    expect(
      await second.evaluate((el) => [el.style.left, el.style.width]),
    ).toEqual(["40%", "3%"]);

    // CM と本編は色で分かれる。観たぶんは CM の中では濃い琥珀 (200 秒なので先頭の CM は観終わり、本編は半ばまで)
    const look = (part: number) =>
      parts.nth(part).evaluate((el) => {
        const bar = el.firstElementChild as HTMLElement;
        const played = bar.firstElementChild as HTMLElement;
        return {
          bar: getComputedStyle(bar).backgroundColor,
          played: getComputedStyle(played).backgroundColor,
          width: played.style.width,
        };
      });
    await expect.poll(async () => (await look(1)).width).toBe("48.72%");
    const cm = await look(0);
    const main = await look(1);
    expect(cm.bar).not.toBe(main.bar);
    expect(cm.played).toBe("rgb(255, 179, 0)");
    expect(cm.played).not.toBe(main.played);
    expect(cm.width).toBe("100%");
  });

  /**
   * **CM 検出をやり直したら、開いている観る画面もチャプターを取り直す** (`chapters` の通知)。
   * 位置は動かさない。本物のやり直しは 03 が見ているので、ここではチャプターと通知を差し替える。
   * 通知の繋ぎは、やり直すまで返さずに待たせておき、やり直したら通知を 1 つだけ流す
   */
  test("CM 検出をやり直すと、開いている画面のシークバーにも CM が出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    let redone = false;
    let redo = () => {};
    const redoing = new Promise<void>((done) => {
      redo = done;
    });
    await page.route("**/api/recordings/*/chapters", (route) =>
      route.fulfill({
        json: {
          chapters: redone
            ? [
                { start: 0, end: 10, title: "CM" },
                { start: 10, end: 1000, title: "本編" },
              ]
            : [],
        },
      }),
    );
    await page.route("**/api/events", async (route) => {
      await redoing;
      await route.fulfill({
        contentType: "text/event-stream",
        // 流し終えたら繋ぎ直させない (繋ぎ直すたびに画面を読み直す)
        body: `retry: 600000\nevent: chapters\ndata: {"recordingId":${id}}\n\n`,
      });
    });
    await goto(page, `/watch/${id}`);

    const seek = page.getByTestId("watch-seek");
    const video = page.getByTestId("watch-video");
    await expect(video).toBeVisible();
    await video.evaluate((el) => {
      Object.defineProperty(el, "duration", { value: 1000 });
      Object.defineProperty(el, "currentTime", { value: 200, writable: true });
      el.dispatchEvent(new Event("loadedmetadata"));
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(await seek.getAttribute("data-cm")).toBeNull();

    redone = true;
    redo();
    await expect(seek).toHaveAttribute("data-cm", "0-10");
    // チャプターを差し替えただけで、位置はそのまま
    expect(
      await video.evaluate((el) => (el as HTMLVideoElement).currentTime),
    ).toBe(200);
  });
});
