import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";

import { MX } from "../fake/services";
import {
  expect,
  goto,
  openSettings,
  pickCodec,
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
