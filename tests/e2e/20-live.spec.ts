import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { BS11, BS_NO_LOGO, MX, SERVICES } from "../fake/services";
import {
  airing,
  CAPTION_SCREENS,
  captionsClearOfBar,
  captureSockets,
  cellOf,
  dataElement,
  expect,
  expectSharpCaptions,
  expectSideAligned,
  expectSideFrame,
  fakeDataBroadcast,
  feedCaption,
  feedData,
  flipSetting,
  goto,
  holdCaptions,
  leaveFullscreen,
  oneRowTroubles,
  openSettings,
  overlayTroubles,
  pickCodec,
  syncEpg,
  test,
  upcoming,
  wakeControls,
} from "./helpers";

/**
 * 偽 ffmpeg が残した引数を1回ぶんずつに切って、最後の1回を返す。
 *
 * **ライブ視聴で起きる ffmpeg は1本。** 映像も字幕も同じ1本がエンコードする
 * (そうしないと時刻が揃わない。`server/captions.ts`)。同じファイルに選局の
 * たびに足していくので (`tests/fake/ffmpeg.sh`)、見るのはいちばん新しい1回
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
 * TS の PAT に並んでいる局の番号。**丸ごと来ていれば複数、絞ってあれば1つ。**
 *
 * PAT は PID 0。`[pointer][table_id=0][...12バイト...][局2バイト][PMT の PID 2バイト]…`
 * で、末尾4バイトが CRC。区切りが1パケットに収まる大きさなので、組み立ては要らない
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
 * 2つが寸分同じ枠にあること。**組み上がりを待つ。**
 *
 * 開いた直後は幅が決まりきっていないので、1回だけ見比べると稀に外れる
 * (実際に flaky で落ちた)
 */
async function sameBox(
  a: Locator,
  b: Locator,
  expect_: typeof expect,
): Promise<void> {
  await expect_(async () => {
    expect_(await a.boundingBox()).toEqual(await b.boundingBox());
  }).toPass({ timeout: 5_000 });
}

