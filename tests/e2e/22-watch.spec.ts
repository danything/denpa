import { readFileSync } from "node:fs";

import type { APIRequestContext, Page } from "@playwright/test";

import {
  CAPTION_SCREENS,
  captionsClearOfBar,
  expect,
  expectSharpCaptions,
  expectSideAligned,
  expectSideFrame,
  FAKE_CAPTION,
  fakeFrame,
  flipSetting,
  goto,
  holdCaptions,
  leaveFullscreen,
  oneRowTroubles,
  openSettings,
  overlayTroubles,
  recordOne,
  routeCaptions,
  takeClip,
  test,
  wakeControls,
} from "./helpers";

/**
 * 録画をブラウザで観る画面 (`/watch/<id>`)。
 *
 * **映像が出るところまでは見ません。** 偽 ffmpeg が置くのは中身の無いファイルで、
 * ブラウザは当然読めない。ここで確かめるのは**画面の作り**のほう —
 * 一覧から1回で来られるか、右に番組の中身が出るか、観たその場で消せるか。
 * 押したときの読み方 (どこでも一時停止・左右2回で10秒・チャプター送り) は
 * `src/lib/ts/watch.test.ts` が持っている。
 */

/**
 * 読み取りだけのテストは**1本の録画を使い回す**。全テストが `recordOne`
 * (予約→録画→エンコードの完了待ちで各15秒前後) を自前でやっていた頃は、この
 * ファイルだけで3分近く掛かり、e2e の一番遅いシャードそのものだった。
 * 録画を消すテストだけが自分のぶんを録る (使い回しの1本を壊さない)。
 * データ放送のサイドカーを置くテストは 23-watch-data に分けた (組の時間を割るため)
 */
