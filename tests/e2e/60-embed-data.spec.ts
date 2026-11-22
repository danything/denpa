import type { Page } from "@playwright/test";

import { FUJI, MX } from "../fake/services";
import { dataElement, expect, fakeDataBroadcast, goto, test } from "./helpers";
import { sharedDataBroadcast } from "./watch";

/**
 * **データ放送のページ** (`/embed/data`。テレビのアプリが映像の上に重ねる。約束は docs/api.md)。
 *
 * アプリの代わりに、テストがポートを渡す。アプリは `postWebMessage` で渡すが、ここでは同じウィンドウから
 * `postMessage` で渡す (`#lib/embed-data.ts` の `portFrom` はどちらも受ける)。ページからのメッセージは `__out` に控える
 */

interface Seen {
  __out: Record<string, unknown>[];
  __send: (message: unknown) => void;
}

/** ページを開いてポートを渡す。ページが返したものを控える */
async function connect(page: Page): Promise<void> {
  await goto(page, "/embed/data");
  await page.evaluate(() => {
    const seen = window as unknown as Seen;
    seen.__out = [];
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      seen.__out.push(JSON.parse(event.data as string));
    };
    seen.__send = (message) =>
      channel.port1.postMessage(JSON.stringify(message));
    window.postMessage("denpa-tv", location.origin, [channel.port2]);
  });
  await expect.poll(() => sent(page)).toContainEqual({ type: "ready" });
}

/** ページからアプリへ届いたもの */
function sent(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => (window as unknown as Seen).__out);
}

/** アプリからページへ送る */
async function send(page: Page, ...messages: unknown[]): Promise<void> {
  await page.evaluate((list) => {
    for (const message of list) (window as unknown as Seen).__send(message);
  }, messages);
}

/** ライブのデータ放送を流す (アプリは 0x30 の JSON を `data` に包んで渡す) */
async function feed(page: Page, extra = ""): Promise<void> {
  await send(
    page,
    ...fakeDataBroadcast(extra).map((message) => ({ type: "data", message })),
  );
}

/** 最後に知らせた映像の場所 */
const lastVideo = (messages: Record<string, unknown>[]) =>
  messages.filter((message) => message["type"] === "video").at(-1);

const text = (page: Page) => async () =>
  (await dataElement(page, "span"))?.text;

