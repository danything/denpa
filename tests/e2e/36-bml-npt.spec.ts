import {
  captureSockets,
  dataElement,
  expect,
  fakeDataBroadcast,
  feedData,
  goto,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";
import { chooseRaw } from "./live";

/**
 * **データ放送の NPT** (`browser.getNPT`・NPT で書いた TimerFired。docs/stream.md#npt)。
 *
 * 偽の放送に NPT 参照記述子を流させ (`Knobs.npt`。映像の最初の PCR で NPT 0)、サーバの `BmlDecoder` が送る `nptUpdated` を
 * 画面のエンジンが受けて、映しているコマの時刻から NPT を進めるかを見る。文書は手で書いた小さな BML (`fakeDataBroadcast`) を流す。
 *
 * コマの時刻は時計の通知とプレイヤーの再生位置から出す (`player.airTime`)。偽 ffmpeg の出す映像は放送の時刻と合わないので、
 * 放送の PTS をそのまま物差しにする MPEG-2 のまま見る経路で開く
 */

interface Seen {
  __dataTypes: string[];
}

test.describe("データ放送の NPT", () => {
  test.use({ liveMpeg2: true });

  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  test("getNPT は映しているコマに合わせて進み、NPT の TimerFired は達したものだけ起きる", async ({
    page,
    stack,
    request,
  }) => {
    test.setTimeout(120_000);
    await request.post(`${stack.agentUrl}/__control/npt?on=1`);
    try {
      await captureSockets(page);
      // サーバから届いたデータ放送の通知の種類を控える (偽の文書を流すのは、サーバの PMT が届いてから)
      await page.addInitScript(() => {
        const seen = window as unknown as Seen;
        seen.__dataTypes = [];
        const Native = window.WebSocket;
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener("message", (event) => {
              if (!(event.data instanceof ArrayBuffer) || !event.isTrusted)
                return;
              if (new DataView(event.data).getUint8(0) !== 0x30) return;
              const text = new TextDecoder().decode(
                new Uint8Array(event.data, 9),
              );
              seen.__dataTypes.push(
                (JSON.parse(text) as { type: string }).type,
              );
            });
          }
        };
      });
      await goto(page, "/live");
      await page.getByTestId("live-channel").first().click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      await chooseRaw(page);
      const canvas = page.getByTestId("live-raw");
      await expect(canvas).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          async () => Number((await canvas.getAttribute("data-shown")) ?? 0),
          {
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(10);

      await wakeControls(page, "live-frame");
      await page.getByTestId("live-data-button").click();
      await expect(page.getByTestId("live-data")).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 15_000 },
      );
      // サーバの PMT (NPT の部品だけ) より後に文書を流す。先に流すと、入口の無い PMT で文書が閉じる
      await expect
        .poll(
          () => page.evaluate(() => (window as unknown as Seen).__dataTypes),
          { timeout: 20_000 },
        )
        .toEqual(expect.arrayContaining(["pmt", "nptUpdated"]));

      await feedData(
        page,
        fakeDataBroadcast(
          [
            "<script><![CDATA[",
            'var fired = "";',
            'function show() { document.getElementById("npt").firstChild.data = browser.getNPT() + "|" + fired; }',
            'function soon() { fired += "a"; show(); }',
            'function late() { fired += "b"; show(); }',
            'browser.setInterval("show();", 200, 0);',
            "]]></script>",
            "<bevent>",
            // 選局してから 1 秒 (もう過ぎている) と 10 時間 (まだ来ない)
            '<beitem type="TimerFired" subscribe="subscribe" time_mode="NPT" time_value="1000" onoccur="soon();"/>',
            '<beitem type="TimerFired" subscribe="subscribe" time_mode="NPT" time_value="36000000" onoccur="late();"/>',
            "</bevent>",
            '<p id="npt" style="left:0px;top:0px;width:400px;height:40px;color-index:7;">init</p>',
          ].join("\n"),
        ),
      );

      const read = async () => {
        const text = (await dataElement(page, "span"))?.text ?? "";
        const [npt = "", fired = ""] = text.split("|");
        return { npt: Number(npt), fired };
      };
      // NPT が分かり、過ぎた時刻のタイマーだけが起きた
      await expect
        .poll(async () => (await read()).fired, { timeout: 15_000 })
        .toBe("a");
      const first = await read();
      expect(first.npt).toBeGreaterThan(1_000);
      // 選局してからの時間より大きくはならない (映しているコマは放送より遅れている)
      expect(first.npt).toBeLessThan(120_000);

      // コマが進むと NPT も進む。待った時間とおおよそ同じだけ
      const waitedFrom = Date.now();
      await page.waitForTimeout(3_000);
      const second = await read();
      const waited = Date.now() - waitedFrom;
      expect(second.npt - first.npt).toBeGreaterThan(waited - 1_500);
      expect(second.npt - first.npt).toBeLessThan(waited + 1_500);
      expect(second.fired).toBe("a");
    } finally {
      // 流したままだと、同じ偽の放送を使うデータ放送の E2E を乱す (`Knobs.npt`)
      await request.post(`${stack.agentUrl}/__control/npt?on=0`);
    }
  });
});