let shared: { id: string } | null = null;
async function watchable(
  page: Page,
  request: APIRequestContext,
): Promise<string> {
  if (shared === null) shared = await recordOne(page, request);
  return shared.id;
}

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
     * **観るのはエンコードしたものだけ。** 元のTSは MPEG-2 で、ブラウザにデコーダが
     * 無い (docs/stream.md#放送そのままmpeg-2を送る)。名指ししていないと、エンコードしている最中は
     * 元のTSが返ってきて何も映らない
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
   * 番組表から写している (recorder)。番組表の行は24時間で消えるので、そのあとは
   * この写しだけが頼り — なのに詳細の種を組み直すところで null に潰していて、
   * **1日過ぎた録画だけラベルが消えていた** (実機、2026-09-11)。
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
   * のが狙い。押し間違い防止に2回押させるのは一覧と同じ
   */
  test("観ながら消せる。1回目は聞き返すだけ", async ({ page, request }) => {
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
   * **シークバーの CM は琥珀で分ける** (denpa-tv と同じ色)。続いている CM は1本にまとめ、
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
    // 続いている CM (400–415・415–430) は1本の区間
    await expect(seek).toHaveAttribute("data-cm", "0-10 400-430");
    // 頭は CM。色だけに頼らず、読み上げる位置にチャプターの名前を添える
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
    // 溝は CM の端で区切った4つ (頭の CM・本編・続いた CM・本編)
    await expect
      .poll(() =>
        parts.evaluateAll((els) =>
          els.map((el) => (el as HTMLElement).dataset["part"]),
        ),
      )
      .toEqual(["cm", "main", "cm", "main"]);
    // 2本目は 400 秒 (40%) から 430 秒 (43%) まで
    const second = parts.nth(2);
    expect(
      await second.evaluate((el) => [el.style.left, el.style.width]),
    ).toEqual(["40%", "3%"]);

    // CM と本編は色で分かれる。観たぶんは CM の中では濃い琥珀 (200 秒なので頭の CM は観終わり、本編は半ばまで)
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
   * **CM検出をやり直したら、開いている観る画面もチャプターを取り直す** (`chapters` の通知)。
   * 位置は動かさない。本物のやり直しは 03 が見ているので、ここではチャプターと通知を差し替える。
   * 通知の繋ぎは、やり直すまで返さずに待たせておき、やり直したら通知を1つだけ流す
   */
  test("CM検出をやり直すと、開いている画面のシークバーにも CM が出る", async ({
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

  /**
   * **つまんで動かす間、つまみは指にそのまま付いてくる** (`SeekBar`)。タブレットで、動かすたびに
   * 飛んでいた頃はつまみが指から遅れていた。飛ぶのは下見を1度に1つまで (飛び終わってから次) と、
   * 離したときの1回。動かしている間に届く位置ではつまみを戻さず、CM も飛ばさない。
   * 離した先が CM なら、いつもどおり飛ばす。
   *
   * 偽の録画は読めないので、位置は映像の要素に持たせ、代入された回数を数える。
   * `seeked` は来ない (下見は飛び終わりを待ったまま)
   */
  test("シークバーをつまむと、つまみが付いてきて、飛ぶのは数回だけ", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.route("**/api/recordings/*/chapters", (route) =>
      route.fulfill({
        json: {
          chapters: [
            { start: 0, end: 400, title: "本編" },
            { start: 400, end: 430, title: "CM" },
            { start: 430, end: 1000, title: "本編" },
          ],
        },
      }),
    );
    await goto(page, `/watch/${id}`);
    const seek = page.getByTestId("watch-seek");
    await expect(seek).toHaveAttribute("data-cm", "400-430");

    const video = page.getByTestId("watch-video");
    await video.evaluate((el) => {
      const w = window as unknown as {
        seekTo: number;
        seeks: number[];
        seeked: number;
      };
      w.seekTo = 200;
      w.seeks = [];
      w.seeked = 0;
      Object.defineProperty(el, "duration", { value: 1000 });
      Object.defineProperty(el, "currentTime", {
        get: () => w.seekTo,
        set: (to: number) => {
          w.seekTo = to;
          w.seeks.push(to);
        },
      });
      el.addEventListener("seeked", () => w.seeked++);
      el.dispatchEvent(new Event("loadedmetadata"));
      el.dispatchEvent(new Event("timeupdate"));
    });
    const seeks = () =>
      page.evaluate(() => (window as unknown as { seeks: number[] }).seeks);
    const clockText = page.getByTestId("watch-clock");
    await expect(clockText).toContainText("3:20 / 16:40");
    // 偽の録画はロゴでの判定に失敗していて、CM 飛ばしは外れて始まる (`skipCmAtStart`)。入れておく
    await flipSetting(page, "watch", "skip-cm");
    await expect(page.getByTestId("watch-skip-cm")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const bar = seek.locator("xpath=..");
    const thumb = bar.locator(".thumb");
    const left = async () =>
      Number.parseFloat(
        await thumb.evaluate((el) => (el as HTMLElement).style.left),
      );
    await wakeControls(page, "watch-stage");
    const box = (await bar.boundingBox())!;
    const y = box.y + box.height / 2;
    const x = (ratio: number) => box.x + box.width * ratio;

    await page.mouse.move(x(0.2), y);
    await page.mouse.down();
    await expect.poll(left).toBeCloseTo(20, 0);
    // 動かしている間、つまみも時刻も指の位置。飛び終わり (`seeked`) を待たない
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x(0.2 + (0.21 * i) / 20), y);
      expect(Math.abs((await left()) - (20 + 21 * (i / 20)))).toBeLessThan(0.6);
    }
    await expect(clockText).toContainText("6:50 / 16:40");
    expect(
      await page.evaluate(
        () => (window as unknown as { seeked: number }).seeked,
      ),
    ).toBe(0);
    // 21回動かしても、下見は飛び終わりを待つ (着かなければ 1 秒) ので、押したときの1つと多くて1つ
    expect((await seeks()).length).toBeLessThanOrEqual(2);

    // 下見が着いたことにしても (`timeupdate` で元の位置が届いても)、つまみは戻らず、CM も飛ばさない
    await page.waitForTimeout(1300);
    const during = (await seeks()).length;
    expect(during).toBeLessThanOrEqual(3);
    await page.evaluate(() => {
      (window as unknown as { seekTo: number }).seekTo = 200;
    });
    await video.evaluate((el) => el.dispatchEvent(new Event("timeupdate")));
    await page.evaluate(() => {
      (window as unknown as { seekTo: number }).seekTo = 410;
    });
    await video.evaluate((el) => el.dispatchEvent(new Event("timeupdate")));
    expect(await left()).toBeCloseTo(41, 0);
    expect((await seeks()).length).toBe(during);

    // 離すと、その位置へちゃんと1回飛ぶ。つまみはそこに居る
    await page.mouse.up();
    await expect
      .poll(async () => (await seeks()).slice(during)[0])
      .toBeCloseTo(410, 0);
    expect(await left()).toBeCloseTo(41, 0);
    // 着いた先は CM。いつもどおり先へ飛ぶ
    await video.evaluate((el) => el.dispatchEvent(new Event("timeupdate")));
    await expect
      .poll(async () => (await seeks()).at(-1))
      .toBeGreaterThanOrEqual(429);
    expect((await seeks()).length).toBe(during + 2);
  });

  /**
   * **字幕は canvas に描いて重ねる。** ライブ (`/live`) と同じやり方。
   *
   * 文字を `<track>` に渡す方法は放送どおりには出ない (左右の位置・背景の箱・外字が落ちる)。
   * 入れ物に入っている放送の字幕 (`S_ARIBSUB`) をサーバがデコードして文字の配置で渡し
   * (`captions.json`)、画面が描く (`caption-draw.ts`)
   */
  test("字幕が届き、持っているときだけボタンが出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    const text = await request.get(`/api/recordings/${id}/captions.json`);
    expect(text.ok()).toBe(true);
    const pages = (await text.json()) as {
      v: number;
      pages: { at: number; page: { runs: unknown[] } }[];
    };
    expect(pages.v).toBe(1);
    expect(pages.pages.some((p) => p.page.runs.length > 0)).toBe(true);

    await goto(page, `/watch/${id}`);
    // 重ねる先は映像と同じ枠に敷いてある。**押す邪魔をしない**
    const canvas = page.getByTestId("watch-captions-canvas");
    await expect(canvas).toHaveCount(1);
    await expect(canvas).toHaveCSS("pointer-events", "none");

    // **既定で出す。** ライブと同じ (テレビの字幕ボタンとは違い、観る画面は出す側)
    const button = page.getByTestId("watch-captions");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    // オンの線は 1 本 (切り替えの共通の短い下線を重ねない)
    await expect(button).toHaveCSS("background-image", "none");
    await wakeControls(page, "watch-stage");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });

  /*
   * **字幕の言語を再生の設定 (⚙) で選ぶ。** 字幕1本に英語も載っている録画 (`captions.json` の `others`)。
   * 選んだ言語と出し入れは端末に覚え、開き直しても続く (`caption-pref.ts`)
   */
  test("字幕の言語を ⚙ で選び、出し入れと一緒に覚える", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    const english = {
      ...FAKE_CAPTION,
      runs: [{ ...FAKE_CAPTION.runs[0]!, text: "English captions" }],
    };
    await page.route("**/api/recordings/*/captions.json", (route) =>
      route.fulfill({
        json: {
          v: 1,
          pages: [{ at: 0, page: FAKE_CAPTION }],
          language: { index: 1, code: "jpn", label: "日本語" },
          others: [
            {
              index: 2,
              code: "eng",
              label: "英語",
              pages: [{ at: 0, page: english }],
            },
          ],
        },
      }),
    );
    await goto(page, `/watch/${id}`);
    await wakeControls(page, "watch-stage");

    const row = page.getByTestId("watch-subtitle");
    await expect(row).toContainText("日本語");
    await openSettings(page, "watch");
    await row.click();
    const options = page.getByTestId("watch-subtitle-option");
    await expect(options).toHaveText(["オフ", "日本語", "英語"]);
    await page
      .locator('[data-testid="watch-subtitle-option"][data-subtitle="0:2"]')
      .click();
    await expect(row).toContainText("英語");
    expect(
      await page.evaluate(() => localStorage.getItem("caption-language")),
    ).toBe("eng");

    // 開き直しても英語のまま
    await page.reload();
    await expect(page.getByTestId("watch-subtitle")).toContainText("英語");

    // オフも覚える。字幕ボタンも消えた形になる
    await wakeControls(page, "watch-stage");
    await openSettings(page, "watch");
    await page.getByTestId("watch-subtitle").click();
    await page
      .locator('[data-testid="watch-subtitle-option"][data-subtitle="off"]')
      .click();
    await expect(page.getByTestId("watch-captions")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.reload();
    await expect(page.getByTestId("watch-subtitle")).toContainText("オフ");
    await expect(page.getByTestId("watch-captions")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /*
   * **字幕を待たずに観はじめる。** サーバは字幕を作るのに動画を丸ごと読む (初回は1時間の録画で1秒ほど)。
   * 開いた時点で取っていた頃は観はじめの読み込みと取り合い、最初のコマが字幕の応答のすぐ後まで出なかった。
   * 字幕は映像が出てから取る (`askCaptions`)。ここでは本物の映像 (`tests/fake/live-av1.mp4`) を渡し、
   * 字幕の応答を止めたままでも映像が出ることを見る
   */
  test("字幕の応答が遅くても、映像は字幕を待たずに出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.route(`**/api/recordings/${id}/playback`, (route) =>
      route.fulfill({
        json: {
          duration: 60,
          axis: "encoded",
          audios: [{ id: "0", label: "" }],
          offers: [
            {
              codec: "av1",
              way: "file",
              source: "encoded",
              codecs: "av01.0.08M.08,opus",
            },
          ],
        },
      }),
    );
    const clip = readFileSync(new URL("../fake/live-av1.mp4", import.meta.url));
    await page.route(`**/api/recordings/${id}/file?**`, (route) =>
      route.fulfill({ status: 200, contentType: "video/mp4", body: clip }),
    );
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    await page.route(`**/api/recordings/${id}/captions.json`, async (route) => {
      asked = true;
      await held;
      await route.fulfill({
        json: { v: 1, pages: [{ at: 0, page: FAKE_CAPTION }] },
      });
    });

    await goto(page, `/watch/${id}`);
    const video = page.getByTestId("watch-video");
    // 最初のコマが出る (字幕の応答はまだ返していない)
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    // 字幕は映像が出てから取りに来る
    await expect.poll(() => asked).toBe(true);
    await expect(page.getByTestId("watch-captions")).toHaveCount(0);

    // 届いたら出す
    release();
    await expect(page.getByTestId("watch-captions")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * **Ctrl+C は字幕の切り替えではなく、コピーのまま。** 観ながら番組名や
   * URL を写せなかった (キーの `c` が修飾キーを見ずに横取りして
   * `preventDefault` していた)。素の `c` だけが字幕を切り替えること
   */
  test("修飾キー付きのショートカットは横取りしない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);

    const button = page.getByTestId("watch-captions");
    await expect(button).toHaveAttribute("aria-pressed", "true");

    // コピー (Ctrl / Cmd) は素通し。字幕は出たまま。**1回ずつ見る** (2回で元に戻ると見逃す)
    await page.keyboard.press("Control+c");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Meta+c");
    await expect(button).toHaveAttribute("aria-pressed", "true");

    // 素の c は今までどおり字幕を切り替える
    await page.keyboard.press("c");
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * **切り抜きはサーバに保存する** (`POST /api/clips`)。端末には落とさず、トーストに「保存しました」。
   * 番組の情報はサーバが録画から引く。画像は AVIF で配り、消すと 404。
   * **送れなかったとき (オフライン・サーバが断った) だけ**、今までどおり PNG を端末に落とす
   * (`番組名_YYYYMMDD-HHMMSS.png`。指の端末の共有シートはヘッドレスに無い)
   */
  test("切り抜きはサーバに保存し、送れなければ端末に保存する", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    const shot = page.getByTestId("watch-shot");
    await expect(shot).toBeVisible();
    const name =
      (await page.getByTestId("watch-name").textContent())?.trim() ?? "";

    // コマが無いうちは押しても何も起きない (送るものが無い)。画面も壊れない
    await wakeControls(page, "watch-stage");
    await shot.click();
    await expect(page.getByTestId("watch-video")).toBeVisible();

    await fakeFrame(page, "watch-video");
    await wakeControls(page, "watch-stage");
    const clip = await takeClip(page, "watch-shot");
    expect(clip).toMatchObject({ place: "watch", recordingId: Number(id) });
    expect(clip.programName).not.toBe("");
    expect(clip.offsetMs).not.toBeNull();

    // 探せる。画像は AVIF で、添付にはしない
    const found = (await (
      await request.get(`/api/clips?recording=${id}`)
    ).json()) as { clips: { id: number }[] };
    expect(found.clips.map((c) => c.id)).toContain(clip.id);
    const image = await request.get(`/api/clips/${clip.id}/image`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/avif");
    expect(image.headers()["cache-control"]).toContain("private");
    expect(image.headers()["content-disposition"]).toBeUndefined();
    expect((await request.get(`/api/clips/${clip.id}/small`)).status()).toBe(
      200,
    );
    // 画像でないものは 415
    expect(
      (
        await request.post(`/api/clips?place=watch&recording=${id}&at=1`, {
          headers: { "content-type": "image/png" },
          data: "<svg></svg>",
        })
      ).status(),
    ).toBe(415);
    expect((await request.delete(`/api/clips/${clip.id}`)).status()).toBe(204);
    expect((await request.get(`/api/clips/${clip.id}/image`)).status()).toBe(
      404,
    );

    // サーバが断ったら、端末に落とす (前と同じ名前)
    await page.route(
      (url) => url.pathname.endsWith("/api/clips"),
      (route) => route.fulfill({ status: 500 }),
    );
    await wakeControls(page, "watch-stage");
    const download = page.waitForEvent("download");
    await shot.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/_\d{8}-\d{6}\.png$/);
    expect(
      file
        .suggestedFilename()
        .startsWith(`${name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}_`),
    ).toBe(true);
    await expect(
      page.getByText("サーバに保存できなかったので端末に保存しました"),
    ).toBeVisible();
  });

  /**
   * **切り抜きの画面** (`/clips`)。撮った1枚が番組名つきで並び、言葉で絞れ、開いて「この場面から観る」で
   * 録画のその位置へ行ける。2回押しで消すと画像も 404。入口は広い形のヘッダー・観る画面の右の列・検索の結果
   */
  test("切り抜きの画面で探して開き、この場面から観られ、2回押しで消せる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);
    await fakeFrame(page, "watch-video");
    await wakeControls(page, "watch-stage");
    const clip = await takeClip(page, "watch-shot");

    // 観る画面の右の列に「この録画の切り抜き (n)」
    await goto(page, `/watch/${id}`);
    const fromWatch = page.getByTestId("watch-clips");
    await expect(fromWatch).toContainText("この録画の切り抜き");
    await expect(fromWatch).toHaveAttribute("href", `/clips?recording=${id}`);

    // 検索の結果に切り抜きの節
    await goto(page, `/search?q=${encodeURIComponent(clip.programName)}`);
    await expect(page.getByTestId("search-clips")).toBeVisible();
    await expect(page.getByTestId("search-clip").first()).toBeVisible();

    // 広い形のヘッダーから開く
    await page.getByTestId("nav-clips").click();
    await expect(page).toHaveURL(/\/clips$/);
    const card = page.locator(
      `[data-testid="clip-card"][data-clip-id="${clip.id}"]`,
    );
    await expect(card.getByTestId("clip-name")).toHaveText(clip.programName);

    // 言葉で絞る (番組名なら残り、無い言葉なら消える)
    const search = page.getByTestId("clip-search");
    await search.fill(clip.programName);
    await expect(page).toHaveURL(/\?q=/);
    await expect(card).toBeVisible();
    await search.fill("どこにも無い言葉");
    await expect(card).toHaveCount(0);
    await expect(page.getByText("当てはまるものはありません")).toBeVisible();
    await search.fill("");
    await expect(page).toHaveURL(/\/clips$/);

    // 開くと暗い全画面。「この場面から観る」で録画のその位置へ
    await card.click();
    const viewer = page.getByTestId("clip-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("clip-viewer-title")).toHaveText(
      clip.programName,
    );
    const watch = viewer.getByTestId("clip-watch");
    await expect(watch).toHaveAttribute(
      "href",
      new RegExp(String.raw`/watch/${id}\?at=\d+(\.\d)?$`),
    );
    await watch.click();
    await expect(page).toHaveURL(new RegExp(String.raw`/watch/${id}\?at=`));
    await expect(page.getByTestId("watch-video")).toBeVisible();

    // 2回押しで消える。画像も 404
    await goto(page, "/clips");
    await card.click();
    await viewer.getByTestId("clip-delete").click();
    await viewer.getByTestId("clip-delete-confirm").click();
    await expect(viewer).toBeHidden();
    await expect(card).toHaveCount(0);
    expect((await request.get(`/api/clips/${clip.id}/image`)).status()).toBe(
      404,
    );
  });

  /**
   * **字幕はあとから出し入れできる。** 字幕を出して撮ると、映像と字幕を分けて送り (multipart)、字幕が重なった1枚で並ぶ。
   * 開いた1枚の「字幕」で外す・戻すと `PATCH /api/clips/<id>` が元から重ね直し、読み直しても続く。
   * 撮ったときに無かったもの (コメント) の切り替えは出さない
   */
  test("切り抜きの字幕を開いた1枚で外し、戻せる", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await routeCaptions(page);
    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-captions-canvas")).toHaveAttribute(
      "data-drawn",
      "",
    );
    await fakeFrame(page, "watch-video");
    await wakeControls(page, "watch-stage");
    const posted = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname.endsWith("/api/clips"),
    );
    const clip = await takeClip(page, "watch-shot");
    const body = (await posted).postDataBuffer()?.toString("latin1") ?? "";
    expect((await posted).headers()["content-type"]).toContain(
      "multipart/form-data",
    );
    expect(body).toContain('name="frame"');
    expect(body).toContain('name="captions"');
    expect(body).not.toContain('name="comments"');
    expect(clip.layers).toEqual({ captions: true });

    try {
      await goto(page, "/clips");
      const card = page.locator(
        `[data-testid="clip-card"][data-clip-id="${clip.id}"]`,
      );
      await card.click();
      const viewer = page.getByTestId("clip-viewer");
      const toggle = viewer.getByTestId("clip-layer-captions");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(viewer.getByTestId("clip-layer-comments")).toHaveCount(0);
      const image = viewer.getByTestId("clip-image");
      await expect(image).toHaveAttribute("src", /\?v=-1$/);

      // 外す。重ね直したら画像の版 (`?v=`) が替わる
      const patched = page.waitForResponse(
        (res) =>
          res.request().method() === "PATCH" &&
          new URL(res.url()).pathname.endsWith(`/api/clips/${clip.id}`),
      );
      await toggle.click();
      const res = await patched;
      expect(res.status()).toBe(200);
      expect(res.request().postDataJSON()).toEqual({ captions: false });
      expect(((await res.json()) as { layers: unknown }).layers).toEqual({
        captions: false,
      });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(image).toHaveAttribute("src", /\?v=-0$/);
      expect(
        (await request.get(`/api/clips/${clip.id}/image?v=-0`)).status(),
      ).toBe(200);

      // 読み直しても外したまま
      await page.reload();
      await card.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      // 戻す
      const again = page.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" &&
          new URL(r.url()).pathname.endsWith(`/api/clips/${clip.id}`),
      );
      await toggle.click();
      expect((await again).status()).toBe(200);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      const fresh = (await (
        await request.get(`/api/clips/${clip.id}`)
      ).json()) as { layers: unknown };
      expect(fresh.layers).toEqual({ captions: true });
      // 持っていない重ねは 400
      expect(
        (
          await request.patch(`/api/clips/${clip.id}`, {
            data: { comments: true },
          })
        ).status(),
      ).toBe(400);
    } finally {
      await request.delete(`/api/clips/${clip.id}`);
    }
  });

  /**
   * **スマホの幅では、絞り込みの1行を下のタブのすぐ上に浮かせ**、開いた1枚の右端の列は 48px の丸
   * (車のタブレットでも指が届く大きさ。観る画面の右の列と同じ)
   */
  test("スマホの幅の切り抜きの画面: 絞り込みは下のタブの上、開いた1枚の列は 48px", async ({
    browser,
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const tab = await context.newPage();
    await goto(tab, "/clips");
    // 合成の1枚 (端末の canvas で作った PNG) を API で置く
    const png = await tab.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3a6";
      ctx.fillRect(0, 0, 320, 180);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    const res = await request.post(
      `/api/clips?place=watch&recording=${id}&at=5`,
      {
        headers: { "content-type": "image/png" },
        data: Buffer.from(png, "base64"),
      },
    );
    expect(res.status()).toBe(201);
    const clip = (await res.json()) as { id: number };
    try {
      await goto(tab, "/clips");
      const bar = tab.getByTestId("clip-bar");
      await expect(bar).toBeVisible();
      await expect(tab.getByTestId("clip-side")).toBeHidden();
      const gap = await tab.evaluate(() => {
        const rect = (testid: string) =>
          document
            .querySelector(`[data-testid="${testid}"]`)!
            .getBoundingClientRect();
        return rect("tabbar").top - rect("clip-bar").bottom;
      });
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(16);

      await tab
        .locator(`[data-testid="clip-card"][data-clip-id="${clip.id}"]`)
        .click();
      const viewer = tab.getByTestId("clip-viewer");
      await expect(viewer).toBeVisible();
      for (const testid of [
        "clip-close",
        "clip-watch",
        "clip-save",
        "clip-delete",
      ]) {
        const box = (await viewer.getByTestId(testid).boundingBox())!;
        expect(Math.round(box.width), testid).toBe(48);
        expect(Math.round(box.height), testid).toBe(48);
      }
      // 削除はいちばん下
      const save = (await viewer.getByTestId("clip-save").boundingBox())!;
      const trash = (await viewer.getByTestId("clip-delete").boundingBox())!;
      expect(trash.y).toBeGreaterThan(save.y);
    } finally {
      await request.delete(`/api/clips?ids=${clip.id}`);
      await context.close();
    }
  });

  /** 残りは「あと何分で終わるか」。**倍速のぶんは割る** */
  test("残り時間も出て、倍速のぶんは割る", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    const clock = page.getByTestId("watch-clock");
    await expect(clock).toContainText("残り");
  });

  /** 早送りはライブの追っかけと同じ並び (`ts/pacing` の `SPEEDS`) */
  test("速さを選べる", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    // 等速のボタンはメーターのアイコンだけ (数字は出さない)。速めるとアイコンをやめて数字だけ、読み上げは速さも
    const speed = page.getByTestId("watch-speed");
    await expect(speed).toHaveText("");
    await expect(speed.locator("svg")).toHaveCount(1);
    await expect(speed).toHaveAccessibleName("再生の速さ");
    await expect(speed).toHaveAttribute("aria-pressed", "false");
    await speed.click();
    await page
      .getByTestId("watch-speed-option")
      .filter({ hasText: "×1.5" })
      .click();
    await expect(speed).toHaveText("1.5");
    await expect(speed.locator("svg")).toHaveCount(0);
    await expect(speed).toHaveAccessibleName("再生の速さ 1.5倍");
    await expect(speed).toHaveAttribute("aria-pressed", "true");
    // 選んだ速さは覚える。開き直しても同じ速さで始まる
    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-speed")).toHaveText("1.5");
    expect(
      await page
        .getByTestId("watch-video")
        .evaluate((v) => (v as HTMLVideoElement).playbackRate),
    ).toBe(1.5);
    // 読み直しても (src の入れ替えと同じ) 1 倍に戻る瞬間が無い。`loadstart` を待たずに見る
    expect(
      await page.getByTestId("watch-video").evaluate((v) => {
        const video = v as HTMLVideoElement;
        video.load();
        return video.playbackRate;
      }),
    ).toBe(1.5);
  });

  /**
   * **どこまで観たかを覚える。** 端末ではなく DB に置くので、別の端末でも続く。
   *
   * ここで見るのは「覚える・覚えない」の判断まで。**映像は出ません** —
   * 偽 ffmpeg が置くのは中身の無いファイルで、位置を戻すところまでは行けない
   * (戻す判断は `ts/watch.test.ts` が持っている)
   */
  test("途中で止めたところを覚え、観終えたら忘れる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    const put = async (at: number, length: number) => {
      const res = await request.post(`/api/recordings/${id}/resume`, {
        data: { at, length },
      });
      expect(res.ok()).toBe(true);
      return (await res.json()).resume;
    };

    const watchedAt = async () => {
      const list: { id: number; watchedAt: number | null }[] = await (
        await request.get("/api/recordings")
      ).json();
      return list.find((rec) => String(rec.id) === id)?.watchedAt;
    };

    expect(await put(600, 1800)).toBe(600);
    // 途中ではまだ観終えていない (一覧の「未視聴」は進捗バーに替わるだけ)
    expect(await watchedAt()).toBeNull();
    // 末尾まで観たものは忘れる。覚えるとエンドロールから始まってしまう
    expect(await put(1790, 1800)).toBeNull();
    // 代わりに観終えた時刻が入る (一覧の「未視聴」の印が外れる)
    expect(await watchedAt()).toEqual(expect.any(Number));

    // 詳細の「その他…」から未視聴に戻すと、一覧に点が戻る
    await goto(page, "/");
    const row = page.locator(
      `[data-testid="recording-row"][data-recording-id="${id}"]`,
    );
    await expect(row.getByTestId("recording-unwatched")).toHaveCount(0);
    await row.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    await detail.getByTestId("detail-more").click();
    await expect(detail.getByTestId("watched-button")).toHaveText(
      "未視聴に戻す",
    );
    await detail.getByTestId("watched-button").click();
    await expect(row.getByTestId("recording-unwatched")).toHaveCount(1);
    expect(await watchedAt()).toBeNull();
  });

  /**
   * **番組の中身は右に全部出す。モーダルにしない** — 映像の上に被さると
   * 観ながら読めない。長ければそこだけが巻き取られる
   */
  test("詳細は右に出たまま", async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-facts")).toBeVisible();
    // 押さなくても出ている。詳細のモーダルは開かない
    await expect(page.getByTestId("program-detail")).toHaveCount(0);
  });

  /**
   * **レイアウトはライブと同じ。** 映像が左、読むものが右で、右は**画面の残りをぜんぶ**
   * 使う。ページごとは動かない。
   *
   * 周りの余白を自分でも足していた頃は、外の `<main>` のぶんと重なって
   * **他の画面より内側から始まり**、足したぶんだけ縦がはみ出して
   * ページごとスクロールバーが出ていた。詳細の高さは**映像に揃えていた** —
   * そのためだけに `absolute` で浮かせる作りをここだけ抱えていたうえ、
   * 縦長の画面では下に余りがあるのに説明だけ狭い窓から覗くことになっていた
   */
  test("右は画面の残りをぜんぶ使い、ページごとは動かない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    await page.setViewportSize({ width: 1920, height: 960 });

    /*
     * **周りの余白は他の画面と同じ。** 外の `<main>` が持っているぶんだけで、
     * ここでは足さない・頭打ちにもしない。広い画面で中央に寄せていた頃は、
     * 左右だけ他より広かった
     */
    const edge = async (): Promise<number> =>
      page.evaluate(() => {
        const box = document.querySelector("main")?.firstElementChild;
        return Math.round(box?.getBoundingClientRect().left ?? -1);
      });
    // 比べる先は余白を持つふつうの画面 (ホームは一覧とサイドバーを端まで寄せるので使わない)
    await goto(page, "/live");
    const other = await edge();

    await goto(page, `/watch/${id}`);
    expect(await edge()).toBe(other);

    const box = await page.evaluate(() => {
      const stage = document
        .querySelector('[data-testid="watch-stage"]')
        ?.getBoundingClientRect();
      const aside = document.querySelector("aside")?.getBoundingClientRect();
      const board = document
        .querySelector("main")
        ?.firstElementChild?.getBoundingClientRect();
      const root = document.documentElement;
      return {
        横に並ぶ:
          stage !== undefined && aside !== undefined
            ? stage.right <= aside.left + 1
            : false,
        // 下まで使い切る。決め打ちで切っていた頃は、下に余白があるのに先に終わっていた
        余り:
          aside !== undefined && board !== undefined
            ? Math.round(board.bottom - aside.bottom)
            : -1,
        縦に動く: root.scrollHeight > root.clientHeight + 1,
        横に動く: root.scrollWidth > root.clientWidth,
      };
    });
    expect(box.横に並ぶ).toBe(true);
    expect(box.余り).toBeLessThanOrEqual(1);
    expect(box.縦に動く).toBe(false);
    expect(box.横に動く).toBe(false);
  });

  /**
   * **右端は「観る流れの外」の縦の列。** 閉じる・切り抜く・消すは、
   * 観ながら使う操作 (再生・音・字幕) とは押す頻度も並べる理由も違う。
   * **削除も映像の上** — タブレットは全画面で観るので、全画面から出ずに消せるように。データ放送 (d) は ⚙ の中。
   *
   * 1つの操作バーに混ぜていた頃は押すものが12個並び、**番組の名前が入る幅が
   * 残らなかった** — 実機のタブレットで名前が折り返し、操作バーが二段になっていた。
   * **列は縦に積む** — 車に付けたタブレットでは右の縁がいちばん指が届く (横一行・40px にして戻した)
   */
  test("閉じる・切り抜き・削除は右端の縦の列。下の操作バーは一段のまま", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);

    // 縦のタブレット (1000px 未満) では映像を端から端まで出し、番組の中身はその下に積む
    await page.setViewportSize({ width: 820, height: 1180 });
    await goto(page, `/watch/${id}`);
    await expect
      .poll(async () => {
        const video = (await page.getByTestId("watch-stage").boundingBox())!;
        const facts = (await page.getByTestId("watch-facts").boundingBox())!;
        return {
          left: Math.round(video.x),
          width: Math.round(video.width),
          below: facts.y >= video.y + video.height - 1,
        };
      })
      .toEqual({ left: 0, width: 820, below: true });

    // 二段組 (1000px から) では、映像の上端と右の列の最初のもの (番組名) の上端がそろう
    await page.setViewportSize({ width: 1024, height: 768 });
    await expectSideAligned(
      page,
      '[data-testid="watch-video"]',
      '[data-testid="watch-facts"] > :first-child',
    );
    // 映像の左・映像から番組名まで・番組名の右の余白が同じ
    await expectSideFrame(
      page,
      '[data-testid="watch-video"]',
      '[data-testid="watch-facts"] h3',
    );

    const side = page.getByTestId("watch-side");
    for (const testid of ["watch-close", "watch-shot", "watch-delete"]) {
      expect(await side.getByTestId(testid).count()).toBe(1);
      // 下の操作バーには無い。同じことをするボタンを2つ置かない
      expect(
        await page.getByTestId("watch-controls").getByTestId(testid).count(),
      ).toBe(0);
    }
    // 閉じるはいちばん上。ライブ・追っかけと同じ並び
    const top = await side.evaluate(
      (el) => (el.firstElementChild as HTMLElement).dataset["testid"],
    );
    expect(top).toBe("watch-close");
    // 縦に積む (横一行にしない)。丸は 48px で、間は 8px
    const close = (await page.getByTestId("watch-close").boundingBox())!;
    const shot = (await page.getByTestId("watch-shot").boundingBox())!;
    expect(shot.y).toBeGreaterThan(close.y + close.height - 1);
    expect(Math.abs(shot.x - close.x)).toBeLessThan(2);
    expect(Math.round(close.width)).toBe(48);
    expect(Math.round(shot.y - (close.y + close.height))).toBe(8);
    // データ放送 (d) は映像の上の列に置かない (⚙ の中)
    expect(await side.getByTestId("watch-data").count()).toBe(0);
    /*
     * **押すだけのボタンは「切り替え」と名乗らない** (`aria-pressed` は切り替えにだけ)。
     * アイコンだけのボタンなので、マウスを重ねたときに名前が出る (`title`)
     */
    for (const testid of [
      "watch-close",
      "watch-shot",
      "watch-delete",
      "watch-play",
      "watch-full",
      "watch-settings",
    ]) {
      const button = page.getByTestId(testid);
      expect(await button.getAttribute("aria-pressed"), testid).toBeNull();
      expect(await button.getAttribute("title"), testid).toBe(
        await button.getAttribute("aria-label"),
      );
    }
    await expect(page.getByTestId("watch-background")).toHaveAttribute(
      "aria-checked",
      /^(true|false)$/,
    );
    await expect(page.getByTestId("watch-background")).toHaveAttribute(
      "role",
      "menuitemcheckbox",
    );
    // 再生停止は下の操作バーのいちばん左。ライブと同じ並び
    await expect(
      page.getByTestId("watch-controls").getByTestId("watch-play"),
    ).toBeVisible();
    // 小窓 (PiP) も下の操作バー。並べても一段に収まる (下で見る)
    await expect(
      page.getByTestId("watch-controls").getByTestId("watch-pip"),
    ).toBeVisible();

    /*
     * **読むものが長くても操作バーを割らない。** 折り返すかは中身の幅で決まるので、
     * 縮む指定 (`truncate`) だけでは、縮む前に行が分かれてしまう
     */
    const rowHeight = async (): Promise<number> =>
      page.evaluate(() =>
        Math.round(
          document
            .querySelector('[data-testid="watch-buttons"]')
            ?.getBoundingClientRect().height ?? -1,
        ),
      );
    const before = await rowHeight();
    // 押すものは一段に収まる (`btn-lg` = 48px。折れると倍になる)
    expect(before).toBeLessThan(60);
    await page
      .getByTestId("watch-clock")
      .evaluate((el) => (el.textContent = "あ".repeat(200)));
    expect(await rowHeight()).toBe(before);
  });

  /*
   * **バックグラウンド再生は既定で切。** 裏に回すと止め、戻ると止めた所から再開する。
   * OS が勝手に小窓にしないよう `disablePictureInPicture` も立てる (`background.svelte.ts`)。
   *
   * 偽 ffmpeg の録画は映像が出ない (上) ので、`<video>` の止める・再開を差し替えて、
   * 呼ばれたかだけを見る。裏に回るのは `visibilityState` を差し替えて通知を送る
   */
  test("バックグラウンド再生は既定で切。裏に回すと止まり、入れると止まらない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);

    const video = page.getByTestId("watch-video");
    await expect
      .poll(() =>
        video.evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture),
      )
      .toBe(true);
    // 再生中のふり。止める・再開は印を動かすだけ
    await video.evaluate((v) => {
      const media = v as HTMLVideoElement & { fake: boolean };
      media.fake = false;
      Object.defineProperty(media, "paused", {
        configurable: true,
        get: () => media.fake,
      });
      media.pause = () => {
        media.fake = true;
      };
      media.play = async () => {
        media.fake = false;
      };
    });
    const paused = () => video.evaluate((v) => (v as HTMLVideoElement).paused);
    const turn = (state: "hidden" | "visible") =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => state,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);

    await turn("hidden");
    expect(await paused()).toBe(true);
    await turn("visible");
    expect(await paused()).toBe(false);

    await wakeControls(page, "watch-stage");
    const toggle = page.getByTestId("watch-background");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await flipSetting(page, "watch", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() =>
        video.evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture),
      )
      .toBe(false);
    await turn("hidden");
    expect(await paused()).toBe(false);
    await turn("visible");
  });

  /** 無い録画を開いても、黙って空の画面を出さない */
  test("無い録画は 404", async ({ request }) => {
    const res = await request.get("/watch/999999");
    expect(res.status()).toBe(404);
  });
});