test.describe("データ放送のページ", () => {
  test("土台を持たず、地を透かす", async ({ page }) => {
    await goto(page, "/embed/data");
    await expect(page.locator(".shell")).toHaveCount(0);
    await expect(page.locator("nav")).toHaveCount(0);
    const backgrounds = await page.evaluate(() => [
      getComputedStyle(document.documentElement).backgroundColor,
      getComputedStyle(document.body).backgroundColor,
    ]);
    expect(backgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  });

  test("ポートは最初の 1 回だけ受ける", async ({ page }) => {
    await connect(page);
    // 2 本目のポートには何も返さない
    await page.evaluate(() => {
      const seen = window as unknown as { __second: unknown[] };
      seen.__second = [];
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => seen.__second.push(event.data);
      window.postMessage("denpa-tv", location.origin, [channel.port2]);
    });
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(
        () => (window as unknown as { __second: unknown[] }).__second,
      ),
    ).toEqual([]);
  });

  test("ライブ: 届いた通知を描き、映像の場所・キー・選局をアプリへ渡す", async ({
    page,
  }) => {
    await connect(page);
    await send(page, {
      type: "init",
      mode: "live",
      service: MX.id,
      open: true,
    });
    await expect
      .poll(() => sent(page))
      .toContainEqual({
        type: "open",
        on: true,
      });
    // d (開く操作) とキーを数える文書
    await feed(
      page,
      [
        "<script><![CDATA[",
        'var log = "";',
        'function onData() { log += "d,"; show(); }',
        'function onKey() { log += "k" + document.currentEvent.keyCode + ","; show(); }',
        'function show() { document.getElementById("msg").firstChild.data = log; }',
        "]]></script>",
        '<bevent><beitem type="DataButtonPressed" onoccur="onData();" subscribe="subscribe"/></bevent>',
        '<p id="msg" style="left:0px;top:0px;width:400px;height:40px;nav-index:0;color-index:7;" onkeydown="onKey();">init</p>',
      ].join("\n"),
    );
    const overlay = page.getByTestId("live-data");
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    // 映像の object の場所 (960x540 の面の右下 4 分の 1) を、枠に対する割合で知らせる
    await expect
      .poll(async () => lastVideo(await sent(page)))
      .toEqual({
        type: "video",
        rect: { left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
      });
    // 出す操作の d が文書に届く
    await expect.poll(text(page), { timeout: 10_000 }).toBe("d,");
    // キーはメッセージで届く (window のキーは受けない)
    await page.keyboard.press("b");
    await send(
      page,
      { type: "key", code: 22, down: true },
      { type: "key", code: 22, down: false },
    );
    await expect.poll(text(page)).toBe("d,k22,");
    // 映像の上の通知 (データ取得中…) もアプリへ渡す。出すのはアプリ
    expect(await sent(page)).toContainEqual({
      type: "note",
      text: "データ取得中…",
    });
  });

  test("ライブ: 文書が選局を求めたら、一覧にある局ならアプリへ頼む", async ({
    page,
  }) => {
    await connect(page);
    await send(page, {
      type: "init",
      mode: "live",
      service: MX.id,
      open: true,
    });
    // arib://<original_network_id>.<transport_stream_id>.<service_id> (16 進)
    const target = `arib://${FUJI.networkId.toString(16)}.-1.${FUJI.serviceId.toString(16)}`;
    await feed(
      page,
      `<script><![CDATA[function tune() { browser.epgTune("${target}"); }]]></script><bevent><beitem type="DataButtonPressed" onoccur="tune();" subscribe="subscribe"/></bevent>`,
    );
    // 出す操作の d が文書に届くと epgTune
    await expect
      .poll(
        async () =>
          (await sent(page)).find((message) => message["type"] === "tune"),
        { timeout: 15_000 },
      )
      .toMatchObject({
        type: "tune",
        service: FUJI.id,
        onid: FUJI.networkId,
        sid: FUJI.serviceId,
      });
  });

  test("ライブ: d は文書が受け付けていなければ閉じ、閉じたらアプリへ知らせる", async ({
    page,
  }) => {
    await connect(page);
    await send(page, {
      type: "init",
      mode: "live",
      service: MX.id,
      open: true,
    });
    await feed(page);
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 15_000 },
    );
    await send(page, { type: "d" });
    await expect
      .poll(() => sent(page))
      .toContainEqual({
        type: "open",
        on: false,
      });
    await expect(page.getByTestId("live-data")).toHaveAttribute(
      "data-state",
      "off",
    );
    // 閉じたら映像は枠いっぱいに戻す
    await expect
      .poll(async () => lastVideo(await sent(page)))
      .toEqual({ type: "video", rect: null });
  });

  /** 小窓を持つ既定の BML を置いた録画 */
  const withDataBroadcast = sharedDataBroadcast();

  test("録画: 変化ログを自分で取得して描き、再生位置が戻ったらエンジンを作り直す", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await withDataBroadcast(page, request);
    await connect(page);
    await send(
      page,
      { type: "init", mode: "recording", recording: Number(id), open: true },
      { type: "time", air: null, pos: 0, rate: 1, paused: true },
    );
    const overlay = page.getByTestId("live-data");
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    await expect(overlay).toHaveAttribute("data-for", `recording/${id}`);
    await expect
      .poll(async () => lastVideo(await sent(page)))
      .toEqual({
        type: "video",
        rect: { left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
      });
    // 先へ進むぶんは足すだけ。戻ったら、その位置まで積み直す
    await send(page, { type: "time", air: null, pos: 60_000, paused: true });
    await page.waitForTimeout(500);
    await expect(overlay).toHaveAttribute("data-for", `recording/${id}`);
    await send(page, { type: "time", air: null, pos: 1000, paused: true });
    await expect(overlay).toHaveAttribute("data-for", `recording/${id}:1000`);
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
  });
});
