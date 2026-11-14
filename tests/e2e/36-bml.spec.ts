import type { Page } from "@playwright/test";

import { FUJI, MX } from "../fake/services";
import {
  captionsSeenInDataWindow,
  captureSockets,
  dataElement,
  expect,
  expectSharpCaptions,
  fakeDataBroadcast,
  feedCaption,
  feedData,
  feedNotice,
  goto,
  holdCaptions,
  holdMedia,
  test,
  wakeControls,
} from "./helpers";

/**
 * **データ放送のエンジン** (`src/lib/bml/`)。
 *
 * 偽の放送にはデータ放送が載っていないので、手で書いた小さな BML (`fakeDataBroadcast`) を
 * WebSocket に流して確かめる。見るのは:
 * - 出る (文書を描き、映像の object の場所を教え、denpa が映像の入れ物をそこへ寄せる)
 * - 字幕が映像と一緒に小窓へ縮んで見える (映像は影の中へ移さない)
 * - d とリモコンが文書のスクリプトに届く (自前の VM で動く)
 *
 * 放送の on* がページに出ないことは 35-csp で見る
 */

interface Seen {
  __csp: string[];
}

/** 流し込む関数を控え、CSP の違反も数える (ページのスクリプトより先に) */
async function prepare(page: Page): Promise<void> {
  await captureSockets(page);
  await page.addInitScript(() => {
    const seen = window as unknown as Seen;
    seen.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.__csp.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
}

/** 局を選んで d を押し、エンジンが立つまで */
async function openData(page: Page): Promise<void> {
  await goto(page, "/live");
  await page.getByTestId("live-channel").first().click();
  await expect(page.getByTestId("live-title")).toBeVisible();
  await holdMedia(page, "live-video", "live-captions", "live-frame");
  await holdCaptions(page, "live-captions");
  await page
    .getByTestId("live-captions")
    .evaluate((el) => el.setAttribute("data-ink", "0.8000,0.9700"));
  const overlay = page.getByTestId("live-data");
  await wakeControls(page, "live-frame");
  await page.getByTestId("live-data-button").click();
  await expect(overlay).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-handed")))
    .toBeGreaterThan(0);
}

/** 作った BML を流す */
async function feed(page: Page, extra: string): Promise<void> {
  await feedData(page, fakeDataBroadcast(extra));
}

/** 文書のスクリプトが書く表示。d と、押されたキーを数える */
const SCRIPTED = [
  "<script><![CDATA[",
  'var pressed = 0; var log = "";',
  "function onData() { pressed++; show(); }",
  'function onKey() { log += "k" + document.currentEvent.keyCode + ","; show(); }',
  'function onUp() { log += "u" + document.currentEvent.keyCode + ","; show(); }',
  'function onClick() { log += "c,"; show(); browser.launchDocument("/40/0001/next.bml", "cut"); }',
  'function show() { document.getElementById("msg").firstChild.data = "d" + pressed + "|" + log; }',
  "]]></script>",
  '<bevent><beitem type="DataButtonPressed" onoccur="onData();" subscribe="subscribe"/></bevent>',
  '<p id="msg" style="left:0px;top:0px;width:400px;height:40px;nav-index:0;color-index:7;" onkeydown="onKey();" onkeyup="onUp();" onclick="onClick();">init</p>',
].join("\n");

/** 次の文書 (映像の object が無い) を 0x40/0001 に載せる */
function nextDocument(): Record<string, unknown>[] {
  const bml =
    '<?xml version="1.0" encoding="EUC-JP" ?><bml><body style="background-color-index:4"><p style="left:0px;top:0px;width:200px;height:30px;">next</p></body></bml>';
  const type = {
    type: "text",
    originalType: "text",
    subtype: "x-arib-bml",
    originalSubtype: "X-arib-bml",
    parameters: [],
  };
  return [
    {
      type: "moduleListUpdated",
      componentId: 0x40,
      modules: [
        { id: 0, version: 1, size: 1 },
        { id: 1, version: 1, size: bml.length },
      ],
      dataEventId: 1,
    },
    {
      type: "moduleDownloaded",
      componentId: 0x40,
      moduleId: 1,
      version: 1,
      dataEventId: 1,
      files: [
        {
          contentLocation: "next.bml",
          contentType: type,
          dataBase64: btoa(bml),
        },
      ],
    },
  ];
}

test.describe("データ放送のエンジン", () => {
  test("出して、字幕が映像と一緒に小窓へ縮んで見えている", async ({ page }) => {
    await prepare(page);
    await openData(page);
    // 操作バーを出したまま (操作バーと重なる字幕を持ち上げたぶんが、小窓の中に残らないことも見る)
    await expect(page.getByTestId("live-controls")).toHaveAttribute(
      "data-shown",
      "true",
    );
    await feed(page, "");
    await captionsSeenInDataWindow(page);
    // 小窓の中でも見えている大きさで描く (`CaptionPainter`)
    await feedCaption(page, "live");
    await expectSharpCaptions(page, "データ放送の小窓の中");
    expect(
      await page.evaluate(() => (window as unknown as Seen).__csp),
    ).toEqual([]);
  });

  test("d とリモコンが文書のスクリプトに届く。keydown → click → keyup の順", async ({
    page,
  }) => {
    await prepare(page);
    await openData(page);
    await feed(page, SCRIPTED);
    const text = async () => (await dataElement(page, "span"))?.text;
    // 出す操作は文書への d の 1 押し (聞いている文書が出てきたら届ける)
    await expect.poll(text, { timeout: 10_000 }).toBe("d1|");
    // 出ている間の画面の d は、聞いている文書に渡す (データ放送は閉じない)
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect.poll(text).toBe("d2|");
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "ready",
    );
    // 指のリモコンの赤 (22) は、フォーカスのある要素へ (押して離したことになる)
    await page.getByTestId("live-remote-22").click();
    await expect.poll(text).toBe("d2|k22,u22,");
    // キーボードの青も同じ
    await page.keyboard.press("b");
    await expect.poll(text).toBe("d2|k22,u22,k21,u21,");
    // 決定は keydown の後に click (ここで次の文書へ移る)。次の文書には映像が無い
    await feedData(page, nextDocument());
    await expect(
      page.locator('[data-testid="live-video"]').locator(".."),
    ).toHaveAttribute("data-bml-window", "");
    await page.keyboard.press("Enter");
    await expect.poll(text).toBe("next");
    // 映像の object が無い文書へ移ったら、映像は枠いっぱいに戻る
    await expect(
      page.locator('[data-testid="live-video"]').locator(".."),
    ).not.toHaveAttribute("data-bml-window", "");
  });

  test("取れない通信の文書・放送に無い文書へ移ろうとしても、データ放送は閉じずに失敗を返す", async ({
    page,
  }) => {
    await prepare(page);
    // 中継が断る (双方向がオンでもオフでも、通信の文書は取れずに NaN が返る)
    await page.route("**/api/bml/proxy**", (route) =>
      route.fulfill({ status: 502, body: "refused" }),
    );
    await openData(page);
    // d が届いたら、移れない文書へ順に移ろうとして、返ってきた値を出す
    await feed(
      page,
      [
        "<script><![CDATA[",
        "function go() {",
        '  var a = browser.launchDocument("https://www.example.com/a.bml", "cut");',
        '  var b = browser.launchDocument("/40/0005/a.bml", "cut");',
        '  document.getElementById("msg").firstChild.data = a + "," + b;',
        "}",
        "]]></script>",
        '<bevent><beitem type="DataButtonPressed" onoccur="go();" subscribe="subscribe"/></bevent>',
        '<p id="msg" style="left:0px;top:0px;width:400px;height:40px;color-index:7;">init</p>',
      ].join("\n"),
    );
    const text = async () => (await dataElement(page, "span"))?.text;
    await expect.poll(text, { timeout: 10_000 }).toBe("NaN,NaN");
    // 入口から出直さず、出たまま
    const overlay = page.getByTestId("live-data");
    await expect(overlay).toHaveAttribute("data-state", "ready");
    await expect(overlay).toHaveAttribute("data-showing", "true");
    await page.waitForTimeout(500);
    expect(await text()).toBe("NaN,NaN");
    await expect(overlay).toHaveAttribute("data-showing", "true");
  });

  test("データ放送の epgTune で別の局へ切り替わる (選局は画面がやる)", async ({
    page,
  }) => {
    await prepare(page);
    await openData(page);
    const current = page.locator(
      '[data-testid="live-channel"][data-current="true"]',
    );
    const from = Number(await current.getAttribute("data-service"));
    // 今の局でないほうへ。arib://<original_network_id>.<transport_stream_id>.<service_id> (16 進)
    const to = from === FUJI.id ? MX : FUJI;
    const target = `arib://${to.networkId.toString(16)}.-1.${to.serviceId.toString(16)}`;
    await feed(
      page,
      `<script><![CDATA[function tune() { browser.epgTune("${target}"); }]]></script><bevent><beitem type="DataButtonPressed" onoccur="tune();" subscribe="subscribe"/></bevent>`,
    );
    // 出す操作の d が文書に届くと epgTune。画面が一覧から局を探して切り替える
    await expect(
      page.locator(`[data-testid="live-channel"][data-service="${to.id}"]`),
    ).toHaveAttribute("data-current", "true", { timeout: 15_000 });
    // 別の局へ移ったのでデータ放送は閉じる (テレビと同じく、次の局の入口に d を届けない)
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-open",
      "false",
    );
  });
});

