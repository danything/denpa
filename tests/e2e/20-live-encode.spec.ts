import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { BS11, BS_NO_LOGO, MX, SERVICES } from "../fake/services";
import {
  CAPTION_SCREENS,
  captureSockets,
  expect,
  expectSharpCaptions,
  feedCaption,
  goto,
  holdCaptions,
  later,
  liveWithoutMpeg2,
  openSettings,
  pickCodec,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";
import { sameBox } from "./live";

/**
 * 偽 ffmpeg が残した引数を 1 回ぶんずつに切って、最後の 1 回を返す。
 *
 * **ライブ視聴で起きる ffmpeg は 1 本。** 映像も字幕も同じ 1 本がエンコードする
 * (そうしないと時刻が揃わない。`server/captions.ts`)。同じファイルに選局の
 * たびに足していくので (`tests/fake/ffmpeg.sh`)、見るのはいちばん新しい 1 回
 */
async function ffmpegArgs(
  file: string,
  expect_: typeof expect,
): Promise<string[]> {
  let found: string[] | undefined;
  await expect_(() => {
    expect_(existsSync(file)).toBe(true);
    const runs = readFileSync(file, "utf8")
      .split("---\n")
      .filter((run) => run.trim() !== "")
      .map((run) => run.split("\n"));
    found = runs.findLast((run) => run.includes("libx264"));
    expect_(found, "ライブの ffmpeg が起きていない").toBeDefined();
  }).toPass({ timeout: 15_000 });
  return found ?? [];
}

/**
 * ライブ視聴の音声・エンコード方式・字幕、端末に覚えるもの (前回の局・貯め方)、チケット、通知と、
 * 番組の切り替わり・画面の消灯。偽 ffmpeg で確かめる範囲と、ほかのライブ視聴のスペックとの分け方は
 * [20-live.spec.ts](20-live.spec.ts) の冒頭にある
 */
test.describe("ライブ視聴", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  /*
   * **既定で黙らせない。** `muted` を書き付けていた頃は、開いても永久に
   * 無音だった (備え付けの操作で外すまで誰も気付けない)。黙るのは
   * 自動再生を断られたときだけで、そのときは押せる場所を出す
   */
  test("音を止めた状態では始めない", async ({ page }) => {
    await goto(page, "/live");
    await expect(page.getByTestId("live-video")).toBeVisible();
    const muted = await page
      .getByTestId("live-video")
      .evaluate((v) => (v as HTMLVideoElement).muted);
    expect(muted).toBe(false);
  });

  /*
   * **繋がったことは、使ったチューナーで分かる。** 画面に映像が出ないので、
   * 「押したら何かが起きた」をこちらで見る。用途に `live` と出るのは
   * ライブ視聴だけなので、これが出ていれば経路は通っている
   */
  test("局を選ぶとチューナーを使う", async ({ page }) => {
    await goto(page, "/live");
    const target = page.getByTestId("live-channel").first();
    const channel = await target.getAttribute("data-channel");
    await target.click();

    // 選んだ局が「いま映しているもの」になる
    await expect(page.getByTestId("live-title")).toBeVisible();

    await goto(page, "/settings/reception");
    await expect(page.getByText(/ライブ/).first()).toBeVisible();
    expect(channel).not.toBeNull();
  });

  /*
   * **ffmpeg に渡すのは、放送が名乗っている番号。**
   *
   * 1 つの物理チャンネルに複数の局が入っているので局を名指しするのだが、
   * 渡す番号を間違えると ffmpeg はその局を探して見つけられず、**映像も音も
   * 出ない**。denpa の `services.id` は `network_id * 100000 + service_id` の
   * 内部 ID で、TS の中には出てこない — 実際にこれを渡して再生できなくなった。
   */
  test("局は放送が名乗っている番号で名指しする", async ({ page, stack }) => {
    await goto(page, "/live");
    const target = page.getByTestId("live-channel").first();
    await target.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const args = await ffmpegArgs(stack.liveArgsFile, expect);

    // 名指ししている先が、内部 ID ではなく放送の番号になっていること
    const video = args.find((a) => a.startsWith("0:p:") && a.endsWith(":v:0"));
    expect(video).toBeDefined();
    const named = Number(video?.slice("0:p:".length, -":v:0".length));
    const service = SERVICES.find((s) => s.serviceId === named);
    expect(
      service,
      `${named} は放送の番号ではない (内部IDを渡していないか)`,
    ).toBeDefined();
    expect(args).toContain(`0:p:${named}:a:0`);
  });

  /*
   * **音声は番組表を見て組み立てる。**
   *
   * 選べるものは番組ごとに違う (二カ国語なら主/副/主+副、解説放送なら音声が 2 本)
   * ので、いま流れている番組から起こす (`arib.audioTracks`)。偽の放送は解説付きの
   * ステレオ 2 本 — 実機によくある構成で、**どちらも `component_type=3` の日本語**。
   *
   * 左右の配り直し (`-af pan=...`) が出ていたら、ステレオをデュアルモノと
   * 取り違えている — **映像は出るので、気付くのは音を聞いたときだけ**
   */
  test("ステレオでは音をいじらず、放送が言う主音声をエンコードする", async ({
    page,
    stack,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const args = await ffmpegArgs(stack.liveArgsFile, expect);

    expect(args).not.toContain("-af");
    // 何も指定されていないので主音声。何本目かを名指ししていること自体は要る
    expect(args.some((a) => a.endsWith(":a:0"))).toBe(true);
  });

  /*
   * **同じ構成の音声が 2 本あっても、見分けが付くようにする。**
   *
   * 解説放送はどちらも `component_type=3` の日本語なので、符号だけを見ていた
   * 頃は**「ステレオ (日本語)」が 2 つ**並んで、どちらが何なのか分からなかった
   * (実機の日テレ「金曜ロードショー[解]」)。放送のほうは
   * `audio_component_descriptor` の `text_char` に名前を書いている
   */
  test("音声の切り替えに、放送が付けた名前を出す", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    // 音声は再生の設定 (⚙) の中。行にいまの音声を出し、押すと選択肢の並びに入る
    await openSettings(page, "live");
    const audio = page.getByTestId("live-audio");
    await expect(audio).toContainText("主音声ステレオ (日本語)");
    await audio.click();
    await expect(page.getByTestId("live-audio-option")).toHaveText([
      "主音声ステレオ (日本語)",
      "解説ステレオ (日本語)",
    ]);
  });

  /*
   * **エンコード方式は見ながら選べる。**
   *
   * 映像の中身ではなく「その端末で出るか」の話なので、音声とは別に選ばせる。
   * AV1 は同じ映像で 15% ほど軽い (実機で 3.3 → 2.8 Mbit/s) が、出ない
   * ブラウザもある。
   *
   * **選び直したら再エンコードになる。** サーバはエンコード方式ごとに別の ffmpeg を回す
   * ので、渡した引数がそのまま変わる
   */
  test("エンコード方式を選び直すと、その形式で再エンコードする", async ({
    page,
    stack,
  }) => {
    rmSync(stack.liveArgsFile, { force: true });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    // MPEG-2 をデコードできない端末として開くので、自動で H.264 を観る (`liveWithoutMpeg2`。MPEG-2 から始まる自動は `61-live-auto`)
    expect(await ffmpegArgs(stack.liveArgsFile, expect)).toContain("libx264");

    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");

    await expect(async () => {
      const runs = readFileSync(stack.liveArgsFile, "utf8")
        .split("---\n")
        .filter((run) => run.trim() !== "");
      expect(
        runs.some((run) => run.includes("libsvtav1")),
        "AV1 で再エンコードしていない",
      ).toBe(true);
    }).toPass({ timeout: 15_000 });

    // 押した形式が切り替えに出ている。押しても表示が変わらないと効いたか分からない
    await expect(page.getByTestId("live-codec")).toContainText("AV1");
  });

  /*
   * **チャンネルを変えても、選んだ形式は続く。**
   *
   * 音声と違って番組の中身で決まるものではなく、その端末で出るかどうかの話。
   * 局を選び直すたびに H.264 へ戻されては、選んだ意味が無い
   */
  test("局を変えてもエンコード方式は変わらない", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await channels.first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");
    await expect(page.getByTestId("live-codec")).toContainText("AV1");

    await channels.nth(1).click();
    await expect(channels.nth(1)).toHaveAttribute("data-current", "true");
    await expect(page.getByTestId("live-codec")).toContainText("AV1");

    // 開き直しても覚えている
    await goto(page, "/live");
    await expect(page.getByTestId("live-codec")).toContainText("AV1");
  });

  /*
   * **再生の設定 (⚙) はキーボードでも辿れる。** 切り替えはその場で変わって閉じず、コーデックは
   * 選択肢の並びに入り、Esc で上の並びへ、もう一度 Esc で閉じて ⚙ へ戻る
   */
  test("再生の設定をキーボードで辿れる", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");

    const gear = page.getByTestId("live-settings");
    const menu = page.getByTestId("live-settings-menu");
    // 広い枠では何も畳まないので、⚙ の先頭に操作バーのもの (消音・小窓) は並ばない
    await expect(page.getByTestId("live-mute")).toHaveCount(0);
    await expect(page.getByTestId("live-pip-mode")).toHaveCount(0);
    await expect(gear).toHaveAttribute("aria-haspopup", "menu");
    await gear.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("role", "menu");

    // マウスの端末の広い枠では音量のつまみは音のボタンにだけあり (`58-volume`)、先頭はデータ放送を常に受信
    // (ライブに CM スキップは無い。データ放送を開くのは右端の列の d)。Enter で切り替わり、閉じない
    await expect(page.getByTestId("live-volume")).toHaveCount(0);
    const first = page.getByTestId("live-data-receive");
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("role", "menuitemcheckbox");
    const before = await first.getAttribute("aria-checked");
    await page.keyboard.press("Enter");
    await expect(first).not.toHaveAttribute("aria-checked", before ?? "");
    await expect(menu).toBeVisible();

    // コーデックは行にいまの値を出し、→ で選択肢の並びに入る (選んでいるものにフォーカス)
    const codec = page.getByTestId("live-codec");
    await expect(codec).toContainText("自動 (H.264)");
    await codec.focus();
    await page.keyboard.press("ArrowRight");
    const auto = page.locator(
      '[data-testid="live-codec-option"][data-codec="auto"]',
    );
    await expect(auto).toBeFocused();
    await expect(auto).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("live-settings-back")).toBeVisible();

    // Esc は上の並びへ (閉じない)。戻るとコーデックの行にいる
    await page.keyboard.press("Escape");
    await expect(menu).toBeVisible();
    await expect(codec).toBeFocused();
    // もう一度 Esc で閉じて、⚙ に戻る
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(gear).toBeFocused();

    // 選択肢の並びで選んで閉じたら、閉じ終えてから上の並びに戻る (引っ込む間は替えない。ここは動きを止めて
    // 流すので見えない)。次に開くと上の並びから
    await page.keyboard.press("Enter");
    await codec.focus();
    await page.keyboard.press("ArrowRight");
    await expect(auto).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("live-settings-back")).toHaveCount(0);
    await expect(gear).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(codec).toBeVisible();
  });

  /*
   * **切り替えの間、前のコマを貼っておく場所を持っておく。**
   *
   * 選局にかかる 1.6 秒は削れない (電波の同期待ち 0.65 秒 + 放送の MPEG-2 が
   * GOP の先頭を待つ 0.75 秒)。待ちは変わらないが、その間を真っ黒にしないために
   * 直前の 1 枚を canvas へ写して重ねる。
   *
   * 貼っていない間は**押す邪魔をしてはいけない** — 映像の上に敷くものなので、
   * 透けているだけでは足りず、当たり判定も抜けている必要がある
   */
  test("切り替え中に貼るコマは、操作の邪魔をしない", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();

    const still = page.getByTestId("live-still");
    await expect(still).toHaveAttribute("data-holding", "false");
    await expect(still).toHaveCSS("pointer-events", "none");
    // 映像と同じ場所に重なっていること。ずれていると映像が飛んで見える
    await sameBox(still, page.getByTestId("live-video"));
  });

  /*
   * **放送の字幕は `<track>` ではなく canvas に描いて重ねる** (放送に乗っているのは文字と
   * 描き方の指定で、テレビはそれを見て毎回自分で描く。サーバが置き場所まで決めた文字の配置を
   * 送るので、録画で見る字幕と同じ所に出る)。
   *
   * 偽の放送に字幕は乗っていないので、ここで見られるのは敷き方まで。
   * **映像と寸分同じ枠に、当たり判定を抜いて敷く** — ずれると字幕が飛び、
   * 抜けていないと下の操作バーが押せなくなる。
   */
  test("字幕を重ねる場所は、映像と同じ枠で、押す邪魔をしない", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();

    const captions = page.getByTestId("live-captions");
    await expect(captions).toHaveCSS("pointer-events", "none");
    await sameBox(captions, page.getByTestId("live-video"));

    // 字幕の来ていない番組で切り替えを出すと、押しても何も起きない操作が並ぶ
    await expect(captions).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId("live-caption")).toHaveCount(0);
  });

  /*
   * **字幕は、見えている大きさ × 画面の画素で描く** (`CaptionPainter`)。描く画素が見えている
   * 大きさと食い違うと、ブラウザが引き伸ばして字がぼやける。偽の放送に字幕は乗っていないので
   * 1 枚流す (`feedCaption`)。データ放送の小窓の中は上の「小窓へ縮んで見えている」で見る
   */
  test("字幕の画素は、PC (DPR 1・2) でもスマホでも見えている大きさ × DPR と合う", async ({
    browser,
  }) => {
    for (const [what, options] of CAPTION_SCREENS) {
      const context = await browser.newContext(options);
      await liveWithoutMpeg2(context);
      const page = await context.newPage();
      await captureSockets(page);
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      // 狭い枠ではタイトルを畳むので、出ているかではなく在るかで待つ
      await expect(page.getByTestId("live-title")).toBeAttached();
      await holdCaptions(page, "live-captions");
      await feedCaption(page, "live");
      await expectSharpCaptions(page, what);
      await context.close();
    }
  });

  /*
   * **字幕の言語は再エンコードせずに選び直す** (`{ type: 'language' }`)。サーバは載っている言語を全部
   * デコードしていて、出す言語を視聴者ごとに替えるだけ。偽の放送に字幕は乗っていないので、
   * 言語が 2 つ載っている通知を流す
   */
  test("字幕の言語を ⚙ で選ぶと、言語だけをリクエストし直して覚える", async ({
    page,
  }) => {
    await captureSockets(page);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    // 送ったものを控える
    await page.evaluate(() => {
      const seen = window as unknown as {
        __sockets: WebSocket[];
        __sent: string[];
      };
      seen.__sent = [];
      const socket = seen.__sockets.at(-1);
      const send = socket?.send.bind(socket);
      if (socket !== undefined && send !== undefined) {
        socket.send = (data) => {
          seen.__sent.push(String(data));
          send(data);
        };
      }
    });
    const notice = {
      type: "captions",
      tracks: [{ index: 0, lang: "jpn", label: "字幕" }],
      track: 0,
      languages: [
        { index: 1, code: "jpn", label: "日本語" },
        { index: 2, code: "eng", label: "英語" },
      ],
      language: 1,
    };
    await page.evaluate((json) => {
      const socket = (
        window as unknown as { __sockets: WebSocket[] }
      ).__sockets.at(-1);
      const body = new TextEncoder().encode(json);
      const data = new Uint8Array(9 + body.length);
      data[0] = 0x40;
      data.set(body, 9);
      socket?.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
    }, JSON.stringify(notice));

    await wakeControls(page, "live-frame");
    const row = page.getByTestId("live-subtitle");
    await expect(row).toContainText("日本語");
    await openSettings(page, "live");
    await row.click();
    await expect(page.getByTestId("live-subtitle-option")).toHaveText([
      "オフ",
      "日本語",
      "英語",
    ]);
    await page
      .locator('[data-testid="live-subtitle-option"][data-subtitle="0:2"]')
      .click();
    await expect(row).toContainText("英語");
    const sent = await page.evaluate(
      () => (window as unknown as { __sent: string[] }).__sent,
    );
    expect(sent.map((s) => JSON.parse(s))).toContainEqual({
      type: "language",
      language: 2,
    });
    // 映像はリクエストし直さない (選局の指示は送らない)
    expect(sent.some((s) => JSON.parse(s).type === "tune")).toBe(false);
    expect(
      await page.evaluate(() => localStorage.getItem("caption-language")),
    ).toBe("eng");

    // オフは字幕ボタンと同じ。端末に覚える
    await openSettings(page, "live");
    await row.click();
    await page
      .locator('[data-testid="live-subtitle-option"][data-subtitle="off"]')
      .click();
    await expect(page.getByTestId("live-caption")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(await page.evaluate(() => localStorage.getItem("caption-on"))).toBe(
      "0",
    );
  });

  /*
   * **選んだ字幕は、リクエストし直しても続く。** 選局の指示に字幕の番号を載せ忘れると、
   * エンコード方式を選び直したり繋ぎ直したりしたとき、サーバだけ 1 本目に戻っていた
   */
  test("2 本目の字幕を選んだまま、エンコード方式を選び直しても字幕は 2 本目", async ({
    page,
  }) => {
    await captureSockets(page);
    // 送ったものを控える (繋ぎ直しても数えられるよう、作る前から)
    await page.addInitScript(() => {
      const seen = window as unknown as { __sent: string[] };
      seen.__sent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        seen.__sent.push(String(data));
        send.call(this, data);
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const notice = {
      type: "captions",
      tracks: [
        { index: 0, lang: "jpn", label: "字幕 1" },
        { index: 1, lang: "jpn", label: "字幕 2" },
      ],
      track: 0,
    };
    await page.evaluate((json) => {
      const socket = (
        window as unknown as { __sockets: WebSocket[] }
      ).__sockets.at(-1);
      const body = new TextEncoder().encode(json);
      const data = new Uint8Array(9 + body.length);
      data[0] = 0x40;
      data.set(body, 9);
      socket?.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
    }, JSON.stringify(notice));

    const tunes = async () =>
      (
        await page.evaluate(
          () => (window as unknown as { __sent: string[] }).__sent,
        )
      )
        .map(
          (s) =>
            JSON.parse(s) as { type: string; codec?: string; caption?: number },
        )
        .filter((c) => c.type === "tune");

    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await page.getByTestId("live-subtitle").click();
    await page
      .locator('[data-testid="live-subtitle-option"][data-subtitle="1:0"]')
      .click();
    await expect.poll(async () => (await tunes()).at(-1)?.caption).toBe(1);

    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");
    await expect
      .poll(async () => {
        const last = (await tunes()).at(-1);
        return [last?.codec, last?.caption];
      })
      .toEqual(["av1", 1]);
  });

  /*
   * **字幕は映像と同じ ffmpeg がエンコードする。** 出口を 2 つ持つ 1 本しか起きない。
   *
   * **それが時刻を揃える唯一の方法だった。** 別々に起こした 2 本は入口で時刻を
   * 0 に寄せる幅が違うので、出てきた時刻を突き合わせても意味を持たない
   * (装置を 5 通り作って -60〜+450ms とばらけた)。1 本なら寄せは 1 回で、
   * 両方の出口に同じだけ効く — 実機で 1ms 以内に一致した。
   *
   * ここで固定するのは、間違えても**映像は出てしまう**種類の指定。
   *
   * - `-copyts` を**付けない** … 付けると放送の絶対時刻が mp4 のマルチプレクサまで
   *   届き、あれが 0 に詰め直すので受け側から見た 0 の意味が分からなくなる
   * - 字幕は**デコードせずに写す** (`-c:s copy`) … デコードして置き場所を決めるのは denpa
   *   (`packages/arib/src/b24caption.ts`)。画像にしていた頃の `-sub_type bitmap` は要らない
   * - Matroska で受ける … **時刻をコマと一緒に運ばせる**。PNG だけを並べる
   *   だけでは時刻が乗らず、別のフィルタ (`showinfo`) に喋らせると数が合わずにずれる
   */
  test("字幕は映像と同じ ffmpeg で、同じ物差しで取り出す", async ({
    page,
    stack,
    request,
  }) => {
    // 偽の放送の PMT に字幕の ES を載せる。無ければ字幕の出力は指定しない (下の「字幕を持たない放送」)
    await request.post(`${stack.agentUrl}/__control/captions?on=1`);
    let args: string[];
    try {
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      args = await ffmpegArgs(stack.liveArgsFile, expect);
    } finally {
      // 載せたままだと、同じ偽の放送を使うデータ放送の E2E を乱す (`Knobs.captions`)
      await request.post(`${stack.agentUrl}/__control/captions?on=0`);
    }
    // 映像と字幕が同じ 1 回の中にあること
    expect(args).toContain("libx264");
    expect(args).toContain("pipe:1");
    expect(args).toContain("pipe:3");
    expect(args).not.toContain("-copyts");

    expect(args).not.toContain("-sub_type");
    expect(args[args.indexOf("-c:s") + 1]).toBe("copy");
    expect(args[args.indexOf("-f", args.indexOf("pipe:1")) + 1]).toBe(
      "matroska",
    );

    // 字幕も局を名指しする。1 つの物理チャンネルに複数の局が入っている
    expect(args[args.lastIndexOf("-map") + 1]).toMatch(/^0:p:\d+:s:0$/);

    /*
     * **別のフィルタには喋らせない。** 時刻と「空かどうか」を `showinfo` に喋らせ、
     * 標準エラーの行と標準出力の PNG を来た順に組にしていた頃は、**数が
     * 合わずにずれていた** (実機で PNG 77 枚に対し showinfo 79 行)。一度ずれると
     * 戻らず、字幕が 1 秒ほど遅れて出て、消えるのも遅れる
     */
    expect(args).not.toContain("showinfo");
  });

  /*
   * **字幕を持たない放送では、初めから字幕の出力を指定しない。**
   *
   * 指定すると ffmpeg は入口を探り終えてから降り、字幕なしで起こし直すまで映像が 1.5 秒ほど遅れていた
   * (実機の CS で、開くたびに)。PMT には ES が全部並んでいるので、起こす前に読めば分かる
   * (`server/captions.ts` の `peekCaptions`)。偽 ffmpeg は本物と同じく、指定されたら降りる
   */
  test("字幕を持たない放送では、ffmpeg を起こし直さずに開く", async ({
    page,
    stack,
    request,
  }) => {
    rmSync(stack.liveArgsFile, { force: true });
    // 偽の放送の PMT は、既定で字幕の ES を載せない (`Knobs.captions`)
    await request.post(`${stack.agentUrl}/__control/captions?on=0`);
    writeFileSync(stack.liveNoCaptionsFile, "1");
    try {
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-title")).toBeVisible();

      const args = await ffmpegArgs(stack.liveArgsFile, expect);
      expect(args).not.toContain("pipe:3");
      expect(args.some((arg) => /:s:\d+$/.test(arg))).toBe(false);

      // 起こし直していれば、降りてすぐ 2 回目が足される。少し待っても 1 回のまま
      await page.waitForTimeout(2_000);
      const runs = readFileSync(stack.liveArgsFile, "utf8")
        .split("---\n")
        .filter((run) => run.includes("libx264"));
      expect(runs).toHaveLength(1);
    } finally {
      rmSync(stack.liveNoCaptionsFile, { force: true });
    }
  });

  /*
   * **前回見ていたチャンネルで開く。** テレビを点けたときと同じ振る舞いで、
   * 毎回いちばん上の局から始まると、いつも選び直すことになる
   */
  test("開き直すと、前回見ていた局から始まる", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    // 先頭以外を選ぶ。先頭だと「覚えている」のか「既定」なのか見分けが付かない
    const second = channels.nth(1);
    const picked = await second.getAttribute("data-channel");
    await second.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await goto(page, "/live");
    // 覚えていた局が選ばれた状態で開く
    await expect(
      page.locator(`[data-testid="live-channel"][data-channel="${picked}"]`),
    ).toHaveAttribute("data-current", "true");
  });

  /*
   * **覚えた貯め方を捨てられる。**
   *
   * 貯める量の下限はその端末に覚えさせてある (`live-player` の `FLOOR_KEY`)。
   * 覚えているのは**経路の性質**なので、持ち出したり線を繋ぎ替えたりすると
   * 前の経路の値のまま残る。高すぎる側に外れると、放っておいても
   * **10 分ごとに 0.3 秒 ずつ**しか下がらない (`pacing` の `FORGET`)。
   *
   * 出しっぱなしにはしない。**覚えているものが無いときに出しても押せない**
   */
  test("覚えた貯め方を捨てられる。覚えていなければ出さない", async ({
    page,
  }) => {
    const stored = () =>
      page.evaluate(() => localStorage.getItem("live-floor"));

    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    // まっさらな端末には忘れるものが無い
    await expect(page.getByTestId("live-relearn")).toBeHidden();

    await page.evaluate(() => localStorage.setItem("live-floor", "1.5"));
    await page.reload();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect(page.getByTestId("live-relearn")).toBeVisible();

    await wakeControls(page, "live-frame");
    await page.getByTestId("live-relearn").click();
    await expect(page.getByTestId("live-relearn")).toBeHidden();
    expect(await stored(), "覚えたものが残っている").toBeNull();
  });

  /*
   * **チケットは使い捨て。** URL は履歴にもログにも残るので、見られても二度目は
   * 通らない。ここが緩むと、チューナーを使うエンドポイントが素通しになる
   */
  test("チケットなしでは WebSocket に繋げない", async ({ page }) => {
    await goto(page, "/live");
    const status = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(
            `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/socket`,
          );
          ws.onopen = () => resolve("開いた");
          ws.onerror = () => resolve("断られた");
          ws.onclose = () => resolve("断られた");
          setTimeout(() => resolve("無反応"), 3000);
        }),
    );
    expect(status).toBe("断られた");
  });

  /*
   * **同じ通知でも、押し直せばもう一度出る。** 閉じたことは key で覚えているので、
   * 返事が変わったことを渡さないと (`source`)、同じ文面の 2 回目は閉じたままになりうる
   * (Toasts)。いまは `applyAction` が一度 form を null にしてから入れ直すので、
   * その隙に閉じた印が捨てられて出ている — **それに頼らない**よう他の画面と揃えて
   * `source` を渡し、ここで見張る。
   *
   * 毎回同じ断りを返させるため、録る局だけ番組表の無い局 (BSテレ東) に差し替えて
   * 押す — 本当に録り始めるとチューナーを 30 分塞ぐ
   */
  test("同じ通知を閉じても、押し直せばまた出る", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const record = page.getByTestId("live-record");
    const notice = page.getByTestId("record-error");
    const press = async () => {
      await page
        .locator('form[action="?/record"] input[name="service"]')
        .evaluate(
          (input, id) => ((input as HTMLInputElement).value = id),
          String(BS_NO_LOGO.id),
        );
      await wakeControls(page, "live-frame");
      await record.click();
    };

    await press();
    await expect(notice).toContainText("番組表に見つかりません");
    await page.getByTestId("record-error-close").click();
    await expect(notice).toHaveCount(0);

    await press();
    await expect(notice).toContainText("番組表に見つかりません");
  });
});