/**
 * ライブ視聴 ([docs/stream.md](../../docs/stream.md#ライブ))。映像・音声・字幕まで。
 *
 * **映像が出るところまでは見ない。** E2E の ffmpeg は偽物で、流れてくるのも
 * 本物の TS ではないため、MSE が受け取れる fMP4 にはならず、字幕も1枚も出ない。
 * ここで固定するのはその手前まで — **チケットを取り、WebSocket が繋がり、チューナーを
 * 使い、選んだ局が「いま映しているもの」になる**という経路と、**ffmpeg に何を
 * 渡したか**。エンコードしたものが正しいかどうかは実機で測る話になる。
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
     * 決めるので、1件目が出た直後だと 1 のまま落ちる (実際に揺れていた)
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
     * 伸びていた (映像の色が付いて右の列が `position: relative` になるまでの1秒ほど)。
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
    page,
  }) => {
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
   * **一覧は種別で切り替える。** 全部縦に並べると、CS の局が100を超える環境で
   * 地上波が上のほうへ流れて見えなくなる。**開いたときは、いま映している局の種別**
   */
  test("チャンネル一覧を地上波/BS/CSで切り替えられる", async ({ page }) => {
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
   * サービスID がそのまま3桁番号にあたる (BS朝日1=151)。局名だけだと、
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
    // BS は3桁番号
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
    // 印は1つだけ。ほかの行に残っていたら、どれを見ているのか分からない
    expect(
      await page
        .locator('[data-testid="live-channel"][data-current="true"]')
        .count(),
    ).toBe(1);
  });

  /*
   * **番組表で見つけた番組は、その場から観に行ける。**
   *
   * ライブ画面へ移ってから同じ局を一覧で探し直させるのは遠回りで、局が100を
   * 超える環境では探すほうが手間になる。**局まで名指しで渡す** — 1つの物理
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
   * 取り決めは1本の WebSocket に何度でも `tune` を送れる形になっている
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
            // 多重化の頭1バイトが種別。0x40 が制御で、中身は9バイト目から JSON
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
            // 0x30 がデータ放送。中身は9バイト目から JSON (stream.md#websocket-プロトコル)
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
     * 重ねると押すものが放送の映像に埋もれる (操作列で踏んだのと同じ)
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
     * **届いたものを1つも落としていないか。**
     *
     * サーバは押された瞬間に、番組・PMT・溜まっているモジュールをまとめて
     * 送ってくる。ところが描く側はエンジンを落としてから立ち上がるので、
     * **その間に来たぶんは宛先が無い**。捨てていた頃は番組が真っ先に
     * 落ちて、実機では「1局目は出ないのに、局を変えると出る」形で出た
     * (2度目は落とし済みで待ちが無いので、間に合っていた)
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
     * **操作列より下に敷いているか。**
     *
     * データ放送の面は枠いっぱいで、放送の作った画面は下まで塗り潰す。
     * 上に載せていた頃は出した瞬間に操作列が隠れ、**そこにある d ボタンごと
     * 見えなくなって、出したら消せなくなった**。面は
     * `pointer-events-none` なので押せてはいる — 押す場所が見えないだけで、
     * 触って確かめる形では捕まらない
     */
    const layers = await page.evaluate(() => {
      const z = (name: string) =>
        Number(
          getComputedStyle(
            document.querySelector(`[data-testid="${name}"]`) as Element,
          ).zIndex,
        );
      return { data: z("live-data"), controls: z("live-controls") };
    });
    expect(layers.data, "データ放送が操作列を覆っている").toBeLessThan(
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
     * ので、同じ要素を渡し直すと2度目で転ぶ。毎回まっさらな入れ物を
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
     * 空のタブが1枚残るだけ。**どこへ開こうとしたか**が見たいので、
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

    // 局は名前ではなくIDで指す。名前は SDT 由来で、表示のしかたに引きずられる
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
    // ハイフン付きで入れても、数字7桁として読む
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
   * **渡す前に1局へ絞る。**
   *
   * ffmpeg は名指しした局を `-probesize` のぶん読む間に見つけられなければ、
   * **そのまま終了する**。実機の tvk (T15。tvk1/2/3 + ワンセグ + データで、
   * 局ごとに14本以上のストリーム) では 400KB でも足りずに降りていた。
   *
   * わざと probesize を下げて T15 で測ると、丸ごと渡す方式は 120KB でも
   * 3回中1回しか通らないのに、**1局に絞れば 20KB で3回とも通る**。
   * 絞るのは録画と同じ `ServiceFilter`。
   *
   * ここで見るのは**渡ったものの PAT に局が1つしか無いこと**。絞り忘れても
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
   * 貼られたまま6秒たって黒くなる**だけだった (`live-player` の `HOLD_MOST`)。
   * 見た目は「切り替えに6秒かかった」で、実際には失敗しているのに、
   * そうとは分からない出方をする。
   *
   * 実機で出たのは tvk (T15) — 局が3つ入っている TS で `-probesize` が
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
   * 失敗している間は操作列を隠していた頃は、「再生できない形式です」
   * と出たきり、別の形式 (や放送のままの MPEG-2) へ逃げる手立てが無かった
   */
  test("出せない形式でも、操作列からエンコード方式を選び直せる", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      MediaSource.isTypeSupported = () => false;
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();

    await expect(page.getByTestId("live-status")).toContainText(
      "再生できない形式です",
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
   * **開いたら、いま映しているものまで送っておく。** 局が100を超える環境では
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
   * 描くので、0.05秒ごとに中身が届くたびに右へ左へ動く。放送に終わりは無いので、
   * 位置ではなく張り付いているかどうかを出す
   */
  test("自前の操作列を出し、備え付けは使わない", async ({ page }) => {
    await goto(page, "/live");
    await expect(page.getByTestId("live-video")).not.toHaveAttribute(
      "controls",
      /.*/,
    );
    await expect(page.getByTestId("live-controls")).toBeVisible();
    await expect(page.getByTestId("live-edge")).toBeVisible();
    await expect(page.getByTestId("live-play")).toBeVisible();

    /*
     * **放送の今にいる間は右端に張り付く。** 実際には貯めているぶん後ろに
     * いるが、そこを描くと溜まりが増えるたびに摘みが左へ動く — 見ている人には
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

  /*
   * **しばらく触らなければ消える。** 映像の上に居座るものなので、見ている間は
   * 引っ込んでいるほうがいい。**止めていても消えます** — 一時停止するのは
   * 映像の中の文字をじっくり見るためで、そこに操作バーが残っていては止めた意味が無い
   */
  test("操作列は触らないでいると消え、動かすと戻る", async ({ page }) => {
    await goto(page, "/live");
    const controls = page.getByTestId("live-controls");
    await expect(controls).toHaveAttribute("data-shown", "true");

    await page.mouse.move(400, 300);
    await expect(controls).toHaveAttribute("data-shown", "true");
    await expect(controls).toHaveAttribute("data-shown", "false", {
      timeout: 6000,
    });
    await page.mouse.move(420, 320);
    await expect(controls).toHaveAttribute("data-shown", "true");

    // 止めていても消える。押した直後は出ている (押したものが見えないと困る)
    await page.getByTestId("live-play").click();
    await expect(controls).toHaveAttribute("data-shown", "true");
    await expect(controls, "止めていても放っておけば消える").toHaveAttribute(
      "data-shown",
      "false",
      {
        timeout: 6000,
      },
    );
  });

  /*
   * **指で触ったら出て、離してもその場では消えない。消えるのはマウスと同じ長さ。**
   *
   * 指を離すとブラウザはポインタを取り下げるので、`pointerleave` が**触った
   * 直後に必ず飛ぶ**。マウスと同じに「出ていったら消す」で扱っていたので、
   * タッチの端末では**触った瞬間に操作列が消えて**いた — 操作バーに触れる間が無い。
   *
   * 押すまで留めていた時期もあるが、**消したいときに毎回映像を押すことになった**。
   * 出し方は指とマウスで違ってよいが、消え方は同じでいい
   */
  test("指で触ったら出て、しばらくで消える (マウスと同じ長さ)", async ({
    browser,
  }) => {
    // 指のある端末として開く。既定の枠にはタッチが無く、tap そのものが使えない
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    await goto(page, "/live");
    const controls = page.getByTestId("live-controls");
    // いったん消えるまで待つ。出たままのところから始めると何も分からない
    await expect(controls).toHaveAttribute("data-shown", "false", {
      timeout: 6000,
    });

    const box = (await page.getByTestId("live-video").boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.touchscreen.tap(at.x, at.y);

    // 指を離したあとも出ている。ここが直る前は、離した時点で消えていた
    await expect(controls).toHaveAttribute("data-shown", "true");
    // そのまま置いておけば、マウスと同じ 2.5 秒で引っ込む
    await expect(controls, "指でも放っておけば消える").toHaveAttribute(
      "data-shown",
      "false",
      {
        timeout: 6000,
      },
    );
    await context.close();
  });

  /*
   * 止める・再開するの繋がりだけ見る。
   *
   * **「止めた所から見られる」ところまでは、ここでは確かめられない。** 偽の
   * ffmpeg が流すものは MSE が受け取れないので、そもそも再生が始まらず、
   * 位置も動かない。動く中身での確認は実機で行う
   */
  test("止める・再開するが繋がっている", async ({ page }) => {
    await goto(page, "/live");
    const button = page.getByTestId("live-play");
    await expect(button).toBeVisible();

    await expect(button).toHaveAttribute("aria-label", "一時停止");
    await button.click();
    await expect(button).toHaveAttribute("aria-label", "再生");
    await button.click();
    await expect(button).toHaveAttribute("aria-label", "一時停止");
  });

  /*
   * **小窓 (PiP) で観られる。小窓で押した止める・再開は操作バーにも写る。**
   *
   * 小窓の再生ボタンは `<video>` を直に止めるが、ライブは「止めているか」を player 側で
   * 持っている (`live-player` の `paused`)。合わせないと、小窓で止めたのに操作バーは
   * 「一時停止」のまま、押すと止まっている映像をもう一度止めることになる。
   *
   * 偽の ffmpeg が流すものは MSE が受け取れず再生が始まらない (上) ので、ブラウザの
   * 小窓の API は差し替えて、押された・出た・閉じたの繋がりだけを見る
   */
  test("小窓で観られ、小窓で止めると操作バーも止まる", async ({ page }) => {
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
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await wakeControls(page, "live-frame");
    const pip = page.getByTestId("live-pip");
    await expect(pip).toHaveAttribute("aria-label", "小窓で観る");
    await pip.click();
    await expect(pip).toHaveAttribute("aria-pressed", "true");
    await expect(pip).toHaveAttribute("aria-label", "小窓をやめる");
    expect(
      await page
        .getByTestId("live-video")
        .evaluate((v) => document.pictureInPictureElement === v),
    ).toBe(true);

    // 小窓の再生ボタンで止める・再開する (`<video>` が直に止まり、`pause` / `play` が来る)
    const play = page.getByTestId("live-play");
    const press = (paused: boolean) =>
      page.getByTestId("live-video").evaluate((v, paused) => {
        Object.defineProperty(v, "paused", {
          configurable: true,
          get: () => paused,
        });
        v.dispatchEvent(new Event(paused ? "pause" : "play"));
      }, paused);
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await press(true);
    await expect(play).toHaveAttribute("aria-label", "再生");
    await press(false);
    await expect(play).toHaveAttribute("aria-label", "一時停止");

    await wakeControls(page, "live-frame");
    await pip.click();
    await expect(pip).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(() => document.pictureInPictureElement),
    ).toBeNull();
  });

  /*
   * **断られたら理由を出す。** 黙って何も起きないと、どこで転んだのか端末の上で
   * 見分けられない (iPhone の Safari で、MPEG-2 のときだけ出なかった)
   */
  test("小窓を断られたら、理由をトーストで言う", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Document.prototype, "pictureInPictureEnabled", {
        get: () => true,
      });
      HTMLVideoElement.prototype.requestPictureInPicture = async () => {
        throw new DOMException("ユーザーの操作が要る", "NotAllowedError");
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await wakeControls(page, "live-frame");
    await page.getByTestId("live-pip").click();
    await expect(
      page.getByText(
        "小窓を出せませんでした: ブラウザに許可されませんでした (NotAllowedError",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("live-pip")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /*
   * **出せない端末ではボタンを出さない。** iPhone・iPad のホーム画面から開いたもの (PWA) は、
   * API は有るように見えるのに Safari が小窓を許していない。ページから開かせる API の無いブラウザも出さない
   * (ブラウザ自身の小窓の切り替えは別に使える)
   */
  test("小窓を出せない端末では、小窓のボタンを出さない", async ({
    browser,
  }) => {
    for (const script of [
      // iPhone のホーム画面から開いた
      () =>
        Object.defineProperty(Navigator.prototype, "standalone", {
          get: () => true,
        }),
      // ページから開かせる API が無い
      () =>
        Object.defineProperty(Document.prototype, "pictureInPictureEnabled", {
          get: () => false,
        }),
    ]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(script);
      await goto(page, "/live");
      await expect(page.getByTestId("live-full")).toBeVisible();
      await expect(page.getByTestId("live-pip")).toHaveCount(0);
      await context.close();
    }
  });

  /*
   * **iPhone の全画面は、枠を画面いっぱいに広げて代わりにする** (#471。`fullscreen.svelte.ts`)。
   * 要素の全画面の API を消して iPhone の横持ち (844x390) に見立てる。字幕の面とデータ放送の
   * 入れ物は枠から測るので、広げても映像に重なったまま。出口は同じボタン・Esc・戻る
   */
  test("全画面の API が無い端末では、枠を画面いっぱいに広げる", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      // iPhone の横持ち (指の端末。下のタブは映像の画面では隠れる)
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      for (const proto of [Element.prototype, HTMLElement.prototype]) {
        delete (proto as Partial<Element>).requestFullscreen;
        delete (proto as { webkitRequestFullscreen?: unknown })
          .webkitRequestFullscreen;
      }
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const stage = page.getByTestId("live-frame");
    const full = page.getByTestId("live-full");
    const enter = async () => {
      await wakeControls(page, "live-frame");
      await full.click();
      await expect(stage).toHaveAttribute("data-pseudo", "");
      await expect
        .poll(() => stage.boundingBox())
        .toEqual({ x: 0, y: 0, width: 844, height: 390 });
      await expect(page.locator("html")).toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面をやめる");
    };
    const restored = async () => {
      await expect(stage).not.toHaveAttribute("data-pseudo", "");
      await expect
        .poll(async () => (await stage.boundingBox())?.width)
        .toBeLessThan(844);
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-stage-fullscreen",
        "",
      );
      await expect(full).toHaveAttribute("aria-label", "全画面");
      await expect(page).toHaveURL(/\/live/);
    };

    await enter();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    // 字幕の面は映像と同じ枠、映像は枠いっぱい。操作列は画面の中
    await sameBox(
      page.getByTestId("live-captions"),
      page.getByTestId("live-video"),
      expect,
    );
    expect(await page.getByTestId("live-video").boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: 844,
      height: 390,
    });
    await wakeControls(page, "live-frame");
    const bar = (await full.boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(390);

    // 同じボタンで出る
    await wakeControls(page, "live-frame");
    await full.click();
    await restored();

    // Esc で出る
    await enter();
    await page.keyboard.press("Escape");
    await restored();

    // 戻るで出る。画面は離れない
    await enter();
    await page.evaluate(() => history.back());
    await restored();
    await context.close();
  });

  /*
   * **バックグラウンド再生は既定で切。** 裏に回すと止め、戻ると再開する。OS が勝手に小窓に
   * しないよう `disablePictureInPicture` も立てておく (全画面からホームへ戻っただけで小窓が
   * 出て鳴り続けていた)。入れれば裏でも止めず、端末ごとに覚える (`background.svelte.ts`)。
   *
   * 裏に回るのはページの外の出来事なので、`visibilityState` を差し替えて通知だけ送る
   */
  test("バックグラウンド再生は既定で切。裏に回すと止まり、入れると止まらない", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const turn = (state: "hidden" | "visible") =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => state,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    const guarded = () =>
      page
        .getByTestId("live-video")
        .evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture);
    const play = page.getByTestId("live-play");

    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect.poll(guarded).toBe(true);
    await turn("hidden");
    await expect(play).toHaveAttribute("aria-label", "再生");
    await turn("visible");
    await expect(play).toHaveAttribute("aria-label", "一時停止");

    await wakeControls(page, "live-frame");
    const toggle = page.getByTestId("live-background");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await flipSetting(page, "live", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(guarded).toBe(false);
    await turn("hidden");
    // 止まらない (止めるなら通知を受けたその場で止めている)
    await page.waitForTimeout(500);
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await turn("visible");

    // 端末ごとに覚える。開き直しても入のまま
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await expect(page.getByTestId("live-background")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  /*
   * **放送に終わりは無いと言っておく。** 何も言わないと MediaSource の尺は
   * 「いま持っている中でいちばん後ろ」になり、0.2秒ごとに中身が届くたびに
   * 伸びる。備え付けの再生位置が右端まで行っては少し左へ戻る、を繰り返す
   */
  test("再生位置に終わりを作らない", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    await expect(async () => {
      const duration = await page
        .getByTestId("live-video")
        .evaluate((v) => (v as HTMLVideoElement).duration);
      expect(duration).toBe(Number.POSITIVE_INFINITY);
    }).toPass({ timeout: 15_000 });
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
   * 1つの物理チャンネルに複数の局が入っているので局を名指しするのだが、
   * 渡す番号を間違えると ffmpeg はその局を探して見つけられず、**映像も音も
   * 出ない**。denpa の `services.id` は `network_id * 100000 + service_id` の
   * 内部IDで、TS の中には出てこない — 実際にこれを渡して再生できなくなった。
   */
  test("局は放送が名乗っている番号で名指しする", async ({ page, stack }) => {
    await goto(page, "/live");
    const target = page.getByTestId("live-channel").first();
    await target.click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const args = await ffmpegArgs(stack.liveArgsFile, expect);

    // 名指ししている先が、内部IDではなく放送の番号になっていること
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
   * 選べるものは番組ごとに違う (二カ国語なら主/副/主+副、解説放送なら音声が2本)
   * ので、いま流れている番組から起こす (`arib.audioTracks`)。偽の放送は解説付きの
   * ステレオ2本 — 実機によくある構成で、**どちらも `component_type=3` の日本語**。
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
   * **同じ構成の音声が2本あっても、見分けが付くようにする。**
   *
   * 解説放送はどちらも `component_type=3` の日本語なので、符号だけを見ていた
   * 頃は**「ステレオ (日本語)」が2つ**並んで、どちらが何なのか分からなかった
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
    // 既定は H.264。どの端末でも出るほうから始める
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
    // 広い枠では何も畳まないので、⚙ の頭に操作バーのもの (消音・小窓) は並ばない
    await expect(page.getByTestId("live-mute")).toHaveCount(0);
    await expect(page.getByTestId("live-pip-mode")).toHaveCount(0);
    await expect(gear).toHaveAttribute("aria-haspopup", "menu");
    await gear.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("role", "menu");

    // 先頭はアンビエントモード (ライブに CMスキップは無い)。Enter で切り替わり、閉じない
    const ambient = page.getByTestId("live-ambient");
    await expect(ambient).toBeFocused();
    await expect(ambient).toHaveAttribute("role", "menuitemcheckbox");
    const before = await ambient.getAttribute("aria-checked");
    await page.keyboard.press("Enter");
    await expect(ambient).not.toHaveAttribute("aria-checked", before ?? "");
    await expect(menu).toBeVisible();

    // コーデックは行にいまの値を出し、→ で選択肢の並びに入る (選んでいるものにフォーカス)
    const codec = page.getByTestId("live-codec");
    await expect(codec).toContainText("H.264");
    await codec.focus();
    await page.keyboard.press("ArrowRight");
    const h264 = page.locator(
      '[data-testid="live-codec-option"][data-codec="h264"]',
    );
    await expect(h264).toBeFocused();
    await expect(h264).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("live-settings-back")).toBeVisible();

    // Esc は上の並びへ (閉じない)。戻るとコーデックの行に居る
    await page.keyboard.press("Escape");
    await expect(menu).toBeVisible();
    await expect(codec).toBeFocused();
    // もう一度 Esc で閉じて、⚙ に戻る
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(gear).toBeFocused();
  });

  /*
   * **切り替えの間、前のコマを貼っておく場所を持っておく。**
   *
   * 選局にかかる 1.6 秒は削れない (電波の同期待ち 0.65秒 + 放送の MPEG-2 が
   * GOP の頭を待つ 0.75秒)。待ちは変わらないが、その間を真っ黒にしないために
   * 直前の1枚を canvas へ写して重ねる。
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
    await sameBox(still, page.getByTestId("live-video"), expect);
  });

  /*
   * **放送の字幕は `<track>` ではなく canvas に描いて重ねる** (放送に乗っているのは文字と
   * 描き方の指定で、テレビはそれを見て毎回自分で描く。サーバが置き場所まで決めた文字の配置を
   * 送るので、録画で見る字幕と同じ所に出る)。
   *
   * 偽の放送に字幕は乗っていないので、ここで見られるのは敷き方まで。
   * **映像と寸分同じ枠に、当たり判定を抜いて敷く** — ずれると字幕が飛び、
   * 抜けていないと下の操作列が押せなくなる。
   */
  test("字幕を重ねる場所は、映像と同じ枠で、押す邪魔をしない", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();

    const captions = page.getByTestId("live-captions");
    await expect(captions).toHaveCSS("pointer-events", "none");
    await sameBox(captions, page.getByTestId("live-video"), expect);

    // 字幕の来ていない番組で切り替えを出すと、押しても何も起きない操作が並ぶ
    await expect(captions).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId("live-caption")).toHaveCount(0);
  });

  /*
   * **字幕は、見えている大きさ × 画面の画素で描く** (`CaptionPainter`)。描く画素が見えている
   * 大きさと食い違うと、ブラウザが引き伸ばして字がぼやける。偽の放送に字幕は乗っていないので
   * 1枚流す (`feedCaption`)。データ放送の小窓の中は上の「小窓へ縮んで見えている」で見る
   */
  test("字幕の画素は、PC (DPR 1・2) でもスマホでも見えている大きさ × DPR と合う", async ({
    browser,
  }) => {
    for (const [what, options] of CAPTION_SCREENS) {
      const context = await browser.newContext(options);
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
   * 言語が2つ載っている通知を流す
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
   * エンコード方式を選び直したり繋ぎ直したりしたとき、サーバだけ1本目に戻っていた
   */
  test("2本目の字幕を選んだまま、エンコード方式を選び直しても字幕は2本目", async ({
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
        { index: 0, lang: "jpn", label: "字幕1" },
        { index: 1, lang: "jpn", label: "字幕2" },
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
   * **字幕は映像と同じ ffmpeg がエンコードする。** 出口を2つ持つ1本しか起きない。
   *
   * **それが時刻を揃える唯一の方法だった。** 別々に起こした2本は入口で時刻を
   * 0 に寄せる幅が違うので、出てきた時刻を突き合わせても意味を持たない
   * (装置を5通り作って -60〜+450ms とばらけた)。1本なら寄せは1回で、
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
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const args = await ffmpegArgs(stack.liveArgsFile, expect);
    // 映像と字幕が同じ1回の中にあること
    expect(args).toContain("libx264");
    expect(args).toContain("pipe:1");
    expect(args).toContain("pipe:3");
    expect(args).not.toContain("-copyts");

    expect(args).not.toContain("-sub_type");
    expect(args[args.indexOf("-c:s") + 1]).toBe("copy");
    expect(args[args.indexOf("-f", args.indexOf("pipe:1")) + 1]).toBe(
      "matroska",
    );

    // 字幕も局を名指しする。1つの物理チャンネルに複数の局が入っている
    expect(args[args.lastIndexOf("-map") + 1]).toMatch(/^0:p:\d+:s:0$/);

    /*
     * **別のフィルタには喋らせない。** 時刻と「空かどうか」を `showinfo` に喋らせ、
     * 標準エラーの行と標準出力の PNG を来た順に組にしていた頃は、**数が
     * 合わずにずれていた** (実機で PNG 77枚に対し showinfo 79行)。一度ずれると
     * 戻らず、字幕が1秒ほど遅れて出て、消えるのも遅れる
     */
    expect(args).not.toContain("showinfo");
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
   * **10分ごとに 0.3秒 ずつ**しか下がらない (`pacing` の `FORGET`)。
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
   * 返事が変わったことを渡さないと (`source`)、同じ文面の2回目は閉じたままになりうる
   * (Toasts)。いまは `applyAction` が一度 form を null にしてから入れ直すので、
   * その隙に閉じた印が捨てられて出ている — **それに頼らない**よう他の画面と揃えて
   * `source` を渡し、ここで見張る。
   *
   * 毎回同じ断りを返させるため、録る局だけ番組表の無い局 (BSテレ東) に差し替えて
   * 押す — 本当に録り始めるとチューナーを30分塞ぐ
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
 * **横にしたスマホでは映像を画面いっぱいに** (`PlayerLayout`)。見出しと右の一覧を残すと
 * 映像の枠が 510x280 ほどしか無く、操作バーが二段に折れてシークバーが映像の真ん中に来ていた。
 * 一覧は消さずに映像の下へ回す — 消すと局を選べなくなる
 */
test.describe("スマホの横でライブ", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });

  test("見出しを隠して映像が画面の高さいっぱい。操作バーは一段、一覧は下で選べる", async ({
    page,
  }) => {
    await goto(page, "/live");
    const channels = page.getByTestId("live-channel");
    await channels.first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();

    const stage = page.getByTestId("live-frame");
    await expect(page.locator(".navbar")).toBeHidden();
    // 横にしたスマホもスマホの形 (1000px 未満) だが、下のタブは映像の下端に重なるので出さない
    await expect(page.getByTestId("tabbar")).toBeHidden();
    // 枠は映像の形 (16:9) で、高さいっぱい・真ん中。左右の黒帯にボタンを出さない
    await expect
      .poll(async () => {
        const box = await stage.boundingBox();
        return box === null
          ? null
          : [
              Math.round(box.x),
              Math.round(box.y),
              Math.round(box.width),
              Math.round(box.height),
            ];
      })
      .toEqual([75, 0, 693, 390]);

    const bar = page.getByTestId("live-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      await page.touchscreen.tap(422, 195);
    }
    await expect(bar).toHaveAttribute("data-shown", "true");
    const play = (await page.getByTestId("live-play").boundingBox())!;
    const full = (await page.getByTestId("live-full").boundingBox())!;
    expect(Math.abs(play.y - full.y)).toBeLessThan(2);
    // どのボタンも重ならず、映像の枠の中に丸ごと見える (右上の3つも)
    expect(await overlayTroubles(page, "live-frame")).toEqual([]);
    // 操作バーは映像に重ねるので、下の方の字幕は操作バーの上まで持ち上がる。操作バーが引っ込めば戻る
    await captionsClearOfBar(page, "live-captions", "live-controls");
    await expect(bar).toHaveAttribute("data-shown", "false", { timeout: 6000 });
    await expect(page.getByTestId("live-captions")).toHaveCSS(
      "translate",
      "none",
    );

    // 一覧は映像の下。巻き取って別の局を選べ、選んだら映像へ戻る
    const second = channels.nth(1);
    await second.scrollIntoViewIfNeeded();
    await expect(stage).not.toBeInViewport({ ratio: 0.9 });
    await second.tap();
    await expect(second).toHaveAttribute("data-current", "true");
    await expect(stage).toBeInViewport({ ratio: 0.9 });

    // 戻る動きは CSS (巻く外枠の `scroll-behavior`)。動かさない設定 (E2E の既定) ではすぐ、動かしてよい端末では滑って戻る
    const layout = page.locator("[data-player-layout]");
    await expect(layout).toHaveCSS("scroll-behavior", "auto");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(layout).toHaveCSS("scroll-behavior", "smooth");
    const first = channels.first();
    await first.scrollIntoViewIfNeeded();
    await expect(stage).not.toBeInViewport({ ratio: 0.9 });
    await first.tap();
    await expect(first).toHaveAttribute("data-current", "true");
    await expect(stage).toBeInViewport({ ratio: 0.9 });
    // 着く位置は前と同じ (映像の上の端)
    await expect.poll(() => layout.evaluate((el) => el.scrollTop)).toBe(0);
  });
});

/**
 * **スマホの縦 (360px・320px) でも、操作バーのボタンは1行。** 残すのは再生・ライブ・読みもの・全画面と
 * ⚙ だけ。音・速さ・小窓などは ⚙ の頭に畳み、そこから押せる
 */
test.describe("スマホの縦でライブ", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 360, height: 780 },
  });

  /*
   * **映像は本文の上の端から始まる** (390x844)。ほかの画面のように 0.5rem 空けると、映像の上に暗い帯が見えた。
   * テストでは上の安全域は 0 なので、映像の上の端は 0
   */
  test("映像の上に隙間を空けない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-play")).toBeVisible();
    await leaveFullscreen(page);
    const top = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const content =
        main.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(main).paddingTop);
      const stage = document
        .querySelector('[data-testid="live-frame"]')!
        .getBoundingClientRect();
      return { content, stage: stage.top };
    });
    expect(top).toEqual({ content: 0, stage: 0 });
  });

  test("幅 360px・320px でも操作バーのボタンは1行で、畳んだ音は ⚙ から押せる", async ({
    page,
  }) => {
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 780 });
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-play")).toBeVisible();
      await leaveFullscreen(page);
      await expect(page.getByTestId("live-frame")).toHaveAttribute(
        "data-narrow",
        "",
      );

      expect(await oneRowTroubles(page, "live-buttons"), `${width}px`).toEqual(
        [],
      );
      await expect(page.getByTestId("live-edge")).toBeVisible();
      await expect(page.getByTestId("live-full")).toBeVisible();
      // 再生の設定 (⚙) は畳まない
      await expect(page.getByTestId("live-settings")).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`live-${width}.png`),
      });

      // 畳んだ音は ⚙ の頭の「消音」の行。「ほか」(⋯) のボタンはもう無い
      const sound = page.getByTestId("live-sound");
      await expect(sound).toBeHidden();
      await expect(page.getByTestId("live-more")).toHaveCount(0);
      const label = (await sound.getAttribute("aria-label")) ?? "";
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-settings").tap();
      const mute = page.getByTestId("live-mute");
      await expect(mute).toBeVisible();
      await expect(mute).toHaveAttribute("role", "menuitemcheckbox");
      const muted = (await mute.getAttribute("aria-checked")) ?? "";
      await mute.tap();
      await expect(mute).not.toHaveAttribute("aria-checked", muted);
      await expect(sound).not.toHaveAttribute("aria-label", label);
      await page.screenshot({
        path: test.info().outputPath(`live-${width}-more.png`),
      });

      // 閉じても1行のまま
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("live-settings-menu")).toBeHidden();
      expect(
        await oneRowTroubles(page, "live-buttons"),
        `${width}px (閉じたあと)`,
      ).toEqual([]);

      // メニュー (再生の設定のコーデック) の外を押しても閉じるだけ。押した局には替わらない (もう一度押せば替わる)
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-settings").tap();
      await page.getByTestId("live-codec").tap();
      await expect(page.getByTestId("live-codec-option").first()).toBeVisible();
      const codecMenu = page.getByTestId("live-settings-menu");
      await expect(codecMenu).toBeVisible();
      const other = page.getByTestId("live-channel").nth(1);
      await other.tap();
      await expect(codecMenu).toBeHidden();
      await expect(other).not.toHaveAttribute("data-current", "true");
      await other.tap();
      await expect(other).toHaveAttribute("data-current", "true");
    }
  });
});

