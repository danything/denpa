import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { SERVICES } from "../fake/services";
import {
  airing,
  captureSockets,
  cellOf,
  dataElement,
  expect,
  expectSideAligned,
  expectSideFrame,
  fakeDataBroadcast,
  fakeFrame,
  feedData,
  goto,
  openSettings,
  pickCodec,
  syncEpg,
  takeClip,
  test,
  upcoming,
  wakeControls,
} from "./helpers";

/**
 * TS の PAT に並んでいる局の番号。**丸ごと来ていれば複数、絞ってあれば 1 つ。**
 *
 * PAT は PID 0。`[pointer][table_id=0][...12バイト...][局2バイト][PMT の PID 2バイト]…`
 * で、末尾 4 バイトが CRC。区切りが 1 パケットに収まる大きさなので、組み立ては要らない
 */
function patPrograms(data: Buffer): number[] {
  const found: number[] = [];
  for (let at = 0; at + 188 <= data.length; at += 188) {
    if (data[at] !== 0x47) continue;
    const pid = ((data[at + 1]! & 0x1f) << 8) | data[at + 2]!;
    // 区切りの頭が入っているものだけ (payload_unit_start_indicator)
    if (pid !== 0 || (data[at + 1]! & 0x40) === 0) continue;
    const start = at + 4 + 1 + data[at + 4]!;
    if (data[start] !== 0x00) continue;
    const length = ((data[start + 1]! & 0x0f) << 8) | data[start + 2]!;
    const end = start + 3 + length - 4;
    for (let i = start + 8; i + 4 <= end && i + 4 <= at + 188; i += 4) {
      const program = (data[i]! << 8) | data[i + 1]!;
      // 0 は NIT で局ではない
      if (program !== 0) found.push(program);
    }
  }
  return found;
}

/**
 * ライブ視聴 ([docs/stream.md](../../docs/stream.md#ライブ))。映像・音声・字幕まで。
 *
 * **映像が出るところまでは見ない。** E2E の ffmpeg は偽物で、流れてくるのも
 * 本物の TS ではないため、MSE が受け取れる fMP4 にはならず、字幕も 1 枚も出ない。
 * ここで固定するのはその手前まで — **チケットを取り、WebSocket が繋がり、チューナーを
 * 使い、選んだ局が「いま映しているもの」になる**という経路と、**ffmpeg に何を
 * 渡したか**。エンコードしたものが正しいかどうかは実機で測る話になる。
 *
 * ここは選局・一覧・データ放送まで。操作バーから先 (小窓・音声・エンコード方式・字幕・スマホの向き) は
 * [20-live-player.spec.ts](20-live-player.spec.ts) にある (2 本に分けて別のワーカーで流す)
 */