/**
 * **スマホの縦で、全画面をやめて観る。** 枠は 390x219 (画面の端から端まで、ちょうど 16:9。
 * 余白の内側に置いていた頃は 358x224)。
 *
 * 48px の押すものを全部並べていた頃は、操作バーが折れて映像を覆い、右の縦列 (閉じる・
 * 切り抜き・削除) がシークバーや再生ボタンに重なっていた (実機の報告)。狭い枠では
 * 40px に縮め、毎回は使わないもの (速さなど) を再生の設定 (⚙) に畳む (`PlayerStage`)
 */
test.describe("スマホの縦で観る", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("押すものは 40px 以上で重ならず、速さは ⚙ に畳まれる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);
    // 指の端末は開いた時点で全画面に入る。やめたところを見る
    await page.evaluate(
      () => document.fullscreenElement && document.exitFullscreen(),
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);

    const stage = page.getByTestId("watch-stage");
    await expect(stage).toHaveAttribute("data-compact", "");
    // 出ていなければ押して出す (開いた直後は出ている。2.5 秒で引っ込む)
    const bar = page.getByTestId("watch-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      const box = (await stage.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");

    const shape = await page.evaluate(() => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const shown = (el: Element) => rect(el).width > 0;
      const side = [
        ...document.querySelectorAll('[data-testid="watch-side"] .ov-btn'),
      ].filter(shown);
      const bottom = [
        ...document.querySelectorAll(
          '[data-testid="watch-controls"] .ov-btn, [data-testid="watch-controls"] input',
        ),
      ].filter(shown);
      const sideBottom = Math.max(...side.map((el) => rect(el).bottom));
      const barTop = Math.min(...bottom.map((el) => rect(el).top));
      const buttons = [...side, ...bottom].filter((el) =>
        el.classList.contains("ov-btn"),
      );
      const stage = rect(
        document.querySelector('[data-testid="watch-stage"]') as Element,
      );
      return {
        右の列は操作バーより上: sideBottom <= barTop,
        いちばん小さい: Math.min(
          ...buttons.map((el) => Math.min(rect(el).width, rect(el).height)),
        ),
        枠からはみ出す: buttons.some(
          (el) => rect(el).left < stage.left || rect(el).right > stage.right,
        ),
        横に動く:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        枠: { left: Math.round(stage.left), width: Math.round(stage.width) },
      };
    });
    expect(shape.右の列は操作バーより上).toBe(true);
    expect(shape.いちばん小さい).toBeGreaterThanOrEqual(40);
    expect(shape.枠からはみ出す).toBe(false);
    expect(shape.横に動く).toBe(false);
    // **映像は画面の端から端まで** (余白の内側に置くと 358px に縮み、周りに縁が出る)
    expect(shape.枠).toEqual({ left: 0, width: 390 });
    // **上も空けない。** 本文の上の端 (この画面は見出しを出すので、その下の端) から映像が始まる
    const gap = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const content =
        main.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(main).paddingTop);
      return (
        document
          .querySelector('[data-testid="watch-stage"]')!
          .getBoundingClientRect().top - content
      );
    });
    expect(Math.round(gap)).toBe(0);
    /*
     * **枠はちょうど映像の形 (16:9) で、操作バーは映像に重ねる** (`PlayerStage` の `narrow`)。
     * 以前は映像の下に段を足して操作バーを出しっぱなしにしていたが、枠が映像より高くなり、
     * 映像の下に操作バーの段がいつも残って見えた。いまは触らなければ引っ込む。字幕の面も映像の中に収まる
     */
    await expect(stage).toHaveAttribute("data-narrow", "");
    const frame = (await stage.boundingBox())!;
    const picture = (await page.getByTestId("watch-video").boundingBox())!;
    const strip = (await bar.boundingBox())!;
    expect(Math.round(frame.height)).toBe(Math.round((390 * 9) / 16));
    expect(Math.round(picture.height)).toBe(Math.round((390 * 9) / 16));
    expect(strip.y + strip.height).toBeLessThanOrEqual(
      frame.y + frame.height + 1,
    );

    const captions = (await page
      .getByTestId("watch-captions-canvas")
      .boundingBox())!;
    expect(captions.y + captions.height).toBeLessThanOrEqual(
      picture.y + picture.height + 1,
    );
    // 押すものは一段 (40px)。折れると倍になる
    const row = await page.getByTestId("watch-play").boundingBox();
    const full = await page.getByTestId("watch-full").boundingBox();
    expect(Math.abs((row?.y ?? 0) - (full?.y ?? -100))).toBeLessThan(2);

    // 速さは畳まれていて、⚙ の頭の「再生の速さ」の行から選ぶ
    await expect(page.getByTestId("watch-speed")).toBeHidden();
    // 操作バーは引っ込んでいることがある (映像に重ねるので)。起こしてから押す
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-settings").tap();
    const pace = page.getByTestId("watch-pace");
    await expect(pace).toContainText("×1");
    await pace.tap();
    // メニューは枠の中に収まる (見出しの裏に潜らない)
    const menu = page.getByTestId("watch-settings-menu");
    await expect(menu).toBeVisible();
    const inside = await page.evaluate(() => {
      const menu = document
        .querySelector('[data-testid="watch-settings-menu"]')
        ?.getBoundingClientRect();
      const stage = document
        .querySelector('[data-testid="watch-stage"]')
        ?.getBoundingClientRect();
      return (
        menu !== undefined &&
        stage !== undefined &&
        menu.top >= stage.top - 1 &&
        menu.bottom <= stage.bottom + 1
      );
    });
    expect(inside).toBe(true);
    await page
      .locator('[data-testid="watch-pace-option"][data-pace="1.5"]')
      .tap();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("watch-pace")).toContainText("×1.5");
    // 操作バーの速さのボタン (畳まれている) にも同じ値が出る
    await expect(page.getByTestId("watch-speed")).toHaveText("1.5");

    // 映像に重ねるので、放っておけば引っ込む (ほかの枠と同じ)。押せばまた出る
    await expect(bar).toHaveAttribute("data-shown", "false", { timeout: 6000 });
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0");
    const again = (await stage.boundingBox())!;
    await page.touchscreen.tap(
      again.x + again.width / 2,
      again.y + again.height / 2,
    );
    await expect(bar).toHaveAttribute("data-shown", "true");
  });

  /*
   * **いちばん狭いスマホ (360px・320px) でも、操作バーのボタンは1行。** 折り返していた頃は、
   * 時刻が押すものの上に一行を取って操作バーが二段になっていた。残すのは再生・チャプター送り・
   * 時刻・⚙・全画面だけで、時刻は短い形 (残りを省く)。畳んだもの (音など) は ⚙ の頭の行から押せる
   */
  test("幅 360px・320px でも操作バーのボタンは1行で、畳んだ音は ⚙ から押せる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 780 });
      await goto(page, `/watch/${id}`);
      await leaveFullscreen(page);
      await expect(page.getByTestId("watch-stage")).toHaveAttribute(
        "data-narrow",
        "",
      );
      await expect(page.getByTestId("watch-play")).toBeVisible();

      expect(await oneRowTroubles(page, "watch-buttons"), `${width}px`).toEqual(
        [],
      );
      await expect(page.getByTestId("watch-full")).toBeVisible();
      await expect(page.getByTestId("watch-clock")).toBeVisible();
      await expect(
        page.getByTestId("watch-clock").locator(".long"),
      ).toBeHidden();
      await page.screenshot({
        path: test.info().outputPath(`watch-${width}.png`),
      });

      // 畳んだ音は ⚙ の頭の「消音」の行。「ほか」(⋯) のボタンはもう無い
      const sound = page.getByTestId("watch-sound");
      await expect(sound).toBeHidden();
      await expect(page.getByTestId("watch-more")).toHaveCount(0);
      const label = (await sound.getAttribute("aria-label")) ?? "";
      // 操作バーは引っ込んでいることがある (映像に重ねるので)。起こしてから押す
      await wakeControls(page, "watch-stage");
      await page.getByTestId("watch-settings").tap();
      const mute = page.getByTestId("watch-mute");
      await expect(mute).toBeVisible();
      await expect(mute).toHaveAttribute("role", "menuitemcheckbox");
      const muted = (await mute.getAttribute("aria-checked")) ?? "";
      await mute.tap();
      await expect(mute).not.toHaveAttribute("aria-checked", muted);
      await expect(sound).not.toHaveAttribute("aria-label", label);
      await page.screenshot({
        path: test.info().outputPath(`watch-${width}-more.png`),
      });

      // 閉じても1行のまま
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("watch-settings-menu")).toBeHidden();
      expect(
        await oneRowTroubles(page, "watch-buttons"),
        `${width}px (閉じたあと)`,
      ).toEqual([]);
    }
  });
});

