import {
  expect,
  fakeFrame,
  goto,
  openSettings,
  recordOne,
  takeClip,
  test,
  wakeControls,
} from "./helpers";
import { deviceOn, setJikkyo } from "./jikkyo";

/**
 * **録画の実況** (docs/watch.md の「実況」)。過去ログ API は `page.route` で偽物に差し替える。
 *
 * 57-jikkyo から分けたもの。どれも録画を 1 本録ってから見るので、まとめると 1 分を超える。
 * コメントを流すところと読めないときをここに、コメントの一覧を 57-jikkyo-recorded-list に分けて並べて流す。
 * 世帯の設定は終わったら既定 (オフ) に戻す
 */

test.describe("録画の実況", () => {
  test("録画の区間のコメントを過去ログ API から 1 回で取り、再生位置の放送時刻に合わせて流す", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    await setJikkyo(page, true);
    try {
      const state = (await (
        await request.get(`/api/recordings/${id}`)
      ).json()) as {
        jikkyo: { channel: string; head: number; end: number } | null;
      };
      const target = state.jikkyo;
      if (target === null) throw new Error("録画に実況のチャンネルが無い");
      // 偽の過去ログ。録画の先頭の前後に 0.2 秒おきのコメント (自分で作ったもの)
      const asked: URL[] = [];
      await page.route(
        "https://jikkyo.tsukumijima.net/api/kakolog/**",
        (route) => {
          asked.push(new URL(route.request().url()));
          const packet = [];
          for (let ms = -60_000; ms < 10 * 60_000; ms += 200) {
            const at = target.head + ms;
            packet.push({
              chat: {
                thread: "1",
                date: String(Math.floor(at / 1000)),
                date_usec: String((at % 1000) * 1000),
                user_id: "fake",
                content: "録画のコメント",
              },
            });
          }
          return route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ packet }),
          });
        },
      );
      await deviceOn(page);
      /*
       * 偽 ffmpeg は映像を作らないので、録画は再生できない。映像の取得は返さずに待たせ (読めない形式で
       * 別の再生方法へ移らないように)、再生位置は時計で進める。偽の録画は 5 秒ほどしかないので、先頭からゆっくり (1/4 の速さで)
       */
      await page.route(/\/api\/recordings\/\d+\/(file|stream)/, () => {});
      await page.addInitScript(() => {
        const from = Date.now();
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
          configurable: true,
          get: () => (Date.now() - from) / 4000,
          set: () => {},
        });
      });
      await goto(page, `/watch/${id}`);
      await expect(page.getByTestId("jikkyo-comment").first()).toHaveText(
        "録画のコメント",
        { timeout: 20_000 },
      );
      // 開いたときに 1 回だけ、録画の先頭から訊く
      expect(asked).toHaveLength(1);
      expect(asked[0]!.pathname).toBe(`/api/kakolog/${target.channel}`);
      expect(asked[0]!.searchParams.get("starttime")).toBe(
        String(Math.floor(target.head / 1000)),
      );

      // 切り抜きには流れているコメントも写る。映像とは分けて送り、あとから出し入れできる
      await fakeFrame(page, "watch-video");
      await wakeControls(page, "watch-stage");
      const posted = page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          new URL(req.url()).pathname.endsWith("/api/clips"),
      );
      const clip = await takeClip(page, "watch-shot");
      expect(
        (await posted).postDataBuffer()?.toString("latin1") ?? "",
      ).toContain('name="comments"');
      expect(clip.layers.comments).toBe(true);
      await request.delete(`/api/clips/${clip.id}`);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("過去ログ API が誤りを返したら、⚙ の行に「(いまは読めません)」を添える", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    await setJikkyo(page, true);
    try {
      await page.route(
        "https://jikkyo.tsukumijima.net/api/kakolog/**",
        (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ error: "テストの誤り" }),
          }),
      );
      await deviceOn(page);
      await goto(page, `/watch/${id}`);
      await wakeControls(page, "watch-stage");
      await openSettings(page, "watch");
      await expect(page.getByTestId("watch-jikkyo")).toContainText(
        "(いまは読めません)",
      );
    } finally {
      await setJikkyo(page, false);
    }
  });
});
