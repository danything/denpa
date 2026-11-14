import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { BS_NO_LOGO, SERVICES } from "../fake/services";
import {
  airing,
  captureSockets,
  cellOf,
  dataElement,
  expect,
  fakeDataBroadcast,
  fakeFrame,
  feedData,
  goto,
  openSettings,
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
    // 区切りの先頭が入っているものだけ (payload_unit_start_indicator)
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
 * ライブ視聴のうち、番組表から開く、繋ぎ方、データ放送、ffmpeg に渡す TS、切り抜き。
 * 偽 ffmpeg で確かめる範囲と、ほかのライブ視聴のスペックとの分け方は [20-live.spec.ts](20-live.spec.ts) の冒頭にある
 */
test.describe("ライブ視聴", () => {
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
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
   * **番組表の局名から、その局で開く。** 番組がまだ 1 つも無い局 (BSテレ東) も空の列で出ていて、
   * マスが無くても見出しからライブへ行ける
   */
  test("番組表の局名から、その局で開く。番組の無い局も", async ({ page }) => {
    const empty = BS_NO_LOGO;
    await goto(page, "/guide?type=BS");
    const head = page.getByRole("link", {
      name: `${empty.name} をライブで観る`,
    });
    await expect(head).toBeVisible();
    await head.click();

    await expect(page).toHaveURL(new RegExp(`/live\\?service=${empty.id}$`));
    await expect(
      page.locator('[data-testid="live-channel"][data-current="true"]'),
    ).toHaveAttribute("data-service", String(empty.id));
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
   * **開いた最初の 1 回は、ページと一緒に受け取ったチケットで繋ぐ** (`+page.server.ts` の `ticket`)。
   * `/api/live/ticket` の往復を省く (docs/stream.md#繋ぐときの認証)
   */
  test("開いた最初の 1 回は、ページと一緒に受け取ったチケットで繋ぐ", async ({
    page,
  }) => {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/live/ticket")) asked.push(request.url());
    });
    const socket = page.waitForEvent("websocket", (ws) =>
      ws.url().includes("/api/live/socket"),
    );
    await goto(page, "/live");
    await (await socket).waitForEvent("framereceived");
    expect(asked, "ページのチケットを使わずに取りに行った").toEqual([]);
  });

  /*
   * **ページのチケットを断られたら、`/api/live/ticket` から取り直して繋ぐ。** 戻るで開き直したページは、
   * ブラウザが手元に持っていた HTML (使い終えたチケットが入っている) を出すことがある。ここでは最初に繋ぐ URL の
   * チケットを配っていないものに書き換えて、サーバに断らせる。HTML を `route.fulfill` で書き換えると、
   * Chromium がそのページを外のネットワークのものと扱い、127.0.0.1 への WebSocket を止めてしまう
   * (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`)
   */
  test("ページのチケットを断られたら、取り直して繋ぐ", async ({ page }) => {
    await page.addInitScript(() => {
      const seen = window as unknown as { __replaced: boolean };
      seen.__replaced = false;
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          const text = String(url);
          const first = !seen.__replaced && text.includes("ticket=");
          if (first) seen.__replaced = true;
          super(
            first
              ? text.replace(
                  /ticket=[^&]+/,
                  "ticket=00000000-0000-4000-8000-000000000000",
                )
              : url,
            protocols,
          );
        }
      };
    });
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/live/ticket")) asked.push(request.url());
    });
    let frames = 0;
    page.on("websocket", (ws) => {
      ws.on("framereceived", () => {
        frames += 1;
      });
    });

    await goto(page, "/live");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __replaced: boolean }).__replaced,
        ),
      )
      .toBe(true);
    await expect.poll(() => asked.length).toBe(1);
    await expect.poll(() => frames).toBeGreaterThan(0);
    await expect(page.getByText("繋がりませんでした")).toHaveCount(0);
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
            // 多重化の先頭 1 バイトが種別。0x40 が制御で、中身は 9 バイト目から JSON
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
   * **局を変えたら、データ放送を閉じ、開き直すと作り直す。**
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
    // 別の局へ移ったら閉じる (テレビと同じ。開いたままだと次の局の入口に d が届き、選局しただけでメニューが開く)
    await expect(overlay).toHaveAttribute("data-open", "false");
    await expect(overlay).toHaveAttribute("data-state", "off");
    // 開き直すと、エンジンは次の局のもの
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
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