/**
 * **横にしたスマホでは映像を画面いっぱいに** (`PlayerLayout`)。見出しと右の列を残すと
 * 映像の枠が 510x280 ほどしか無く、操作バーが二段に折れてシークバーが映像の真ん中に来ていた
 */
test.describe("スマホの横で観る", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });

  test("見出しを隠して映像が画面の高さいっぱい。操作バーは一段で下端に、右の列は下へ", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);
    // 指の端末は開いた時点で全画面に入る。やめたところを見る
    await page.evaluate(
      () => document.fullscreenElement && document.exitFullscreen(),
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);

    const stage = page.getByTestId("watch-stage");
    await expect(stage).not.toHaveAttribute("data-pseudo", "");
    await expect(page.locator(".navbar")).toBeHidden();
    // 枠は映像の形 (16:9) で、高さいっぱい・真ん中。左右の黒帯にボタンを出さない
    await expect
      .poll(async () => roundBox(await stage.boundingBox()))
      .toEqual({ x: 75, y: 0, width: 693, height: 390 });

    const bar = page.getByTestId("watch-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      await page.touchscreen.tap(422, 195);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");
    // 押すものは一段
    const play = (await page.getByTestId("watch-play").boundingBox())!;
    const full = (await page.getByTestId("watch-full").boundingBox())!;
    expect(Math.abs(play.y - full.y)).toBeLessThan(2);
    // シークバーは映像の下の方 (真ん中に来ると、映像を押したつもりで位置が飛ぶ)
    const seek = (await bar.getByRole("slider").boundingBox())!;
    expect(seek.y).toBeGreaterThan(390 * 0.6);
    // どのボタンも重ならず、映像の枠の中に丸ごと見える (右上の3つも)
    expect(await overlayTroubles(page, "watch-stage")).toEqual([]);
    // 操作バーは映像に重ねるので、下の方の字幕は操作バーの上まで持ち上がる
    await captionsClearOfBar(page, "watch-captions-canvas", "watch-controls");

    // 右の列 (番組の中身) は消さずに映像の下へ。巻き取れば読める
    const facts = page.getByTestId("watch-facts");
    await facts.scrollIntoViewIfNeeded();
    await expect(facts).toBeInViewport();
    // ページごとは横に動かない
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= 844),
    ).toBe(true);
  });
});