/**
 * **観ている間に番組が替わったら、出ている番組も替わる。** 開いた時点の番組のまま残っていた
 * (次の番組が始まっても操作列の番組名・時間帯と一覧の番組名が前のまま)。
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

  test("次の番組が始まると、操作列と一覧の番組名が替わる", async ({ page }) => {
    await goto(page, `/live?service=${BS11.id}`);
    const title = page.getByTestId("live-title");
    await expect(title).toBeVisible();
    const before = (await title.textContent()) ?? "";

    // BS11 は 5秒ごとに番組が替わる (tests/fake/services.ts)
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
    // MX は 30分枠 (:00 と :30 で替わる)。替わり目の直前なら、替わってから始める
    const slot = 30 * 60_000;
    const left = slot - (Date.now() % slot);
    if (left < 60_000) await page.waitForTimeout(left + 3_000);

    await goto(page, `/live?service=${MX.id}`);
    const range = page.getByTestId("live-range");
    await expect(range).toBeVisible();
    const before = ((await range.textContent()) ?? "").trim();
    const [start, end] = before.split("〜").map((part) => part.trim());

    // 放送が10分押した。サーバが p/f を読んで番組表を直し、画面に読み直させる
    await request.post(`${stack.agentUrl}/__control/extend?ms=${10 * 60_000}`);
    await expect(range).toHaveText(`${start} 〜 ${later(end ?? "", 10)}`);

    // 戻せば元の時刻に戻る
    await request.post(`${stack.agentUrl}/__control/extend?ms=0`);
    await expect(range).toHaveText(before);
  });
});

/** "HH:MM" の minutes 分あと */
function later(clock: string, minutes: number): string {
  const [hours, mins] = clock.split(":").map(Number);
  const total = ((hours ?? 0) * 60 + (mins ?? 0) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
