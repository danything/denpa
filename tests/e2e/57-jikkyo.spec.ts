import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";

import { BS11, FUJI, MX } from "../fake/services";
import {
  expect,
  goto,
  openSettings,
  pickCodec,
  recordOne,
  test,
  wakeControls,
} from "./helpers";

/**
 * **ニコニコ実況のコメント** (docs/watch.md の「実況」)。既定はオフで、世帯の設定 (連携の「実況」) と
 * 端末の ⚙ の両方がオンのときだけ流す。
 *
 * **外 (NX-Jikkyo・過去ログ API) には繋がない。** 端末が繋ぐ WebSocket と fetch は
 * `page.routeWebSocket` と `page.route` で偽物に差し替え、勢いの中継 (`/api/jikkyo/ranking`) も
 * 画面からの呼び出しを `page.route` で差し替える (サーバの中継そのものは単体テストで見る)。
 *
 * 世帯の設定を切り替えるテストはこのファイルにまとめ、終わったら既定 (オフ) に戻す
 */

/** 設定画面の「実況」を切り替えて、保存し終えるまで */
async function setJikkyo(page: Page, on: boolean): Promise<void> {
  await goto(page, "/settings/integrations");
  await page.getByTestId("jikkyo-setting").setChecked(on);
  await expect(page.getByTestId("saved-result")).toBeVisible();
}

/** 局の一覧の API で、局の名前 → 実況のチャンネル */
async function channels(
  request: APIRequestContext,
): Promise<Record<string, string | null>> {
  const list = (await (await request.get("/api/services")).json()) as {
    name: string;
    jikkyo: string | null;
  }[];
  return Object.fromEntries(list.map((s) => [s.name, s.jikkyo]));
}

test.describe("実況の世帯の設定", () => {
  test("既定はオフ。オフの間は局の一覧に実況のチャンネルを載せず、勢いも返さない", async ({
    page,
    request,
  }) => {
    await goto(page, "/settings/integrations");
    await expect(page.getByTestId("jikkyo-setting")).not.toBeChecked();
    expect(
      Object.values(await channels(request)).every((c) => c === null),
    ).toBe(true);
    expect((await request.get("/api/jikkyo/ranking")).status()).toBe(403);
  });

  test("オンにすると、局の一覧に実況のチャンネルが載る", async ({
    page,
    request,
  }) => {
    await setJikkyo(page, true);
    try {
      const list = await channels(request);
      expect(list["ＴＯＫＹＯ　ＭＸ"]).toBe("jk9");
      expect(list["フジテレビ"]).toBe("jk8");
    } finally {
      await setJikkyo(page, false);
    }
  });
});

/** NX-Jikkyo の WebSocket の偽物。視聴の WS に room を返し、コメントの WS に `comments()` の本文を流し続ける */
async function fakeNx(
  page: Page,
  opts: { refuse?: () => boolean; text?: string } = {},
): Promise<{ watched: string[] }> {
  const watched: string[] = [];
  await page.routeWebSocket(
    /nx-jikkyo\.tsukumijima\.net\/.*\/ws\/watch$/,
    (ws) => {
      watched.push(ws.url());
      if (opts.refuse?.() === true) {
        void ws.close({ code: 1011, reason: "down" });
        return;
      }
      ws.onMessage((message) => {
        const body = JSON.parse(String(message)) as { type?: string };
        if (body.type !== "startWatching") return;
        ws.send(
          JSON.stringify({ type: "seat", data: { keepIntervalSec: 30 } }),
        );
        ws.send(
          JSON.stringify({
            type: "room",
            data: {
              messageServer: {
                uri: "wss://nx-jikkyo.tsukumijima.net/api/v1/channels/jk9/ws/comment",
              },
              threadId: "1",
              yourPostKey: "",
            },
          }),
        );
      });
    },
  );
  await page.routeWebSocket(
    /nx-jikkyo\.tsukumijima\.net\/.*\/ws\/comment$/,
    (ws: WebSocketRoute) => {
      let timer: ReturnType<typeof setInterval> | null = null;
      ws.onMessage(() => {
        ws.send(JSON.stringify({ thread: { resultcode: 0, thread: "1" } }));
        /*
         * 書かれた時刻を前後に散らして流し続ける。画面は映しているコマの放送時刻 (偽の放送の時計) に届いたものから流し、
         * 10 秒より古いものは捨てるので、放送時刻が壁時計より進んでいても遅れていても、どれかが当たるように
         */
        timer ??= setInterval(() => {
          for (const offset of [-5_000, 0, 5_000, 10_000, 20_000]) {
            const at = Date.now() + offset;
            ws.send(
              JSON.stringify({
                chat: {
                  thread: "1",
                  date: Math.floor(at / 1000),
                  date_usec: (at % 1000) * 1000,
                  user_id: "fake",
                  content: opts.text ?? "テストのコメント",
                },
              }),
            );
          }
        }, 500);
      });
      ws.onClose(() => {
        if (timer !== null) clearInterval(timer);
      });
    },
  );
  return { watched };
}

/** 端末の ⚙ の「実況」をオンにしておく (読み込む前に) */
async function deviceOn(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("player-jikkyo", "1"));
}