/**
 * **指で。** マウスと指では操作列の出し方が違い (`controls.svelte.ts`)、メニューの
 * 開け方も pointer の種類で違いが出やすい (Bits UI を使っていた頃は分けていた) ので、指の経路を別に見る
 */
test.describe("指で観る", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1024, height: 768 },
  });

  /*
   * **押したメニューが開いたまま残り、操作列も引っ込まない。** 実機のタブレットで、
   * 速さを押した瞬間にメニューが閉じていた。開いている間は操作列の 2.5 秒の
   * 時計 (`LINGER`) も止める — メニューは操作列の中にあるので、操作列が消えれば
   * 選んでいる最中でもメニューごと消える
   */
  test("速さのボタンを押すと開いたまま残り、選ぶまで操作列も消えない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, `/watch/${id}`);

    /*
     * 指は映像を1回押して操作列を出す (マウスのように動かしただけでは出ない)。
     * 開いた直後は出ていて、そこで押すと引っ込む (出し入れなので)。消えるまで待ってから押す
     */
    const bar = page.getByTestId("watch-controls");
    await expect(bar).toHaveAttribute("data-shown", "false");
    const stage = (await page.getByTestId("watch-stage").boundingBox())!;
    await page.touchscreen.tap(
      stage.x + stage.width / 2,
      stage.y + stage.height / 2,
    );
    await expect(bar).toHaveAttribute("data-shown", "true");

    await page.getByTestId("watch-speed").tap();
    const menu = page.getByTestId("watch-speed-menu");
    await expect(menu).toBeVisible();
    // 触らずに時計のぶんより長く待っても、開いている間は残る
    await page.waitForTimeout(3500);
    await expect(menu).toBeVisible();
    await expect(bar).toHaveAttribute("data-shown", "true");

    // 選べば閉じて、そこから時計が動き出す
    await page
      .getByTestId("watch-speed-option")
      .filter({ hasText: "×1.5" })
      .tap();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("watch-speed")).toHaveText("1.5");
    await expect(bar).toHaveAttribute("data-shown", "false", { timeout: 5000 });
  });
});