/**
 * **観ている間に番組が替わったら、出ている番組も替わる。** 開いた時点の番組のまま残っていた
 * (次の番組が始まっても操作バーの番組名・時間帯と一覧の番組名が前のまま)。
 *
 * - 予定どおりの切り替わり … いちばん早く終わる番組の終わりで読み直す
 * - 延長・繰り下げ … サーバが観ている局の EIT[p/f] を読んで番組表に写し、知らせてくる
 */
test.describe("ライブで番組が替わる", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });
  test.afterEach(async ({ request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/extend?ms=0`);
  });

  test("次の番組が始まると、操作バーと一覧の番組名が替わる", async ({
    page,
  }) => {
    await goto(page, `/live?service=${BS11.id}`);
    const title = page.getByTestId("live-title");
    await expect(title).toBeVisible();
    const before = (await title.textContent()) ?? "";

    // BS11 は 5 秒ごとに番組が替わる (tests/fake/services.ts)
    await expect(title).not.toHaveText(before, { timeout: 20_000 });
    // 一覧の行も同じ番組を出す。次の切り替わりと競らないよう、同じ瞬間に読み比べる
    const row = page.locator(
      `[data-testid="live-channel"][data-service="${BS11.id}"]`,
    );
    await expect
      .poll(async () => {
        const now = (await title.textContent()) ?? "";
        return now !== "" && ((await row.textContent()) ?? "").includes(now);
      })
      .toBe(true);
  });

  test("放送が延びたら、終わりの時刻も延びる。戻れば戻る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    // MX は 30 分枠 (:00 と :30 で替わる)。替わり目の直前なら、替わってから始める
    const slot = 30 * 60_000;
    const left = slot - (Date.now() % slot);
    if (left < 60_000) await page.waitForTimeout(left + 3_000);

    await goto(page, `/live?service=${MX.id}`);
    const range = page.getByTestId("live-range");
    await expect(range).toBeVisible();
    const before = ((await range.textContent()) ?? "").trim();
    const [start, end] = before.split("〜").map((part) => part.trim());

    // 放送が 10 分押した。サーバが p/f を読んで番組表を直し、画面に読み直させる
    await request.post(`${stack.agentUrl}/__control/extend?ms=${10 * 60_000}`);
    await expect(range).toHaveText(`${start}〜${later(end ?? "", 10)}`);

    // 戻せば元の時刻に戻る
    await request.post(`${stack.agentUrl}/__control/extend?ms=0`);
    await expect(range).toHaveText(before);
  });
});

/**
 * **Safari は、ユーザーが操作した直後でないと Screen Wake Lock を取らせない** (#2209)。
 * ライブを URL で直に開くと操作の前に要求して断られ、画面が消えていた。
 * 断られたら、次のクリックで取り直す (`awake.svelte.ts`)
 */
test.describe("ライブを直に開いたときの画面の消灯", () => {
  test("操作の前に断られても、次のクリックで画面を消させない", async ({
    page,
  }) => {
    /*
     * Safari と同じく、操作の直後でなければ断る wakeLock。Chromium の `userActivation` はヘッドレスだと
     * 操作が無くても立っていることがあるので使わず、クリック・キー・タッチから 1 秒の間だけ通す
     */
    await page.addInitScript(() => {
      const state = { asked: 0, held: 0 };
      let gestureAt = -Infinity;
      for (const type of ["click", "keydown", "touchend"])
        window.addEventListener(type, () => (gestureAt = performance.now()), {
          capture: true,
        });
      (window as unknown as { __wake: typeof state }).__wake = state;
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request: () => {
            state.asked++;
            if (performance.now() - gestureAt > 1000) {
              return Promise.reject(
                new DOMException("not allowed", "NotAllowedError"),
              );
            }
            state.held++;
            const sentinel = new EventTarget() as EventTarget & {
              release: () => Promise<void>;
            };
            sentinel.release = () => Promise.resolve();
            return Promise.resolve(sentinel);
          },
        },
      });
    });
    const wake = () =>
      page.evaluate(
        () =>
          (window as unknown as { __wake: { asked: number; held: number } })
            .__wake,
      );

    await goto(page, "/live");
    // 開いただけでは断られる
    await expect.poll(async () => (await wake()).asked).toBeGreaterThan(0);
    expect((await wake()).held).toBe(0);

    // 画面を触ると、その操作の中で取り直す
    await page.getByTestId("live-channel").first().click();
    await expect.poll(async () => (await wake()).held).toBe(1);
  });
});