test.describe("ライブ視聴", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("ヘッダーの「ライブ」から開ける", async ({ page }) => {
    await goto(page, "/");
    await page.getByTestId("nav-live").click();
    await expect(page).toHaveURL(/\/live$/);
    await expect(page.getByTestId("live")).toBeVisible();
  });

  test("右にチャンネルが並ぶ", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await expect(channels.first()).toBeVisible();
    /*
     * **数えるのも待つ。** `expect(await count())` は撮った瞬間の数で
     * 決めるので、1 件目が出た直後だと 1 のまま落ちる (実際に揺れていた)
     */
    await expect.poll(() => channels.count()).toBeGreaterThan(1);
    // 番組表と同じ並び。地上波はリモコン番号順で先頭に来る
    await expect(channels.first()).toHaveAttribute("data-channel", /^GR\//);
  });

  /*
   * **映像を見ながら選ぶ画面なので、ページごと動かさない。** 動くと映像が
   * 画面から出ていく。動くのは右の一覧だけ
   */
  test("広い画面ではページごとスクロールしない", async ({ page }) => {
    // **低めの画面で見る。** 高いと直す前の作りでも収まってしまい、判別できない
    await page.setViewportSize({ width: 1440, height: 700 });
    await goto(page, "/live");
    await expect(page.getByTestId("live-channel").first()).toBeVisible();

    const doc = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
    }));
    expect(doc.scrollH).toBeLessThanOrEqual(doc.clientH + 1);
  });

  test.describe("動かしてよい端末", () => {
    test.use({ reducedMotion: "no-preference" });

    /*
     * **開いた直後にも、窓にスクロールバーを出さない。** ページの中で開いたとき (画面の切り替えの動きの間も含めて)、
     * 毎コマ見る。読み上げ用の `.visually-hidden` (`position: absolute`) が文書を基準に置かれて
     * `.shell.fill` の `overflow: hidden` で切られず、局の一覧の中で隠れている行のぶんだけページが
     * 伸びていた (映像の色が付いて右の列が `position: relative` になるまでの 1 秒ほど)。
     * 偽の局は少なく一覧が溢れないので、**文書を基準に置かれたものが無いこと**も一緒に見る
     */
    test("ページの中で開いた直後も、窓はスクロールしない", async ({ page }) => {
      for (const size of [
        { width: 1541, height: 954 },
        { width: 1400, height: 600 },
      ]) {
        await page.setViewportSize(size);
        await goto(page, "/");
        await page.evaluate(() => {
          const w = window as unknown as {
            samples: { over: number; loose: string[] }[];
          };
          w.samples = [];
          const start = performance.now();
          const tick = () => {
            const root = document.documentElement;
            const shell = document.querySelector(".shell.fill");
            const loose: string[] = [];
            if (shell !== null) {
              // `position: absolute` で、位置を持つ祖先が `.shell` の外にあるもの (SVG の中身は `offsetParent` を持たないので見ない)
              for (const el of shell.querySelectorAll("*")) {
                if (
                  !(el instanceof HTMLElement) ||
                  getComputedStyle(el).position !== "absolute"
                )
                  continue;
                const parent = el.offsetParent;
                if (parent !== null && !shell.contains(parent))
                  loose.push(`${el.tagName}.${el.className}`);
              }
            }
            w.samples.push({
              over: root.scrollHeight - root.clientHeight,
              loose,
            });
            if (performance.now() - start < 2500) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.getByTestId("nav-live").click();
        await expect(page.getByTestId("live")).toBeVisible();
        await page.waitForTimeout(2600);
        const samples = await page.evaluate(
          () =>
            (
              window as unknown as {
                samples: { over: number; loose: string[] }[];
              }
            ).samples,
        );
        expect(samples.length).toBeGreaterThan(10);
        expect(
          Math.max(...samples.map((s) => s.over)),
          `${size.width}x${size.height}`,
        ).toBeLessThanOrEqual(0);
        expect([...new Set(samples.flatMap((s) => s.loose))]).toEqual([]);
      }
    });
  });

  /*
   * **目に見える映像の上端と、種別のタブの上端がそろう** (広い画面・低い画面の両方)。
   * 測るのは絵の出ている所 (エンコードしたものは video、MPEG-2 のままは canvas)
   */
  test("映像の上端と右の列の最初のもの (種別のタブ) の上端がそろう", async ({
    browser,
  }) => {
    // MPEG-2 もデコードできる端末として開く (既定の枠は `stack.ts` の `liveWithoutMpeg2`)。エンコードしたものは AV1 で観る
    const context = await browser.newContext();
    const page = await context.newPage();
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");
    for (const size of [
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-frame")).toBeVisible();
      await expectSideAligned(
        page,
        '[data-testid="live-video"]',
        ".live-side > :first-child",
      );
      // 映像の左・映像から種別のタブまで・タブの右の余白が同じ
      await expectSideFrame(
        page,
        '[data-testid="live-video"]',
        ".live-side > :first-child",
      );
    }
    // MPEG-2 のまま (canvas に描く) でも同じ
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "mpeg2");
    await expect
      .poll(
        async () =>
          Number(
            (await page.getByTestId("live-raw").getAttribute("data-shown")) ??
              0,
          ),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(10);
    await expectSideAligned(
      page,
      '[data-testid="live-raw"]',
      ".live-side > :first-child",
    );

    /*
     * **横に長い低い窓では、枠が映像の形に縮む** (左右に黒い帯を出さない。`PlayerStage`)。
     * 枠は絵と同じ縦横比で、高さいっぱい・上寄せ・列の真ん中。右端の縦の列も枠の中に残る
     */
    await page.setViewportSize({ width: 1680, height: 700 });
    const told = await page.getByTestId("live-raw").getAttribute("data-aspect");
    expect(told).toMatch(/^\d+ \/ \d+$/);
    const [w = 0, h = 0] = (told ?? "").split(" / ").map(Number);
    await expect
      .poll(async () => {
        const box = (await page.getByTestId("live-frame").boundingBox())!;
        return Math.abs(box.width / box.height - w / h);
      })
      .toBeLessThan(0.01);
    const frame = (await page.getByTestId("live-frame").boundingBox())!;
    const column = (await page
      .locator("[data-player-layout] > .main")
      .boundingBox())!;
    expect(frame.width).toBeLessThan(column.width - 100);
    expect(Math.abs(frame.y - column.y)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        frame.x - column.x - (column.x + column.width - frame.x - frame.width),
      ),
    ).toBeLessThanOrEqual(1);
    // 枠の下は窓の中 (高さで収まっている)
    expect(frame.y + frame.height).toBeLessThanOrEqual(700);
    await expectSideAligned(
      page,
      '[data-testid="live-raw"]',
      ".live-side > :first-child",
    );
    await expectSideFrame(
      page,
      '[data-testid="live-raw"]',
      ".live-side > :first-child",
    );
    await wakeControls(page, "live-frame");
    const shot = (await page.getByTestId("live-shot").boundingBox())!;
    expect(shot.x + shot.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(shot.width).toBe(48);
    await context.close();
  });

  /*
   * **種別のタブの端と、下の一覧の行の面の端がそろう** (広い画面・縦のタブレット・スマホ)。選んでいる行は
   * 面で塗るので、面の端がタブより外へ出ていると、タブと一覧がずれて見えた
   */
  test("種別のタブと下の一覧の端がそろう", async ({ page }) => {
    for (const size of [
      { width: 1366, height: 768 },
      { width: 820, height: 1180 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/live");
      const tabs = (await page
        .locator(".live-side > .type-tabs")
        .boundingBox())!;
      const row = (await page
        .locator(".live-side .channel-item")
        .first()
        .boundingBox())!;
      const at = `${size.width}px`;
      expect(Math.abs(tabs.x - row.x), `${at} の左`).toBeLessThanOrEqual(1);
      expect(
        Math.abs(tabs.x + tabs.width - (row.x + row.width)),
        `${at} の右`,
      ).toBeLessThanOrEqual(1);
      // 面の中の余白も左右で同じ (ロゴの頭と (i) の印の外)
      if (size.width === 820) continue;
      const item = page
        .locator(".live-side .channel-item")
        .filter({ has: page.getByTestId("live-channel-detail") })
        .first();
      const logo = (await item.locator(".channel .logo").boundingBox())!;
      const icon = (await item.locator(".channel-detail svg").boundingBox())!;
      const box = (await item.boundingBox())!;
      const left = logo.x - box.x;
      const right = box.x + box.width - (icon.x + icon.width);
      expect(
        Math.abs(left - right),
        `${at} の内側 (左 ${left}・右 ${right})`,
      ).toBeLessThanOrEqual(2);
    }
  });

  /*
   * **二段組にする幅は観る画面 (`/watch/<id>`) と同じ 1000px** (ヘッダーを出す幅と同じ線。`+layout.svelte` の `FILLED`)。
   * それより狭いと、縦のタブレットでも横長の窓でも映像を端から端まで出し、局の一覧をその下に積んでページごと巻く。
   * 1000px からは今までどおり横に並べ、ページごとは動かさない
   */
  test("1000px 未満は映像を幅いっぱいにし、一覧をその下に積む", async ({
    page,
  }) => {
    const shape = () =>
      page.evaluate(() => {
        const video = document
          .querySelector('[data-testid="live-frame"]')
          ?.getBoundingClientRect();
        const aside = document.querySelector("aside")?.getBoundingClientRect();
        const root = document.documentElement;
        return {
          left: Math.round(video?.left ?? -1),
          width: Math.round(video?.width ?? -1),
          below:
            video !== undefined && aside !== undefined
              ? aside.top >= video.bottom - 1
              : false,
          beside:
            video !== undefined && aside !== undefined
              ? video.right <= aside.left + 1
              : false,
          scrolls: root.scrollHeight > root.clientHeight + 1,
        };
      });
    for (const size of [
      { width: 820, height: 1180 },
      { width: 900, height: 640 },
      { width: 999, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await goto(page, "/live");
      await expect(page.getByTestId("live-channel").first()).toBeVisible();
      const at = `${size.width}x${size.height}`;
      await expect
        .poll(shape, at)
        .toMatchObject({ left: 0, width: size.width, below: true });
      // 横長の窓では一覧が画面の下にはみ出すので、ページごと巻いて見る
      if (size.height < 1000) expect((await shape()).scrolls, at).toBe(true);
    }

    await page.setViewportSize({ width: 1000, height: 700 });
    await goto(page, "/live");
    await expect(page.getByTestId("live-channel").first()).toBeVisible();
    await expect.poll(shape).toMatchObject({ beside: true, scrolls: false });
  });

  /**
   * **番組の中身は右の列を入れ替えて出す。モーダルにしない** — 映像の上に
   * 被さると観ながら読めない (観る画面と同じ考え方)。
   *
   * 開くボタンは**行とは別**に置いてある。行そのものは選局なので、あらすじを
   * 見たいだけのときにチャンネルが変わっては困る
   */
  test("右の列で番組の中身を読める。チャンネルは変わらない", async ({
    page,
  }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await expect(channels.first()).toBeVisible();
    const tuned = await page.getByTestId("live-title").textContent();

    /*
     * **引き直す前から、行が持っている分は出る。** 番組表から引き直すエンドポイントを
     * 止めておいて開く。行の分に `description: undefined` が混じると
     * `programDetail` の既定 ('') がそれで潰され、引き直せるまであらすじが
     * 空になる (#43 で型の上では塞いだ)。確かめてから通し、ラベル (ジャンル・音声) は
     * 引き直しで出る
     */
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("/api/programs/*", async (route) => {
      await held;
      await route.continue();
    });
    await page.getByTestId("live-channel-detail").first().click();
    await expect(page.getByTestId("live-detail")).toBeVisible();
    await expect(page.getByTestId("live-detail")).toContainText("のテスト番組");
    release();
    await expect(page.getByTestId("detail-badges")).toBeVisible();
    // 読んでいる間は一覧を退ける (同じ列を使う)
    await expect(page.getByTestId("live-channels")).toHaveCount(0);
    // 押したのは選局ではない。映しているものは変わらない
    await expect(page.getByTestId("live-title")).toHaveText(tuned ?? "");

    await page.getByTestId("live-detail-close").click();
    await expect(page.getByTestId("live-channels")).toBeVisible();
  });

  /*
   * **一覧は残りの高さをぜんぶ使う。** 決め打ちで切っていた頃は、画面の下に
   * 余白があるのに一覧のほうが先に終わっていた
   */
  test("チャンネル一覧は表示領域いっぱいまで伸びる", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await goto(page, "/live");
    const list = page.getByTestId("live-channels");
    await expect(list).toBeVisible();

    const box = (await list.boundingBox())!;
    const viewport = page.viewportSize()!;
    // 下端まで、余白ぶん (24px) 以上は空けない
    expect(viewport.height - (box.y + box.height)).toBeLessThanOrEqual(28);
  });

  /*
   * **一覧は種別で切り替える。** 全部縦に並べると、CS の局が 100 を超える環境で
   * 地上波が上のほうへ流れて見えなくなる。**開いたときは、いま映している局の種別**
   */
  test("チャンネル一覧を地上波/BS/CS で切り替えられる", async ({ page }) => {
    await goto(page, "/live");
    await expect(page.getByTestId("live-type-GR")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 地上波を見ているので、一覧に出るのは地上波だけ
    const shown = page.getByTestId("live-channel");
    await expect(shown.first()).toBeVisible();
    for (const channel of await shown.all()) {
      await expect(channel).toHaveAttribute("data-channel", /^GR\//);
    }

    await page.getByTestId("live-type-BS").click();
    await expect(page.getByTestId("live-type-BS")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(shown.first()).toHaveAttribute("data-channel", /^BS\//);
    // 切り替えただけでは選局しない。見ているものはそのまま
    await expect(page.getByTestId("live-title")).toBeVisible();
  });

  /*
   * **テレビに出ている番号を添える。** 地上波はリモコン番号、BS/CS は
   * サービス ID がそのまま 3 桁番号にあたる (BS朝日1=151)。局名だけだと、
   * テレビで覚えている番号から探せない。
   *
   * 並び自体は SQL の話なので `epg.test.ts` で見ている
   */
  test("チャンネルにテレビと同じ番号が出る", async ({ page }) => {
    await goto(page, "/live");
    const first = page.getByTestId("live-channel").first();
    await expect(first).toBeVisible();
    // 地上波はリモコン番号
    await expect(first.getByTestId("live-number")).toHaveText(/^\d+$/);
    // 番号は局名の頭 (ロゴの右)。ロゴの前に番号の列を取ると、狭い列で局名が潰れた
    const logo = (await first.locator(".logo").boundingBox())!;
    const number = (await first.getByTestId("live-number").boundingBox())!;
    expect(number.x).toBeGreaterThan(logo.x + logo.width);
    await expect(first.locator(".channel-name")).toContainText(
      /リモコン\s*\d+/,
    );

    await page.getByTestId("live-type-BS").click();
    await expect(page.getByTestId("live-channel").first()).toBeVisible();
    // BS は 3 桁番号
    await expect(
      page.getByTestId("live-channel").first().getByTestId("live-number"),
    ).toHaveText(/^\d{3}$/);
  });

  /*
   * **押せると分かる見た目にする。** 平らに並べていた頃は、文字が並んでいるだけに
   * 見えて押せると気付けなかった。行に枠は付けない (サイドバーの一覧) が、指の形を変え、
   * 指を乗せた行には淡い地を敷く。指でも押しやすい高さ (44px) は取る
   */
  test("チャンネルは押せると分かる見た目にする", async ({ page }) => {
    await goto(page, "/live");
    // いま映していない行で見る (映している行は初めから塗ってある)
    const row = page
      .locator('[data-testid="live-channel"][data-current="false"]')
      .first();
    await expect(row).toBeVisible();
    expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe(
      "pointer",
    );
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const fill = () =>
      row.evaluate((el) => getComputedStyle(el.closest("li")!).backgroundColor);
    const before = await fill();
    await row.hover();
    await expect.poll(fill).not.toBe(before);
  });

  /*
   * **いま映しているものが分かるようにする。** 色だけだと、色の見え方が違う人に
   * 伝わらないので、行の地 (明るさの差) で示し、読み上げには `aria-current` と文字で渡す。
   * **バッジにはしない** — 狭い列で局名と番組名を潰していた
   */
  test("選局中のチャンネルが分かる", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    const second = channels.nth(1);
    await second.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await expect(second).toHaveAttribute("data-current", "true");
    await expect(second).toHaveAttribute("aria-current", "true");
    await expect(second).toContainText("視聴中");
    await expect(page.getByTestId("live-tuned-mark")).toHaveCount(1);
    // 印は 1 つだけ。ほかの行に残っていたら、どれを見ているのか分からない
    expect(
      await page
        .locator('[data-testid="live-channel"][data-current="true"]')
        .count(),
    ).toBe(1);
  });

  /*
   * 左の縦線は行ごとではなく一覧の 1 本 (`app.css` の `.side-list`)。局を替えると前の行から滑る (docs/design.md の「動き」)。
   * ほかのテストは動きを止めて流すので、ここだけ動きを戻す
   */
  test("局を替えると、左の縦線が前の行から滑る", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    const list = page.getByTestId("live-channels");
    /** 一覧の線の上端と、行の上端 (どちらも画面の座標) */
    const mark = () =>
      list.evaluate((el) => {
        const style = getComputedStyle(el, "::after");
        const box = el.getBoundingClientRect();
        return {
          content: style.content,
          top: box.top + Number.parseFloat(style.top) - el.scrollTop,
        };
      });
    await channels.nth(0).click();
    await expect(channels.nth(0)).toHaveAttribute("data-current", "true");
    // 行には線を引かない (2 本にならない)
    expect(
      await channels
        .nth(0)
        .locator("..")
        .evaluate((el) => getComputedStyle(el, "::before").content),
    ).toBe("none");
    expect((await mark()).content).not.toBe("none");
    await page.evaluate(() => {
      const box = window as unknown as { slides: number };
      box.slides = 0;
      document.addEventListener("transitionrun", (event) => {
        if (event.propertyName === "top") box.slides++;
      });
    });
    await channels.nth(1).click();
    await expect(channels.nth(1)).toHaveAttribute("data-current", "true");
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { slides: number }).slides),
      )
      .toBeGreaterThan(0);
    // 滑り終えたら、選んだ行の高さの中にいる
    await expect
      .poll(async () => {
        const row = (await channels.nth(1).locator("..").boundingBox())!;
        const at = (await mark()).top;
        return at > row.y && at < row.y + row.height;
      })
      .toBe(true);
  });

  /*
   * **番組表で見つけた番組は、その場から観に行ける。**
   *
   * ライブ画面へ移ってから同じ局を一覧で探し直させるのは遠回りで、局が 100 を
   * 超える環境では探すほうが手間になる。**局まで名指しで渡す** — 1 つの物理
   * チャンネルには複数の局が入っているので、チャンネルだけでは足りない
   */
  test("番組表の「視聴」から、その局で開く", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await airing(page);
    await cellOf(page, target.programId).getByTestId("program-button").click();

    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    await detail.getByTestId("detail-watch").click();

    await expect(page).toHaveURL(
      new RegExp(`/live\\?service=${target.serviceId}$`),
    );
    const row = page.locator(
      '[data-testid="live-channel"][data-current="true"]',
    );
    await expect(row).toHaveAttribute("data-service", target.serviceId);
  });

  /*
   * **これから放送されるものには出さない。** 押しても、その局のいま流れている
   * 別の番組が映るだけで、押した人の用は済まない
   */
  test("これからの番組には「視聴」を出さない", async ({ page }) => {
    await goto(page, "/guide?type=GR");
    const [target] = await upcoming(page);
    await cellOf(page, target.programId).getByTestId("program-button").click();

    const detail = page.getByTestId("program-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("detail-reserve")).toBeVisible();
    await expect(detail.getByTestId("detail-watch")).toHaveCount(0);
  });

  /*
   * **局を選び直すのに繋ぎ直さない。**
   *
   * 取り決めは 1 本の WebSocket に何度でも `tune` を送れる形になっている
   * (`server/live.ts` の `attend`)。張り直していた頃は、切り替えのたびに
   * チケットを取り直して握手し直しており、実測で 100ms 掛かっていた
   */
  test("局を選び直しても繋ぎ直さない", async ({ page }) => {
    await page.addInitScript(() => {
      const counted = window as unknown as { __sockets: number };
      counted.__sockets = 0;
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          counted.__sockets += 1;
        }
      };
    });
    const sockets = () =>
      page.evaluate(
        () => (window as unknown as { __sockets: number }).__sockets,
      );

    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await channels.first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const before = await sockets();
    expect(before).toBeGreaterThan(0);

    const second = channels.nth(1);
    await second.click();
    await expect(second).toHaveAttribute("data-current", "true");

    expect(await sockets(), "局を変えるたびに繋ぎ直している").toBe(before);
  });

  /*
   * **同じ局を押し直したときこそ、答えないといけない。**
   *
   * 画面側は `tune` のたびにプレイヤーを捨てて、`tuned` と init が来てから作り直す
   * (`live-player.svelte.ts` の `forget`)。サーバが「何も変わらないから」と
   * 黙っていた頃は、**いま映している局をもう一度押すと映像が死んだ** — 塊は
   * 届き続けるので**エラーも出ないまま黒い画面**になり、実機で踏むまで
   * 気付かなかった (押した先が、開いたときに自動で選局した局だった)。
   *
   * 見るのは `tuned` の数。再エンコードは起きないので ffmpeg の数では分からず、
   * init はプレイヤーを作り直す合図そのものなので `tuned` の後ろに続く
   */
  test("いま映している局をもう一度押しても、プレイヤーを作り直せる", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const counted = window as unknown as { __tuned: number };
      counted.__tuned = 0;
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => {
            const data = (event as MessageEvent).data;
            // 多重化の頭 1 バイトが種別。0x40 が制御で、中身は 9 バイト目から JSON
            if (
              !(data instanceof ArrayBuffer) ||
              new Uint8Array(data)[0] !== 0x40
            )
              return;
            const body = new TextDecoder().decode(new Uint8Array(data, 9));
            if ((JSON.parse(body) as { type: string }).type === "tuned")
              counted.__tuned += 1;
          });
        }
      };
    });
    const tuned = () =>
      page.evaluate(() => (window as unknown as { __tuned: number }).__tuned);

    await goto(page, "/live");
    const first = page.getByTestId("live-channel").first();
    await first.click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect.poll(tuned).toBeGreaterThan(0);
    const before = await tuned();

    await expect(first).toHaveAttribute("data-current", "true");
    await first.click();

    await expect
      .poll(tuned, {
        message:
          "同じ局を押し直したのに答えが来ない (プレイヤーを作り直せない)",
      })
      .toBeGreaterThan(before);
  });

  /*
   * **データ放送 (テレビの d ボタン)。**
   *
   * 描くのはエンジン (`src/lib/bml/`) で、**押されるまで読み込まない**。作りものの放送にはデータ放送が載って
   * いないので中身は出ないが、**押してエンジンが立ち上がるところ**までは見られる。
   *
   * サーバに「出す」と伝わっているかも見る — 求められてから読み取る作りなので、
   * ここが抜けると押しても永久に何も来ない
   */
  test("d ボタンでデータ放送のエンジンが立ち上がり、サーバに伝わる", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const seen = window as unknown as {
        __data: unknown[];
        __info: unknown[];
        __got: number;
      };
      seen.__data = [];
      seen.__info = [];
      seen.__got = 0;
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => {
            const data = (event as MessageEvent).data;
            // 0x30 がデータ放送。中身は 9 バイト目から JSON (stream.md#websocket-プロトコル)
            if (
              !(data instanceof ArrayBuffer) ||
              new Uint8Array(data)[0] !== 0x30
            )
              return;
            seen.__got++;
            const message = JSON.parse(
              new TextDecoder().decode(new Uint8Array(data, 9)),
            );
            if (message.type === "programInfo") seen.__info.push(message);
          });
        }
        override send(payload: Parameters<WebSocket["send"]>[0]) {
          if (typeof payload === "string" && payload.includes('"data"')) {
            seen.__data.push(JSON.parse(payload));
          }
          super.send(payload);
        }
      };
    });
    const asked = () =>
      page.evaluate(() => (window as unknown as { __data: unknown[] }).__data);

    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const overlay = page.getByTestId("live-data");
    // 押すまでは何も読み込まない
    await expect(overlay).toHaveAttribute("data-state", "off");
    // **指のリモコンも出さない。** 押しても行き先が無い
    await expect(page.getByTestId("live-remote")).toBeHidden();

    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    // エンジンを読み込んで、立ち上がるまで
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });

    /*
     * **エンジンが立ち上がったらリモコンを出す。右の列、一覧の上。**
     *
     * 映像の上に重ねない — 放送の作った画面は枠を下まで塗り潰すので、
     * 重ねると押すものが放送の映像に埋もれる (操作バーで踏んだのと同じ)
     */
    await expect(page.getByTestId("live-remote")).toBeVisible();
    await expect(page.getByTestId("live-channels")).toBeVisible();

    /*
     * **字幕は映像と一緒に動く。**
     *
     * データ放送を出すと、映像の入れ物ごと BML の小窓へ寄せる。
     * 字幕を外に置いていた頃は、**映像だけが小窓へ行き、字幕は枠いっぱいの
     * まま**データ放送の下に隠れた (実機で「データ放送を出すと字幕が消える」)。
     * 同じ入れ物の中にあれば、テレビと同じで映像と一緒に縮む
     */
    expect(
      await page.evaluate(() => {
        const video = document.querySelector('[data-testid="live-video"]');
        const captions = document.querySelector(
          '[data-testid="live-captions"]',
        );
        const still = document.querySelector('[data-testid="live-still"]');
        return {
          字幕: captions?.parentElement === video?.parentElement,
          前のコマ: still?.parentElement === video?.parentElement,
          // 重なりは 映像 → 前のコマ → 字幕 の順 (DOM の順がそのまま)
          順番: [...(video?.parentElement?.children ?? [])].map((e) =>
            e.getAttribute("data-testid"),
          ),
        };
      }),
    ).toEqual({
      字幕: true,
      前のコマ: true,
      順番: ["live-video", "live-still", "live-captions"],
    });
    expect(await asked()).toEqual([{ type: "data", on: true }]);

    /*
     * **番組を伝えているか。** 描く側は局の番号をこれで知る (`arib-dc://` の名前を解決する・
     * NVRAM を局ごとに分ける)。web-bml の頃は、抜けているとモジュールが全部揃っていても
     * **画面が出なかった** (実機で踏んだ)
     */
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __info: unknown[] }).__info,
          ),
        {
          message: "番組 (programInfo) が来ない",
        },
      )
      .not.toEqual([]);

    /*
     * **届いたものを 1 つも落としていないか。**
     *
     * サーバは押された瞬間に、番組・PMT・溜まっているモジュールをまとめて
     * 送ってくる。ところが描く側はエンジンを落としてから立ち上がるので、
     * **その間に来たぶんは宛先が無い**。捨てていた頃は番組が真っ先に
     * 落ちて、実機では「1 局目は出ないのに、局を変えると出る」形で出た
     * (2 度目は落とし済みで待ちが無いので、間に合っていた)
     */
    await expect
      .poll(
        async () => {
          const got = await page.evaluate(
            () => (window as unknown as { __got: number }).__got,
          );
          const handed = Number(await overlay.getAttribute("data-handed"));
          return handed >= got;
        },
        { message: "エンジンが立ち上がるまでに届いたぶんを捨てている" },
      )
      .toBe(true);

    /*
     * **操作バーより下に敷いているか。**
     *
     * データ放送の面は枠いっぱいで、放送の作った画面は下まで塗り潰す。
     * 上に載せていた頃は出した瞬間に操作バーが隠れ、**そこにある d ボタンごと
     * 見えなくなって、出したら消せなくなった**。面は
     * `pointer-events-none` なので押せてはいる — 押す場所が見えないだけで、
     * 触って確かめる形では捕まらない
     */
    // 操作バーの段はボタンの並び (`[data-bar-items]`) が持つ (外の箱は持たない。`ControlBar`)
    const layers = await page.evaluate(() => {
      const z = (selector: string) =>
        Number(
          getComputedStyle(document.querySelector(selector) as Element).zIndex,
        );
      return {
        data: z('[data-testid="live-data"]'),
        controls: z('[data-testid="live-controls"] > [data-bar-items]'),
      };
    });
    expect(layers.data, "データ放送が操作バーを覆っている").toBeLessThan(
      layers.controls,
    );

    // もう一度押したら畳む。**開いたままにしない**
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect(overlay).toHaveAttribute("data-state", "off");
    await expect(page.getByTestId("live-remote")).toBeHidden();
    expect(await asked()).toEqual([
      { type: "data", on: true },
      { type: "data", on: false },
    ]);

    /*
     * **出し直せること。** エンジンは渡された要素に**影**を張る
     * ので、同じ要素を渡し直すと 2 度目で転ぶ。毎回まっさらな入れ物を
     * 作っているのはそのため
     */
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
  });

  /*
   * **Hybridcast は、載っている局でだけ出る。**
   *
   * データ放送と決定的に違うのは、**アプリが電波に乗っていない**こと。
   * 乗っているのはアドレス (URL) だけ (AIT) で、中身は放送局のサーバにある。
   * denpa は**動かさない** — 在ることと行き先を出すだけで、押すと別の
   * タブが開く ([stream.md](../../docs/stream.md#hybridcast))。
   *
   * 偽の放送では TOKYO MX にだけ AIT を載せてある (`tests/fake/services.ts`)。
   * **載せていない局で出ないこと**まで見ないと、「常に出す」でも通ってしまう
   */
  test("Hybridcast が載っている局でだけ、行き先を出す", async ({ page }) => {
    /*
     * **本当に開かせない。** 行き先は存在しない相手なので、押したら
     * 空のタブが 1 枚残るだけ。**どこへ開こうとしたか**が見たいので、
     * `window.open` の引数を控える
     */
    await page.addInitScript(() => {
      const seen = window as unknown as { __opened: string[] };
      seen.__opened = [];
      window.open = ((url?: string | URL) => {
        seen.__opened.push(String(url));
        return null;
      }) as typeof window.open;
    });
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await expect(channels.first()).toBeVisible();

    // 局は名前ではなく ID で指す。名前は SDT 由来で、表示のしかたに引きずられる
    const mx = page.locator(
      `[data-testid=live-channel][data-service="${SERVICES[0]!.id}"]`,
    );
    await mx.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const button = page.getByTestId("live-hybridcast");
    // AIT は表なので、繋いでから流れてくるまで少し待つ
    await expect(button).toBeVisible({ timeout: 15_000 });
    // **名前は放送が付けたもの。** 何のアプリなのかは局しか知らない
    await expect(button).toHaveAttribute("aria-label", /テスト連動/);

    /*
     * **押すと別のタブ。** denpa の中では開かない — 受信機の API を
     * 用意していないので、中で開くと「動くもの」に見えてしまう
     */
    await button.click();
    expect(
      await page.evaluate(
        () => (window as unknown as { __opened: string[] }).__opened,
      ),
    ).toEqual(["https://hybridcast.example.jp/app.html"]);

    // 載せていない局に移ると消える。**前の局のぶんを出したままにしない**
    const other = page.locator(
      `[data-testid=live-channel][data-service="${SERVICES[1]!.id}"]`,
    );
    await other.click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect(button).toBeHidden();
  });

  /*
   * **郵便番号と都道府県は、設定画面からデータ放送へ渡る。**
   *
   * 放送のアプリはこれを読んで、天気・地域のニュース・防災情報をどこの
   * ものにするかを決める (`nvram://receiverinfo/zipcode`・`receiverinfo/prefecture`)。置き場はサーバ —
   * 家の場所は端末では変わらないので、端末ごとに訊き直さない。エンジンには
   * 受信機の設定として渡す (`DataBroadcast` の `receiver`)。
   *
   * 確かめるのは放送のアプリと同じ経路: 流した BML のスクリプトが `readPersistentArray` で
   * 読んだものを画面に書く。**web-bml の頃に端末へ直に置いていた鍵** (`denpa_bml_denpa_nvram_…`・
   * `denpa_bml_engine`) が残っていても、読まれないことも見る
   */
  test("設定した郵便番号と都道府県が、データ放送に渡る", async ({ page }) => {
    const READER = [
      '<p id="zip" style="left:0px;top:0px;width:400px;height:40px;color-index:7;">-</p>',
      "<script><![CDATA[",
      'var zip = browser.readPersistentArray("nvram://receiverinfo/zipcode", "S:7B");',
      'var pref = browser.readPersistentArray("nvram://receiverinfo/prefecture", "U:1B");',
      'document.getElementById("zip").firstChild.data = "z" + zip[0] + "p" + pref[0];',
      "]]></script>",
    ].join("\n");
    const readZip = async (): Promise<string | null | undefined> => {
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      const overlay = page.getByTestId("live-data");
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-data-button").click();
      await expect(overlay).toHaveAttribute("data-state", "ready", {
        timeout: 15_000,
      });
      await expect
        .poll(async () => Number(await overlay.getAttribute("data-handed")))
        .toBeGreaterThan(0);
      await feedData(page, fakeDataBroadcast(READER));
      await expect
        .poll(async () => (await dataElement(page, "span"))?.text ?? "-")
        .not.toBe("-");
      return (await dataElement(page, "span"))?.text;
    };
    await captureSockets(page);

    await goto(page, "/settings/reception");
    // web-bml の頃の鍵を残しておく (別の番号。読まれたら食い違う)
    await page.evaluate(() => {
      localStorage.setItem(
        "denpa_bml_denpa_nvram_prefix=receiverinfo%2Fzipcode",
        btoa("9999999"),
      );
      localStorage.setItem("denpa_bml_engine", "web-bml");
    });
    // ハイフン付きで入れても、数字 7 桁として読む
    await page.getByTestId("postal-code").fill("100-0001");
    // 郵便番号は欄を離れたとき (Tab・Enter) にその場で保存する
    await page.getByTestId("postal-code").press("Tab");
    // 番号は ARIB の県域。東京都は 14 (JIS の 13 ではない。`#lib/prefecture.ts`)
    await page.getByTestId("prefecture").selectOption({ label: "東京都" });
    await expect(page.getByTestId("saved-result")).toBeVisible();
    await expect(page.getByTestId("postal-code")).toHaveValue("1000001");
    await expect(page.getByTestId("prefecture")).toHaveValue("14");
    expect(await readZip()).toBe("z1000001p14");

    /*
     * **消したら残さない。** 引っ越したのに前の番号のままだと、
     * 直したつもりで直っていないことになる
     */
    await goto(page, "/settings/reception");
    await page.getByTestId("postal-code").fill("");
    await page.getByTestId("postal-code").press("Tab");
    await page.getByTestId("prefecture").selectOption("255");
    await expect(page.getByTestId("saved-result")).toBeVisible();
    await expect(page.getByTestId("postal-code")).toHaveValue("");
    await expect(page.getByTestId("prefecture")).toHaveValue("255");
    // 未設定は 255 (受信機の設定で「設定されていない」)
    expect(await readZip()).toBe("zp255");
  });

  /*
   * **局を変えたら、データ放送も作り直す。**
   *
   * エンジンは一度に一つの放送しか持たない (カルーセルも覚えるものも局ごと)。
   * 作り直さずにいると**前の局の文書が残り**、映像が前の局の小窓に寄せられたままになる
   * (web-bml の頃、実機で「d を押したあと局を変えると、映像が左上に潰れる」形で出た)
   */
  test("局を変えたら、データ放送を作り直す", async ({ page }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await expect(channels.first()).toBeVisible();
    if ((await channels.count()) < 2) test.skip();

    const first = await channels.nth(0).getAttribute("data-channel");
    const second = await channels.nth(1).getAttribute("data-channel");
    expect(first).not.toBe(second);

    await channels.nth(0).click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const overlay = page.getByTestId("live-data");
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    const before = await overlay.getAttribute("data-for");
    expect(before).toContain(first);

    await channels.nth(1).click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    // 局が変われば、エンジンも別のものになっている
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    await expect
      .poll(() => overlay.getAttribute("data-for"), {
        message: "データ放送が前の局のまま",
      })
      .toContain(second as string);

    // **映像は枠に戻っている** (前の局の小窓に寄せたままにしない。偽の放送には小窓が無い)
    await expect(
      page.locator('[data-testid="live-video"]').locator(".."),
    ).not.toHaveAttribute("data-bml-window", "");
  });

  /*
   * **渡す前に 1 局へ絞る。**
   *
   * ffmpeg は名指しした局を `-probesize` のぶん読む間に見つけられなければ、
   * **そのまま終了する**。実機の tvk (T15。tvk1/2/3 + ワンセグ + データで、
   * 局ごとに 14 本以上のストリーム) では 400KB でも足りずに降りていた。
   *
   * わざと probesize を下げて T15 で測ると、丸ごと渡す方式は 120KB でも
   * 3 回中 1 回しか通らないのに、**1 局に絞れば 20KB で 3 回とも通る**。
   * 絞るのは録画と同じ `ServiceFilter`。
   *
   * ここで見るのは**渡ったものの PAT に局が 1 つしか無いこと**。絞り忘れても
   * 映像は出てしまう (実機では出ないことがある、という形の壊れ方をする) ので、
   * 渡した中身そのものを見る
   */
  test("ffmpeg に渡すのは、その局だけの TS", async ({ page, stack }) => {
    rmSync(stack.liveTsFile, { force: true });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    let programs: number[] = [];
    await expect(() => {
      expect(existsSync(stack.liveTsFile)).toBe(true);
      programs = patPrograms(readFileSync(stack.liveTsFile));
      expect(programs.length, "PAT がまだ来ていない").toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });

    expect(
      new Set(programs).size,
      `局が ${[...new Set(programs)].join(",")} と複数ある`,
    ).toBe(1);
  });

  /*
   * **エンコードできなくなったら、その場で言う。**
   *
   * ffmpeg が入口で降りても何も伝えていなかった頃は、画面には**前のコマが
   * 貼られたまま 6 秒たって黒くなる**だけだった (`live-player` の `HOLD_MOST`)。
   * 見た目は「切り替えに 6 秒かかった」で、実際には失敗しているのに、
   * そうとは分からない出方をする。
   *
   * 実機で出たのは tvk (T15) — 局が 3 つ入っている TS で `-probesize` が
   * 足りず、`-map 0:p:24632:v:0` を解決できないまま降りていた
   */
  test("エンコードできなくなったら、黙って消えずに理由を出す", async ({
    page,
    stack,
  }) => {
    writeFileSync(stack.liveFailFile, "1");
    try {
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();

      const status = page.getByTestId("live-status");
      await expect(status).toContainText("映像を出せませんでした", {
        timeout: 15_000,
      });
      // やり直せること。押せないと、開き直すしかなくなる
      await expect(page.getByTestId("live-retry")).toBeVisible();
    } finally {
      rmSync(stack.liveFailFile, { force: true });
    }
  });

  /*
   * **出せない形式でも、エンコード方式を選び直すボタンは残す。**
   *
   * 失敗している間は操作バーを隠していた頃は、「再生できる形式がありません」
   * と出たきり、別の形式 (や放送のままの MPEG-2) へ逃げる手立てが無かった
   */
  test("出せない形式でも、操作バーからエンコード方式を選び直せる", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      MediaSource.isTypeSupported = () => false;
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();

    await expect(page.getByTestId("live-status")).toContainText(
      "再生できる形式がありません",
      {
        timeout: 15_000,
      },
    );
    await wakeControls(page, "live-frame");
    await expect(page.getByTestId("live-controls")).toBeVisible();
    await openSettings(page, "live");
    await page.getByTestId("live-codec").click();
    await expect(
      page.locator('[data-testid="live-codec-option"][data-codec="av1"]'),
    ).toBeVisible();
  });

  /*
   * **iPhone の Safari には MediaSource が無く、ManagedMediaSource だけがある。**
   *
   * 本物は Chromium に無いので、MediaSource を消して同じものを ManagedMediaSource の
   * 名前で置く。見るのは「MediaSource が開いた」(尺が無限になる) と、**開くのに要る
   * `disableRemotePlayback` を立てた**こと
   */
  test("MediaSource が無くても ManagedMediaSource で出す", async ({ page }) => {
    await page.addInitScript(() => {
      const scope = window as unknown as {
        MediaSource?: unknown;
        ManagedMediaSource?: unknown;
      };
      scope.ManagedMediaSource = window.MediaSource;
      delete scope.MediaSource;
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await expect(async () => {
      const seen = await page.getByTestId("live-video").evaluate((v) => {
        const video = v as HTMLVideoElement;
        return {
          duration: video.duration,
          remote: video.disableRemotePlayback,
        };
      });
      expect(seen).toEqual({
        duration: Number.POSITIVE_INFINITY,
        remote: true,
      });
    }).toPass({ timeout: 15_000 });
  });

  /*
   * **開いたら、いま映しているものまで送っておく。** 局が 100 を超える環境では
   * 覚えていた局が画面の外にあるほうが普通で、探させるのはテレビを点けたときの
   * 振る舞いから遠い
   */
  test("開くと、選局中のチャンネルまでスクロールしてある", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    // 下のほうの局を選んでから開き直す
    const last = channels.last();
    const picked = await last.getAttribute("data-channel");
    await last.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await goto(page, "/live");
    const row = page.locator(
      `[data-testid="live-channel"][data-channel="${picked}"]`,
    );
    await expect(row).toHaveAttribute("data-current", "true");
    // 一覧の見えている範囲に入っていること
    const inside = await row.evaluate((el) => {
      const list = el.closest('[data-testid="live-channels"]');
      if (list === null) return false;
      const a = el.getBoundingClientRect();
      const b = list.getBoundingClientRect();
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    });
    expect(inside).toBe(true);
  });

  /*
   * **備え付けの操作は出さない。** あれの再生位置は「持っている範囲」を尺として
   * 描くので、0.05 秒ごとに中身が届くたびに右へ左へ動く。放送に終わりは無いので、
   * 位置ではなく張り付いているかどうかを出す
   */
  test("自前の操作バーを出し、備え付けは使わない", async ({ page }) => {
    await goto(page, "/live");
    await expect(page.getByTestId("live-video")).not.toHaveAttribute(
      "controls",
      /.*/,
    );
    await expect(page.getByTestId("live-controls")).toBeVisible();
    await expect(page.getByTestId("live-edge")).toBeVisible();
    await expect(page.getByTestId("live-play")).toBeVisible();
    // 張り付いているかは色だけでなく読み上げにも渡す
    await expect(page.getByTestId("live-edge")).toHaveAttribute(
      "aria-pressed",
      /^(true|false)$/,
    );

    /*
     * **放送の今にいる間は右端に張り付く。** 実際には貯めているぶん後ろに
     * いるが、そこを描くとバッファが増えるたびに摘みが左へ動く — 見ている人には
     * 「勝手に戻っている」としか映らない
     */
    const bar = page.getByTestId("live-seek");
    const at = await bar.evaluate((el) => {
      const input = el as HTMLInputElement;
      return { value: input.value, max: input.max };
    });
    expect(at.value).toBe(at.max);

    /*
     * **アイコンは既存の画面と同じ書き方に揃える** (インラインの SVG)。
     * 絵文字にしていた頃は、端末ごとに形も大きさも変わっていた
     */
    expect(await page.getByTestId("live-play").locator("svg").count()).toBe(1);
    expect(await page.getByTestId("live-sound").locator("svg").count()).toBe(1);
    expect(await page.getByTestId("live-full").locator("svg").count()).toBe(1);
  });

  /**
   * **ライブの切り抜きもサーバに保存する。** 送るのは局と映していたコマの放送時刻だけで、
   * 番組名と局名はサーバが番組表から引いて写しておく
   */
  test("切り抜きはサーバに保存し、番組名はサーバが番組表から引く", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await fakeFrame(page, "live-video");
    await wakeControls(page, "live-frame");
    const clip = await takeClip(page, "live-shot");
    expect(clip.place).toBe("live");
    expect(clip.serviceName).not.toBe("");
    expect(clip.programName).not.toBe("");
    expect(clip.offsetMs).toBeGreaterThanOrEqual(0);
  });
});