/**
 * **iPhone の全画面は、枠を画面いっぱいに広げて代わりにする** (#471。`fullscreen.svelte.ts`)。
 *
 * iPhone の Safari は要素の全画面 (`requestFullscreen` / `webkitRequestFullscreen`) を
 * 持たない。API を消して iPhone の横持ち (844x390) に見立てる。指の端末は開いた時点で
 * 全画面に入るので、開いたら広がっていること。出口は同じボタン・Esc・戻る
 */
test.describe("iPhone で全画面", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });

  test("開くと枠が画面いっぱいに広がり、重ねものも付いてくる。ボタン・Esc・戻るで出る", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.addInitScript(() => {
      for (const proto of [Element.prototype, HTMLElement.prototype]) {
        delete (proto as Partial<Element>).requestFullscreen;
        delete (proto as { webkitRequestFullscreen?: unknown })
          .webkitRequestFullscreen;
      }
    });
    await goto(page, `/watch/${id}`);

    const stage = page.getByTestId("watch-stage");
    const full = page.getByTestId("watch-full");
    const covers = async () => {
      await expect(stage).toHaveAttribute("data-pseudo", "");
      await expect
        .poll(() => stage.boundingBox())
        .toEqual({ x: 0, y: 0, width: 844, height: 390 });
      // 後ろのページは止める
      await expect(page.locator("html")).toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面をやめる");
    };
    const restored = async () => {
      await expect(stage).not.toHaveAttribute("data-pseudo", "");
      // 横にしたスマホは全画面でなくても枠が画面の高さいっぱい (`PlayerLayout`)。大きさでは見分けない
      await expect
        .poll(() => stage.evaluate((el) => getComputedStyle(el).position))
        .not.toBe("fixed");
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面");
      await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));
    };
    const showControls = async () => {
      const bar = page.getByTestId("watch-controls");
      if ((await bar.getAttribute("data-shown")) !== "true") {
        const box = (await stage.boundingBox())!;
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
      }
      await expect(bar).toHaveAttribute("data-shown", "true");
    };

    // 開いた時点で広がっている。本物の全画面には入っていない
    await covers();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

    // 字幕の面は映像に、映像は枠に重なる。操作列は画面の中
    await showControls();
    const layout = await page.evaluate(() => {
      const rect = (id: string) => {
        const r = document
          .querySelector(`[data-testid="${id}"]`)!
          .getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      return {
        video: rect("watch-video"),
        captions: rect("watch-captions-canvas"),
        bar: rect("watch-controls"),
      };
    });
    expect(layout.video).toEqual({ x: 0, y: 0, w: 844, h: 390 });
    expect(layout.captions).toEqual(layout.video);
    expect(layout.bar.y + layout.bar.h).toBeLessThanOrEqual(390);

    // 同じボタンで出る
    await full.tap();
    await restored();

    // もう一度入って、Esc で出る
    await showControls();
    await full.tap();
    await covers();
    await page.keyboard.press("Escape");
    await restored();

    // もう一度入って、戻るで出る。画面は離れない
    await showControls();
    await full.tap();
    await covers();
    await page.evaluate(() => history.back());
    await restored();
  });
});