/**
 * **データ放送を自動で受信する端末** (ライブのデータ放送のボタン (d) の長押し。`data-receive.ts`)。
 *
 * 受信するのと開くのは別のこと。自動で受信する端末は、入口に自動起動の指定がある局でだけ開く前から受信して入口の文書を
 * 裏で動かし、文書が自分で出したものはテレビと同じく映像に重ねる (番組からの誘導・自動で出る画面)。指定は
 * サーバが PMT を読んで知らせる (`Notice` の `autoStart`)。**リモコンを出すのは開いたときだけ**で、
 * d (開く操作) を届けるのも開いたときだけ。
 *
 * 偽の放送の PMT にはデータ放送が載っていない (指定の無い局)。サーバは `autoStart: false` を知らせ、
 * 画面は受信をリクエストしない。指定のある局は、その通知を手で流して作る
 */
test.describe("データ放送を自動で受信する端末", () => {
  /** 自動で受信をオンにした端末で開き、サーバへ送ったデータ放送の指示と、届いた `autoStart` を控える */
  async function prepareReceiving(page: Page): Promise<void> {
    await prepare(page);
    await page.addInitScript(() => {
      localStorage.setItem("player-data-always", "1");
      const seen = window as unknown as {
        __data: unknown[];
        __autoStart: boolean[];
      };
      seen.__data = [];
      seen.__autoStart = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (payload) {
        if (typeof payload === "string" && payload.includes('"data"'))
          seen.__data.push(JSON.parse(payload));
        send.call(this, payload);
      };
      // サーバからの制御の通知 (0x40 + 時刻 8 バイト + JSON) のうち `autoStart`
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event: MessageEvent) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const bytes = new Uint8Array(event.data);
            if (bytes[0] !== 0x40) return;
            const notice = JSON.parse(
              new TextDecoder().decode(bytes.subarray(9)),
            ) as { type: string; on?: boolean };
            if (notice.type === "autoStart")
              seen.__autoStart.push(notice.on === true);
          });
        }
      };
    });
  }
  const asked = (page: Page) =>
    page.evaluate(() => (window as unknown as { __data: unknown[] }).__data);
  const told = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __autoStart: boolean[] }).__autoStart,
    );

  /** 局を選ぶだけ (d は押さない)。サーバが PMT を読んで、指定が無いと知らせるまで */
  async function tuneOnly(page: Page): Promise<void> {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect.poll(() => told(page), { timeout: 15_000 }).toContain(false);
  }

  /** 入口に自動起動の指定がある局にする (サーバの通知を流す)。エンジンが立つまで */
  async function flagged(page: Page): Promise<void> {
    await feedNotice(page, [{ type: "autoStart", on: true }]);
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 15_000 },
    );
  }

  test("指定の無い局は、自動で受信していても d を押すまでリクエストしない", async ({
    page,
  }) => {
    await prepareReceiving(page);
    await tuneOnly(page);
    const overlay = page.getByTestId("live-data");
    await page.waitForTimeout(1_000);
    expect(await asked(page)).toEqual([]);
    await expect(overlay).toHaveAttribute("data-state", "off");
    // d はいつもどおり効く
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect(overlay).toHaveAttribute("data-open", "true");
    await expect.poll(() => asked(page)).toEqual([{ type: "data", on: true }]);
  });

  test("指定のある局は開く前から受信して、文書が出したものを重ねる。リモコンと d は開いてから", async ({
    page,
  }) => {
    await prepareReceiving(page);
    await tuneOnly(page);
    expect(await asked(page)).toEqual([]);
    await flagged(page);
    const overlay = page.getByTestId("live-data");
    await expect(overlay).toHaveAttribute("data-open", "false");
    expect(await asked(page)).toEqual([{ type: "data", on: true }]);

    await feed(page, SCRIPTED);
    // 自動起動の入口は開く前から動き、出てきた文書は重ねる (映像は文書の小窓へ寄る)
    await expect(overlay).toHaveAttribute("data-showing", "true", {
      timeout: 10_000,
    });
    await expect(
      page.locator('[data-testid="live-video"]').locator(".."),
    ).toHaveAttribute("data-bml-window", "");
    const text = async () => (await dataElement(page, "span"))?.text;
    await expect.poll(text).toBe("init");
    // **開くまではリモコンを出さない。** キーも文書へ渡さない
    await expect(page.getByTestId("live-remote")).toBeHidden();
    await page.keyboard.press("b");
    await page.waitForTimeout(500);
    expect(await text()).toBe("init");

    // 開く (d の 1 押し)。エンジンは作り直さずに d を届け、リモコンを出す
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect(overlay).toHaveAttribute("data-open", "true");
    await expect.poll(text, { timeout: 10_000 }).toBe("d1|");
    await expect(page.getByTestId("live-remote")).toBeVisible();
    await page.getByTestId("live-remote-22").click();
    await expect.poll(text).toBe("d1|k22,u22,");
    // 受信は続けているので、開いてもリクエストし直さない
    expect(await asked(page)).toEqual([{ type: "data", on: true }]);
  });

  test("閉じてもエンジンは残して入口へ戻る。d の右クリックで切ると受信をやめ、Shift+D で戻す", async ({
    page,
  }) => {
    await prepareReceiving(page);
    await tuneOnly(page);
    await flagged(page);
    const overlay = page.getByTestId("live-data");
    const button = page.getByTestId("live-data-button");
    // d を聞かない文書。画面の d はデータ放送を閉じる
    await feed(page, "");
    await expect(overlay).toHaveAttribute("data-showing", "true", {
      timeout: 10_000,
    });
    await wakeControls(page, "live-frame");
    await button.click();
    await expect(page.getByTestId("live-remote")).toBeVisible();
    await wakeControls(page, "live-frame");
    await button.click();
    await expect(overlay).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("live-remote")).toBeHidden();
    // 受信したまま (サーバに off を送らない)。入口から出直して、また出てくる
    await expect(overlay).toHaveAttribute("data-state", "ready");
    await expect(overlay).toHaveAttribute("data-showing", "true", {
      timeout: 10_000,
    });
    expect(await asked(page)).toEqual([{ type: "data", on: true }]);

    // オンの間はボタンに印 (「A」) を付け、名前でも言う。⚙ に行は無い
    await expect(button.locator(".ov-mark")).toHaveText("A");
    await expect(button).toHaveAttribute(
      "aria-label",
      "データ放送を出す (自動で受信)",
    );
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-settings").click();
    await expect(page.getByTestId("live-settings-menu")).toBeVisible();
    await expect(page.getByTestId("live-data-receive")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("live-settings-menu")).toBeHidden();

    // 右クリック (マウスの長押し) で切ると、畳んでサーバにも伝える。開きはしない
    await wakeControls(page, "live-frame");
    await button.click({ button: "right" });
    await expect(page.getByTestId("live-data-receive-note")).toHaveText(
      "データ放送を自動で受信しません",
    );
    await expect(button.locator(".ov-mark")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-label", "データ放送を出す");
    await expect(overlay).toHaveAttribute("data-open", "false");
    await expect(overlay).toHaveAttribute("data-state", "off");
    expect(await asked(page)).toEqual([
      { type: "data", on: true },
      { type: "data", on: false },
    ]);
    expect(
      await page.evaluate(() => localStorage.getItem("player-data-always")),
    ).toBe("0");

    // Shift+D でも切り替わる。指定のある局なのでまたリクエストする
    await page.locator("body").press("Shift+D");
    await expect(page.getByTestId("live-data-receive-note")).toHaveText(
      "データ放送を自動で受信します",
    );
    await expect(button.locator(".ov-mark")).toHaveText("A");
    await expect
      .poll(() => asked(page))
      .toEqual([
        { type: "data", on: true },
        { type: "data", on: false },
        { type: "data", on: true },
      ]);
  });

  test("指で長押しすると切り替え、押したときの開く操作はしない", async ({
    page,
  }) => {
    await prepare(page);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const overlay = page.getByTestId("live-data");
    const button = page.getByTestId("live-data-button");
    await wakeControls(page, "live-frame");
    await expect(button.locator(".ov-mark")).toHaveCount(0);
    const box = (await button.boundingBox())!;
    const at = {
      pointerType: "touch",
      isPrimary: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    };
    await button.dispatchEvent("pointerdown", at);
    await page.waitForTimeout(700);
    await button.dispatchEvent("pointerup", at);
    await button.dispatchEvent("click", at);
    await expect(page.getByTestId("live-data-receive-note")).toHaveText(
      "データ放送を自動で受信します",
    );
    await expect(button.locator(".ov-mark")).toHaveText("A");
    await expect(overlay).toHaveAttribute("data-open", "false");
    expect(
      await page.evaluate(() => localStorage.getItem("player-data-always")),
    ).toBe("1");
    // 短く押すのは今までどおり開く
    await wakeControls(page, "live-frame");
    await button.dispatchEvent("pointerdown", at);
    await button.dispatchEvent("pointerup", at);
    await button.dispatchEvent("click", at);
    await expect(overlay).toHaveAttribute("data-open", "true");
  });

  test("自動起動の指定が無い入口は、開くまで始めない", async ({ page }) => {
    await prepareReceiving(page);
    await tuneOnly(page);
    // サーバの通知では指定があるが、届いた PMT の入口には無い (番組の途中で変わった)。エンジンは PMT の指定に従う
    await flagged(page);
    const overlay = page.getByTestId("live-data");
    await feedData(
      page,
      fakeDataBroadcast(SCRIPTED).map((message) => {
        if (message["type"] !== "pmt") return message;
        const [component] = message["components"] as Record<
          string,
          Record<string, Record<string, unknown>>
        >[];
        return {
          ...message,
          components: [
            {
              ...component,
              bxmlInfo: {
                ...component!["bxmlInfo"],
                entryPointInfo: {
                  ...component!["bxmlInfo"]!["entryPointInfo"],
                  autoStartFlag: false,
                },
              },
            },
          ],
        };
      }),
    );
    await page.waitForTimeout(1_000);
    await expect(overlay).toHaveAttribute("data-showing", "false");
    expect(await dataElement(page, "span")).toBeNull();
    // 開いたら始まり、d も届く
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    const text = async () => (await dataElement(page, "span"))?.text;
    await expect.poll(text, { timeout: 10_000 }).toBe("d1|");
  });
});
