import { readFileSync } from "node:fs";

import {
  CAPTION_SCREENS,
  expect,
  expectSharpCaptions,
  FAKE_CAPTION,
  fakeFrame,
  flipSetting,
  goto,
  holdCaptions,
  openSettings,
  routeCaptions,
  takeClip,
  test,
  wakeControls,
} from "./helpers";
import { putClip, sharedRecording } from "./watch";

/**
 * 録画をブラウザで観る画面 (`/watch/<id>`) のうち、シークバーをつまむ操作、字幕、ショートカット、切り抜き。
 *
 * 22-watch から分けた (1 本で 1 分を超えていた)。映像が出るところまでは見ない
 * (偽 ffmpeg が置くのは中身の無いファイルで、ブラウザは読めない)。見るのは画面の作りのほう
 */

/** どのテストも録画を消さないので、**1 本の録画を使い回す** (`sharedRecording`) */
const watchable = sharedRecording();

test.describe("録画を観る", () => {
  /**
   * **つまんで動かす間、つまみは指にそのまま付いてくる** (`SeekBar`)。タブレットで、動かすたびに
   * 飛んでいた頃はつまみが指から遅れていた。飛ぶのは下見を 1 度に 1 つまで (飛び終わってから次) と、
   * 離したときの 1 回。動かしている間に届く位置ではつまみを戻さず、CM も飛ばさない。
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
    // 21 回動かしても、下見は飛び終わりを待つ (着かなければ 1 秒) ので、押したときの 1 つと多くて 1 つ
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

    // 離すと、その位置へちゃんと 1 回飛ぶ。つまみはそこにある
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
    // オンの線は 1 本。ほかの所と同じ「入っている切り替え」の短い下線で、自前の線は重ねない
    await expect(button).not.toHaveCSS("background-image", "none");
    expect(
      await button.evaluate((el) => getComputedStyle(el, "::after").content),
    ).toBe("none");
    await wakeControls(page, "watch-stage");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });

  /*
   * **字幕の言語を再生の設定 (⚙) で選ぶ。** 字幕 1 本に英語も載っている録画 (`captions.json` の `others`)。
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
   * **字幕を待たずに観はじめる。** サーバは字幕を作るのに動画を丸ごと読む (初回は 1 時間の録画で 1 秒ほど)。
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

    // コピー (Ctrl / Cmd) は素通し。字幕は出たまま。**1 回ずつ見る** (2 回で元に戻ると見逃す)
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
   * **切り抜きの画面** (`/clips`)。撮った 1 枚が番組名つきで並び、言葉で絞れ、開いて「この場面から観る」で
   * 録画のその位置へ行ける。2 回押しで消すと画像も 404。入口は広い形のヘッダー・観る画面の右の列・検索の結果
   */
  test("切り抜きの画面で探して開き、この場面から観られ、2 回押しで消せる", async ({
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

    // 検索の結果に切り抜きの節。「切り抜きの画面で見る」で同じ言葉のまま切り抜きの画面へ。
    // 切り抜きの画面に言葉の欄は無く、探した言葉と外すボタンを出す
    await goto(page, `/search?q=${encodeURIComponent(clip.programName)}`);
    await expect(page.getByTestId("search-clips")).toBeVisible();
    await expect(page.getByTestId("search-clip").first()).toBeVisible();
    await page.getByTestId("search-clips-all").click();
    await expect(page).toHaveURL(/\/clips\?q=/);
    const card = page.locator(
      `[data-testid="clip-card"][data-clip-id="${clip.id}"]`,
    );
    await expect(card.getByTestId("clip-name")).toHaveText(clip.programName);
    await expect(page.getByTestId("clip-query")).toContainText(
      clip.programName,
    );
    await expect(page.locator('[data-testid="clips"] input')).toHaveCount(0);
    await page.getByTestId("clip-query-clear").click();
    await expect(page).toHaveURL(/\/clips$/);
    await expect(page.getByTestId("clip-query")).toHaveCount(0);

    // 当たらない言葉なら「当てはまるものはありません」
    await goto(page, `/clips?q=${encodeURIComponent("どこにも無い言葉")}`);
    await expect(card).toHaveCount(0);
    await expect(page.getByText("当てはまるものはありません")).toBeVisible();

    // 広い形のヘッダーから開く
    await page.getByTestId("nav-clips").click();
    await expect(page).toHaveURL(/\/clips$/);
    await expect(card).toBeVisible();

    // 開くと一覧の上に浮かぶ箱。「この場面から観る」で録画のその位置へ
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

    // 2 回押しで消える。画像も 404
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
   * **字幕はあとから出し入れできる。** 字幕を出して撮ると、映像と字幕を分けて送り (multipart)、字幕が重なった 1 枚で並ぶ。
   * 開いた 1 枚は元の画像を重ねて見せ、「字幕」で外す・戻すと**サーバの返事を待たずに**字幕の 1 枚を隠す・出す。
   * 残すのは `PATCH /api/clips/<id>` (一覧の画像を元から重ね直す) で、読み直しても続く。
   * 撮ったときに無かったもの (コメント) の切り替えは出さない
   */
  test("切り抜きの字幕を開いた 1 枚で外し、戻せる", async ({
    page,
    request,
  }) => {
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
      // 映像と字幕の元の画像を重ねる。持っていない重ねは 404
      await expect(viewer.getByTestId("clip-image")).toHaveAttribute(
        "src",
        new RegExp(`/api/clips/${clip.id}/layer/frame$`),
      );
      const layer = viewer.getByTestId("clip-layer-image-captions");
      await expect(layer).toBeVisible();
      // 重ねる箱は映像の形で、舞台に収まる
      const box = (await viewer.getByTestId("clip-layers").boundingBox())!;
      const stage = (await viewer.locator(".v-stage").boundingBox())!;
      const ratio = await viewer
        .getByTestId("clip-image")
        .evaluate(async (img: HTMLImageElement) => {
          await img.decode();
          return img.naturalWidth / img.naturalHeight;
        });
      expect(box.width / box.height).toBeCloseTo(ratio, 1);
      expect(box.width).toBeLessThanOrEqual(stage.width + 1);
      expect(box.height).toBeLessThanOrEqual(stage.height + 1);
      expect(
        Math.max(box.width / stage.width, box.height / stage.height),
      ).toBeGreaterThan(0.99);
      await expect(viewer.getByTestId("clip-layer-image-comments")).toHaveCount(
        0,
      );
      expect(
        (await request.get(`/api/clips/${clip.id}/layer/captions`)).status(),
      ).toBe(200);
      expect(
        (await request.get(`/api/clips/${clip.id}/layer/comments`)).status(),
      ).toBe(404);
      const thumb = card.locator("img.c-thumb");
      await expect(thumb).toHaveAttribute("src", /\?v=-1$/);

      // 外す。返事を止めておいても、字幕はすぐ消える
      let release = () => {};
      const held = new Promise<void>((done) => (release = done));
      await page.route(`**/api/clips/${clip.id}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        await held;
        await route.fallback();
      });
      const patched = page.waitForResponse(
        (res) =>
          res.request().method() === "PATCH" &&
          new URL(res.url()).pathname.endsWith(`/api/clips/${clip.id}`),
      );
      const sent = page.waitForRequest(
        (req) =>
          req.method() === "PATCH" &&
          new URL(req.url()).pathname.endsWith(`/api/clips/${clip.id}`),
      );
      await toggle.click();
      expect((await sent).postDataJSON()).toEqual({ captions: false });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(layer).toBeHidden();
      await expect(viewer.getByTestId("clip-image")).toBeVisible();
      release();
      const res = await patched;
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { layers: unknown }).layers).toEqual({
        captions: false,
      });
      await page.unroute(`**/api/clips/${clip.id}`);
      // 残ったら一覧の画像も重ね直したものに替わる
      await expect(thumb).toHaveAttribute("src", /\?v=-0$/);
      await expect(layer).toBeHidden();

      // 読み直しても外したまま
      await page.reload();
      await card.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(layer).toBeHidden();

      // 戻す
      const again = page.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" &&
          new URL(r.url()).pathname.endsWith(`/api/clips/${clip.id}`),
      );
      await toggle.click();
      expect((await again).status()).toBe(200);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(layer).toBeVisible();
      await expect(thumb).toHaveAttribute("src", /\?v=-1$/);

      // 断られたら切り替えを戻して知らせる
      await page.route(`**/api/clips/${clip.id}`, (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 500 })
          : route.fallback(),
      );
      await toggle.click();
      await expect(
        page.locator(".toast", { hasText: "切り替えられませんでした" }),
      ).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(layer).toBeVisible();
      await page.unroute(`**/api/clips/${clip.id}`);
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
   * **開いた 1 枚はクリップボードに PNG でコピーできる。** サーバの AVIF を端末で PNG にし直して置く
   * (クリップボードに置けるのは PNG だけ)。うまくいったらトーストは出さない (ボタンが一瞬チェックになるだけ)
   */
  test("切り抜きの開いた 1 枚をクリップボードに PNG でコピーできる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await goto(page, "/clips");
    const clip = await putClip(page, request, id, 8);
    try {
      await goto(page, "/clips");
      await page
        .locator(`[data-testid="clip-card"][data-clip-id="${clip}"]`)
        .click();
      const viewer = page.getByTestId("clip-viewer");
      const copy = viewer.getByTestId("clip-copy");
      await expect(copy).toHaveAttribute(
        "aria-label",
        "クリップボードにコピー",
      );
      const { width, height } = (await (
        await request.get(`/api/clips/${clip}`)
      ).json()) as { width: number; height: number };
      await page.evaluate(() => navigator.clipboard.writeText(""));
      await copy.click();
      // 置かれたのは PNG で、切り抜きと同じ縦横
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const item = items.find((i) => i.types.includes("image/png"));
            if (item === undefined) return null;
            const bitmap = await createImageBitmap(
              await item.getType("image/png"),
            );
            return `${bitmap.width}x${bitmap.height}`;
          }),
        )
        .toBe(`${width}x${height}`);
      await expect(page.locator(".toast")).toHaveCount(0);
    } finally {
      await request.delete(`/api/clips?ids=${clip}`);
    }
  });

  /**
   * **スマホの幅では、絞り込みを下のタブのすぐ上に浮かせ**、開いた 1 枚の右端の列は 48px の丸
   * (車のタブレットでも指が届く大きさ。観る画面の右の列と同じ)。
   * 指の端末には乗せる操作が無いので、長押しで選ぶ形に入り、下の 1 行が選んだぶんの操作に替わる
   */
  test("スマホの幅の切り抜きの画面: 絞り込みは下のタブの上、開いた 1 枚の列は 48px、長押しで選ぶ", async ({
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
    const clip = { id: await putClip(tab, request, id, 5) };
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

      const card = tab.locator(
        `[data-testid="clip-card"][data-clip-id="${clip.id}"]`,
      );
      await card.click();
      const viewer = tab.getByTestId("clip-viewer");
      await expect(viewer).toBeVisible();
      for (const testid of [
        "clip-close",
        "clip-watch",
        "clip-copy",
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
      await viewer.getByTestId("clip-close").click();
      await expect(viewer).toBeHidden();

      // 長押しで選ぶ形に入る。指を離したときの押しでは開かない
      const check = tab.locator(
        `li:has([data-clip-id="${clip.id}"]) [data-testid="clip-check"]`,
      );
      await expect(check).toHaveCSS("opacity", "0");
      const box = (await card.boundingBox())!;
      const at = { clientX: box.x + 40, clientY: box.y + 40 };
      await card.dispatchEvent("pointerdown", { pointerType: "touch", ...at });
      await tab.waitForTimeout(700);
      await card.dispatchEvent("pointerup", { pointerType: "touch", ...at });
      await card.dispatchEvent("click", at);
      await expect(viewer).toBeHidden();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      await expect(check).toHaveAttribute("aria-pressed", "true");
      await expect(bar.getByTestId("clip-picked")).toHaveText("1 枚を選択中");
      await expect(bar.getByTestId("clip-filter")).toHaveCount(0);

      // いまは選ぶ形なので、押せば外れて抜ける
      await card.click();
      await expect(bar.getByTestId("clip-picked")).toHaveCount(0);
      // 指が動いた (巻いた) ら長押しにしない
      await card.dispatchEvent("pointerdown", { pointerType: "touch", ...at });
      await card.dispatchEvent("pointermove", {
        pointerType: "touch",
        clientX: at.clientX,
        clientY: at.clientY + 40,
      });
      await tab.waitForTimeout(700);
      await card.dispatchEvent("pointercancel", { pointerType: "touch" });
      await expect(bar.getByTestId("clip-picked")).toHaveCount(0);
      await expect(bar.getByTestId("clip-filter")).toBeVisible();
    } finally {
      await request.delete(`/api/clips?ids=${clip.id}`);
      await context.close();
    }
  });

  /**
   * **選び方は写真のサービスと同じ。** マウスで乗せると 1 枚の左上に丸が出て、押すと選ぶ形に入る。
   * 選ぶ形の間は 1 枚を押すと選ぶ・外す (開かない)、Shift でまとめて選び、2 回押しでまとめて消す。
   * Esc で抜けると、押せばまた開く
   */
  test("切り抜きは乗せて出る丸で選び、Shift でまとめて選び、まとめて消せる。Esc で抜ける", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await goto(page, "/clips");
    // 並びは新しい順なので、置いた逆の順に並ぶ
    const ids = [
      await putClip(page, request, id, 5),
      await putClip(page, request, id, 6),
      await putClip(page, request, id, 7),
    ].reverse();
    try {
      await goto(page, `/clips?recording=${id}`);
      const cardOf = (clip: number) =>
        page.locator(`[data-testid="clip-card"][data-clip-id="${clip}"]`);
      const checkOf = (clip: number) =>
        page.locator(
          `li:has([data-clip-id="${clip}"]) [data-testid="clip-check"]`,
        );
      const [first, second, third] = ids as [number, number, number];
      const picked = page.getByTestId("clip-picked").first();

      // 乗せる前は丸は見えず、乗せると出る。読み上げには番組名ごとの名前
      await expect(checkOf(first)).toHaveCSS("opacity", "0");
      await cardOf(first).hover();
      await expect(checkOf(first)).toHaveCSS("opacity", "1");
      await expect(checkOf(first)).toHaveAttribute("aria-label", /^選ぶ: /);
      await expect(checkOf(first)).toHaveAttribute("aria-pressed", "false");

      // 丸を押すと選ぶ形に入り、ほかの 1 枚にも丸が出る
      await checkOf(first).click();
      await expect(picked).toHaveText("1 枚を選択中");
      await expect(checkOf(first)).toHaveAttribute("aria-pressed", "true");
      await expect(cardOf(first)).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(0, 0);
      await expect(checkOf(third)).toHaveCSS("opacity", "1");

      // Shift で 3 枚目までまとめて選ぶ。選ぶ形の間は押しても開かない
      await cardOf(third).click({ modifiers: ["Shift"] });
      await expect(picked).toHaveText("3 枚を選択中");
      await expect(page.getByTestId("clip-viewer")).toBeHidden();
      // 押すと外れる
      await cardOf(second).click();
      await expect(picked).toHaveText("2 枚を選択中");
      await expect(cardOf(second)).toHaveAttribute("aria-pressed", "false");

      // Esc で抜ける。丸は隠れ、押せばまた開く
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("clip-picked")).toHaveCount(0);
      await page.mouse.move(0, 0);
      await expect(checkOf(third)).toHaveCSS("opacity", "0");
      await expect(cardOf(first)).not.toHaveAttribute("aria-pressed");
      await cardOf(second).click();
      const viewer = page.getByTestId("clip-viewer");
      await expect(viewer).toBeVisible();
      await viewer.getByTestId("clip-close").click();
      await expect(viewer).toBeHidden();

      // 丸はキーボードでも押せる (1 枚の次に Tab で触ると見える)
      await cardOf(first).focus();
      await page.keyboard.press("Tab");
      await expect(checkOf(first)).toBeFocused();
      await expect(checkOf(first)).toHaveCSS("opacity", "1");
      await page.keyboard.press("Enter");
      await expect(picked).toHaveText("1 枚を選択中");
      await cardOf(third).click();
      await expect(picked).toHaveText("2 枚を選択中");

      // 削除は 2 回押し。1 回目は聞き返すだけ
      await page.getByTestId("clip-delete-many").first().click();
      await expect(cardOf(first)).toBeVisible();
      await page.getByTestId("clip-delete-many-confirm").first().click();
      await expect(cardOf(first)).toHaveCount(0);
      await expect(cardOf(third)).toHaveCount(0);
      await expect(cardOf(second)).toBeVisible();
      await expect(page.getByTestId("clip-picked")).toHaveCount(0);
      expect((await request.get(`/api/clips/${first}/image`)).status()).toBe(
        404,
      );
      expect((await request.get(`/api/clips/${second}/image`)).status()).toBe(
        200,
      );
    } finally {
      await request.delete(`/api/clips?ids=${ids.join(",")}`);
    }
  });

  /*
   * **字幕を出したまま小窓にすると、字幕を重ねた映像を小窓に出す** (`pip.svelte.ts` の `composeBaked`。Chrome・Edge)。
   * 重ねたものを `$state` に入れると proxy に包まれて `===` が外れ、字幕の無い元の `<video>` に落ちていた (#2367)。
   *
   * 偽 ffmpeg の録画は映像が出ない (上) ので、元の `<video>` の映像 (`captureStream`) は動く canvas から取ったものに
   * 差し替え、再生中に見せる。小窓の API も差し替えて、どの `<video>` を出したかだけを見る
   */
  test("字幕を出したまま小窓にすると、字幕を重ねた映像を出す", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await page.addInitScript(() => {
      let shown: Element | null = null;
      Object.defineProperty(Document.prototype, "pictureInPictureEnabled", {
        get: () => true,
      });
      Object.defineProperty(Document.prototype, "pictureInPictureElement", {
        get: () => shown,
      });
      HTMLVideoElement.prototype.requestPictureInPicture = async function () {
        shown = this;
        this.dispatchEvent(new Event("enterpictureinpicture"));
        return {} as PictureInPictureWindow;
      };
      Document.prototype.exitPictureInPicture = async () => {
        const was = shown;
        shown = null;
        was?.dispatchEvent(new Event("leavepictureinpicture"));
      };
      (
        HTMLVideoElement.prototype as HTMLVideoElement & {
          captureStream: () => MediaStream;
        }
      ).captureStream = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 36;
        const ctx = canvas.getContext("2d")!;
        let n = 0;
        setInterval(() => {
          ctx.fillStyle = n++ % 2 === 0 ? "#3a6" : "#36a";
          ctx.fillRect(0, 0, 64, 36);
        }, 30);
        return canvas.captureStream(30);
      };
    });
    await goto(page, `/watch/${id}`);
    await expect(page.getByTestId("watch-captions")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("watch-video").evaluate((video) => {
      Object.defineProperty(video, "paused", { get: () => false });
    });
    await wakeControls(page, "watch-stage");
    await page.getByTestId("watch-pip").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (document.pictureInPictureElement as HTMLElement | null)?.dataset[
              "testid"
            ] ?? null,
        ),
      )
      .toBe("pip-raw");
  });
});

/**
 * **字幕は、見えている大きさ × 画面の画素で描く** (`caption-draw.ts` の `CaptionPainter`)。
 *
 * 実機で「字幕がぼやぁっとしている」— データ放送を出した観る画面で、小窓に入った字幕が
 * 拡大した画像のように滲んでいた。当時は BML の面 (960x540) を原寸で組んで枠いっぱいに
 * `transform: scale` で伸ばすのに、字幕は CSS の大きさ (面の上の 480x270) の画素で描いていた。
 * いまは面ごと伸ばさないが、CSS の大きさは整数に丸めてあるので、見えている大きさで描くのは変わらない。
 * 偽の録画は中身が無いので、字幕は `captions.json` を差し替えて 0 秒に 1 枚置く
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