function roundBox(
  box: { x: number; y: number; width: number; height: number } | null,
) {
  return box === null
    ? null
    : {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
}

/**
 * **字幕は、見えている大きさ × 画面の画素で描く** (`caption-draw.ts` の `CaptionPainter`)。
 *
 * 実機で「字幕がぼやぁっとしている」— データ放送を出した観る画面で、小窓に入った字幕が
 * 拡大した画像のように滲んでいた。当時は BML の面 (960x540) を原寸で組んで枠いっぱいに
 * `transform: scale` で伸ばすのに、字幕は CSS の大きさ (面の上の 480x270) の画素で描いていた。
 * いまは面ごと伸ばさないが、CSS の大きさは整数に丸めてあるので、見えている大きさで描くのは変わらない。
 * 偽の録画は中身が無いので、字幕は `captions.json` を差し替えて 0 秒に1枚置く
 */
test.describe("字幕をくっきり描く", () => {
  test("PC (DPR 1・2) とスマホで、字幕の画素が見えている大きさ × DPR と合う", async ({
    browser,
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const id = await watchable(page, request);
    for (const [what, options] of CAPTION_SCREENS) {
      const context = await browser.newContext(options);
      const tab = await context.newPage();
      await routeCaptions(tab);
      await goto(tab, `/watch/${id}`);
      await holdCaptions(tab, "watch-captions-canvas");
      await expectSharpCaptions(tab, what);
      await context.close();
    }
  });
});