test.describe("ライブの実況", () => {
  test("世帯の設定がオフなら ⚙ に「実況」は出ない", async ({ page }) => {
    await goto(page, `/live?service=${MX.id}`);
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await expect(page.getByTestId("live-ambient")).toBeVisible();
    await expect(page.getByTestId("live-jikkyo")).toHaveCount(0);
  });

  test("両方オンなら NX-Jikkyo のコメントを映像の上に流し、⚙ で切れる", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page);
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      // 映像が進まないと放送時刻も進まない。偽の放送をそのままデコードできる MPEG-2 で観る (28-live-raw と同じ)
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const comment = page.getByTestId("jikkyo-comment").first();
      await expect(comment).toHaveText("テストのコメント", { timeout: 20_000 });
      expect(nx.watched[0]).toContain("/channels/jk9/ws/watch");
      // 読み上げには出さない
      await expect(page.getByTestId("jikkyo-layer")).toHaveAttribute(
        "aria-hidden",
        "true",
      );

      await wakeControls(page, "live-frame");
      await openSettings(page, "live");
      const row = page.getByTestId("live-jikkyo");
      await expect(row).toHaveAttribute("aria-checked", "true");
      await row.click();
      await expect(row).toHaveAttribute("aria-checked", "false");
      await expect(page.getByTestId("jikkyo-comment")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("NX-Jikkyo に繋がらなければ、⚙ の行に「(いまは読めません)」を添える (通知は出さない)", async ({
    page,
  }) => {
    // 5 回続けて失敗するまで 1+2+4+8 秒ほど待つ
    test.setTimeout(150_000);
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { refuse: () => true });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await openSettings(page, "live");
      await expect(page.getByTestId("live-jikkyo")).toContainText(
        "(いまは読めません)",
        { timeout: 60_000 },
      );
      await expect(page.getByTestId("live-jikkyo")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    } finally {
      await setJikkyo(page, false);
    }
  });
});

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
      // 偽の過去ログ。録画の頭の前後に 0.2 秒おきのコメント (自分で作ったもの)
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
       * 別の再生方法へ移らないように)、再生位置は時計で進める。偽の録画は 5 秒ほどしかないので、頭からゆっくり (1/4 の速さで)
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
      // 開いたときに 1 回だけ、録画の頭から訊く
      expect(asked).toHaveLength(1);
      expect(asked[0]!.pathname).toBe(`/api/kakolog/${target.channel}`);
      expect(asked[0]!.searchParams.get("starttime")).toBe(
        String(Math.floor(target.head / 1000)),
      );
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

test.describe("「実況」タブ", () => {
  /** 一覧に並んだ局の ID (上から) */
  const order = (page: Page) =>
    page
      .getByTestId("live-channel")
      .evaluateAll((rows) =>
        rows.map((row) => Number((row as HTMLElement).dataset["service"])),
      );

  test("どちらかの設定がオフならタブを出さない", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      // 端末の ⚙ はオフのまま
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-type-GR")).toBeVisible();
      await expect(page.getByTestId("live-type-jikkyo")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
    await deviceOn(page);
    await goto(page, `/live?service=${MX.id}`);
    await expect(page.getByTestId("live-type-GR")).toBeVisible();
    await expect(page.getByTestId("live-type-jikkyo")).toHaveCount(0);
  });

  test("勢いの順に並べ、並びは止めたまま数字だけ書き換える", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      // 勢いの中継は偽物に (サーバから NX-Jikkyo へは行かせない)
      const replies = [
        [
          { serviceId: MX.id, force: 5 },
          { serviceId: FUJI.id, force: 40 },
          { serviceId: BS11.id, force: 20 },
        ],
        [
          { serviceId: MX.id, force: 100 },
          { serviceId: FUJI.id, force: 1 },
          { serviceId: BS11.id, force: 2 },
        ],
      ];
      let asked = 0;
      await page.route("**/api/jikkyo/ranking", (route) => {
        const channels = replies[Math.min(asked, replies.length - 1)];
        asked++;
        return route.fulfill({ json: { at: Date.now(), channels } });
      });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await page.getByTestId("live-type-jikkyo").click();
      await expect(page.getByTestId("live-force").first()).toContainText("40");
      const first = await order(page);
      expect(first.slice(0, 3)).toEqual([FUJI.id, BS11.id, MX.id]);

      // 見えるようになったら取り直す (30 秒待たずに)。数字は替わり、並びは止めたまま
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      const mx = page.locator(
        `[data-testid="live-channel"][data-service="${MX.id}"]`,
      );
      await expect(mx.getByTestId("live-force")).toContainText("100");
      expect(await order(page)).toEqual(first);
      // ほかのタブには数を付けない
      await page.getByTestId("live-type-GR").click();
      await expect(page.getByTestId("live-force")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("読めないときは番号順で並べ、一覧の頭に 1 行だけ出す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await page.route("**/api/jikkyo/ranking", (route) =>
        route.fulfill({ status: 503, body: "いまは勢いを読めません" }),
      );
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await page.getByTestId("live-type-jikkyo").click();
      await expect(page.getByTestId("live-ranking-note")).toHaveText(
        "いまは勢いを読めません",
      );
      await expect(page.getByTestId("live-force")).toHaveCount(0);
      // 番号順 (地上波 → BS)
      const ids = await order(page);
      expect(ids.indexOf(BS11.id)).toBeGreaterThan(ids.indexOf(MX.id));
    } finally {
      await setJikkyo(page, false);
    }
  });
});
