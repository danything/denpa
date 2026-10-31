import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";

import { BS11, FUJI, MX } from "../fake/services";
import {
  expect,
  fakeFrame,
  goto,
  openSettings,
  overlayTroubles,
  pickCodec,
  recordOne,
  takeClip,
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

/** 書き込みの返事の偽物。`ok` は受け付けて、コメントの WS から `yourpost: 1` で戻す。`none` は返事をしない */
type Reply = "ok" | "NOT_ON_AIR" | "INVALID_MESSAGE" | "none";

/** 画面が送った書き込み (`postComment` の `data`) */
interface Posted {
  text: string;
  vpos: number;
  isAnonymous: boolean;
  color?: string;
  position?: string;
  size?: string;
}

/**
 * NX-Jikkyo の WebSocket の偽物。視聴の WS に room を返し、コメントの WS に `text` の本文 (`mail` 付き) を流し続ける
 * (`quiet` なら流さない)。書き込み (`postComment`) は `posts` に貯め、`reply` のとおりに返す
 */
async function fakeNx(
  page: Page,
  opts: {
    refuse?: () => boolean;
    text?: string;
    /** 本文を替えて流す (それぞれを同じ時刻に) */
    texts?: string[];
    mail?: string;
    quiet?: boolean;
    reply?: () => Reply;
  } = {},
): Promise<{ watched: string[]; posts: Posted[] }> {
  const watched: string[] = [];
  const posts: Posted[] = [];
  let comments: WebSocketRoute | null = null;
  await page.routeWebSocket(
    /nx-jikkyo\.tsukumijima\.net\/.*\/ws\/watch$/,
    (ws) => {
      watched.push(ws.url());
      if (opts.refuse?.() === true) {
        void ws.close({ code: 1011, reason: "down" });
        return;
      }
      ws.onMessage((message) => {
        const body = JSON.parse(String(message)) as {
          type?: string;
          data?: Posted;
        };
        if (body.type === "postComment" && body.data !== undefined) {
          const data = body.data;
          posts.push(data);
          const reply = opts.reply?.() ?? "ok";
          if (reply === "none") return;
          if (reply !== "ok") {
            ws.send(
              JSON.stringify({ type: "error", data: { message: reply } }),
            );
            return;
          }
          // 本物と同じく、コメントの WS へ先に流してから返事をする
          const mail = ["184", data.color, data.position, data.size]
            .filter((c) => c !== undefined)
            .join(" ");
          const at = Date.now();
          comments?.send(
            JSON.stringify({
              chat: {
                thread: "1",
                date: Math.floor(at / 1000),
                date_usec: (at % 1000) * 1000,
                user_id: "me",
                mail,
                yourpost: 1,
                content: data.text,
              },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "postCommentResult",
              data: { chat: { mail, anonymity: 1, content: data.text } },
            }),
          );
          return;
        }
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
              yourPostKey: "me",
              vposBaseTime: new Date(Date.now() - 3_600_000).toISOString(),
            },
          }),
        );
      });
    },
  );
  await page.routeWebSocket(
    /nx-jikkyo\.tsukumijima\.net\/.*\/ws\/comment$/,
    (ws: WebSocketRoute) => {
      comments = ws;
      let timer: ReturnType<typeof setInterval> | null = null;
      ws.onMessage(() => {
        ws.send(JSON.stringify({ thread: { resultcode: 0, thread: "1" } }));
        if (opts.quiet === true) return;
        /*
         * 書かれた時刻を前後に散らして流し続ける。画面は映しているコマの放送時刻 (偽の放送の時計) に届いたものから流し、
         * 10 秒より古いものは捨てるので、放送時刻が壁時計より進んでいても遅れていても、どれかが当たるように
         */
        timer ??= setInterval(() => {
          for (const offset of [-5_000, 0, 5_000, 10_000, 20_000]) {
            const at = Date.now() + offset;
            for (const content of opts.texts ?? [
              opts.text ?? "テストのコメント",
            ])
              ws.send(
                JSON.stringify({
                  chat: {
                    thread: "1",
                    date: Math.floor(at / 1000),
                    date_usec: (at % 1000) * 1000,
                    user_id: "fake",
                    ...(opts.mail === undefined ? {} : { mail: opts.mail }),
                    content,
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
  return { watched, posts };
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

test.describe("ライブの実況の色・位置・大きさ", () => {
  test("ほかの人のコメントの mail を読み、色を付けて上に止め、大きく出す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { text: "赤い上の字", mail: "184 red ue big" });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const comment = page.getByTestId("jikkyo-comment").first();
      await expect(comment).toHaveText("赤い上の字", { timeout: 20_000 });
      await expect(comment).toHaveClass(/\bstill\b/);
      await expect(comment).toHaveCSS("color", "rgb(255, 0, 0)");
      // 大きい (中の 1.25 倍)
      expect(
        await comment.evaluate(
          (el) =>
            parseFloat(getComputedStyle(el).fontSize) /
            parseFloat(getComputedStyle(el.parentElement!).fontSize),
        ),
      ).toBeCloseTo(1.25);
      // 上の行から積む (いちばん上のものは枠の上の端の近く)。止めたものは 3 秒残る
      const frame = (await page.getByTestId("jikkyo-layer").boundingBox())!;
      const tops = await page
        .getByTestId("jikkyo-comment")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(Math.min(...tops) - frame.y).toBeLessThan(frame.height / 4);
      await page.waitForTimeout(1_000);
      await expect(page.getByTestId("jikkyo-comment").first()).toBeVisible();
    } finally {
      await setJikkyo(page, false);
    }
  });
});

/** 設定画面の NG ワードを書き換えて、保存し終えるまで (欄を離れたときに保存する) */
async function setNg(page: Page, text: string): Promise<void> {
  await goto(page, "/settings/integrations");
  const field = page.getByTestId("jikkyo-ng");
  await field.fill(text);
  await field.blur();
  await expect(page.getByTestId("saved-result")).toBeVisible();
}

test.describe("実況の NG ワード", () => {
  test("NG ワードを含むコメントは流さない (半角カナで書いても、ひらがなのものに効く)", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await setNg(page, "ﾈﾀﾊﾞﾚ\n\n");
      // 空の行は落として保存する
      await goto(page, "/settings/integrations");
      await expect(page.getByTestId("jikkyo-ng")).toHaveValue("ﾈﾀﾊﾞﾚ");
      await fakeNx(page, { texts: ["ねたばれ注意", "ふつうのコメント"] });
      await deviceOn(page);
      await goto(page, `/live?service=${MX.id}`);
      await expect(page.getByTestId("live-title")).toBeVisible();
      await wakeControls(page, "live-frame");
      await pickCodec(page, "live", "mpeg2");
      const comments = page.getByTestId("jikkyo-comment");
      await expect(comments.first()).toHaveText("ふつうのコメント", {
        timeout: 20_000,
      });
      await page.waitForTimeout(1_000);
      expect(await comments.allTextContents()).not.toContain("ねたばれ注意");
    } finally {
      await setNg(page, "");
      await setJikkyo(page, false);
    }
  });

  test("多すぎる・長すぎる NG ワードは保存せず、理由を出す", async ({
    page,
  }) => {
    await goto(page, "/settings/integrations");
    const field = page.getByTestId("jikkyo-ng");
    await field.fill("あ".repeat(41));
    await field.blur();
    await expect(page.getByTestId("settings-error")).toContainText(
      "1 語は 40 文字までです",
    );
    await expect(field).toHaveValue("");
  });
});

/** 書き込みが CSP に止められていないか (読み込む前に控えを仕掛ける) */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen = window as unknown as { __csp: string[] };
    seen.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.__csp.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

/** ライブを MPEG-2 で観て (放送時刻が進むように)、書き込む 1 行を開く */
async function openWriting(page: Page): Promise<void> {
  await deviceOn(page);
  await goto(page, `/live?service=${MX.id}`);
  await expect(page.getByTestId("live-title")).toBeVisible();
  await wakeControls(page, "live-frame");
  await pickCodec(page, "live", "mpeg2");
  await wakeControls(page, "live-frame");
  await page.getByTestId("live-write").click();
  await expect(page.getByTestId("jikkyo-compose-input")).toBeFocused();
  // 映像が出て「いま」に追い付くまで
  await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
    "NX-Jikkyo に書きます",
    { timeout: 20_000 },
  );
}

test.describe("ライブで実況に書き込む", () => {
  test("選んだ色・位置・大きさで送り、すぐ流す。戻ってきた同じものは 2 度流さない", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      const csp = await watchViolations(page);
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page);
      // 開いている間は操作バーを引っ込めない
      await page.waitForTimeout(3_000);
      await expect(page.getByTestId("live-controls")).toHaveAttribute(
        "data-shown",
        "true",
      );

      await page.getByTestId("jikkyo-style-button").click();
      await page.getByTestId("jikkyo-color-red").click();
      await page.getByTestId("jikkyo-position-shita").click();
      await page.getByTestId("jikkyo-size-big").click();
      await expect(page.getByTestId("jikkyo-color-red")).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("自分の書き込み");
      await input.press("Enter");
      await expect(input).toHaveValue("");
      expect(nx.posts).toHaveLength(1);
      expect(nx.posts[0]).toMatchObject({
        text: "自分の書き込み",
        isAnonymous: true,
        color: "red",
        position: "shita",
        size: "big",
      });
      expect(nx.posts[0]!.vpos).toBeGreaterThan(0);

      const mine = page.getByTestId("jikkyo-comment");
      await expect(mine).toHaveCount(1);
      await expect(mine).toHaveText("自分の書き込み");
      await expect(mine).toHaveClass(/\bmine\b/);
      await expect(mine).toHaveCSS("color", "rgb(255, 0, 0)");
      // 下に止める (枠の下半分)
      const frame = (await page.getByTestId("jikkyo-layer").boundingBox())!;
      const box = (await mine.boundingBox())!;
      expect(box.y - frame.y).toBeGreaterThan(frame.height / 2);
      // 戻ってきた yourpost のものは流さない
      await page.waitForTimeout(1_000);
      await expect(mine).toHaveCount(1);

      // 3 秒空けないと送らない
      await input.fill("続けて");
      await input.press("Enter");
      await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
        "3 秒待ってください",
      );
      await expect(input).toHaveValue("続けて");
      expect(nx.posts).toHaveLength(1);

      // 選んだものは端末ごとに覚える
      await page.getByTestId("jikkyo-compose-close").click();
      await expect(page.getByTestId("jikkyo-compose")).toHaveCount(0);
      await page.reload();
      await page.locator('[data-hydrated="true"]').waitFor();
      await wakeControls(page, "live-frame");
      await page.getByTestId("live-write").click();
      await page.getByTestId("jikkyo-style-button").click();
      await expect(page.getByTestId("jikkyo-position-shita")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await csp()).toEqual([]);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("受け付けられなければ、理由を 1 行で出して本文を残す。Esc で閉じる", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true, reply: () => "INVALID_MESSAGE" });
      await openWriting(page);
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("断られる書き込み");
      await page.getByTestId("jikkyo-compose-send").click();
      await expect(page.getByTestId("jikkyo-compose-line")).toHaveText(
        "この書き込みは受け付けられませんでした",
      );
      await expect(input).toHaveValue("断られる書き込み");
      await expect(page.getByTestId("jikkyo-comment")).toHaveCount(0);
      await input.press("Escape");
      await expect(page.getByTestId("jikkyo-compose")).toHaveCount(0);
      await expect(page.getByTestId("live-write")).toBeFocused();
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("変換中の Enter では送らない", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page);
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("へんかんちゅう");
      await input.evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await page.waitForTimeout(500);
      expect(nx.posts).toHaveLength(0);
      await expect(input).toHaveValue("へんかんちゅう");
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("止めていると書けない", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      const nx = await fakeNx(page, { quiet: true });
      await openWriting(page);
      await page.getByTestId("live-play").click();
      const line = page.getByTestId("jikkyo-compose-line");
      await expect(line).toHaveText("ライブに戻ると書けます");
      const input = page.getByTestId("jikkyo-compose-input");
      await input.fill("止めたまま");
      await input.press("Enter");
      await expect(line).toHaveText("ライブに戻ると書けます");
      expect(nx.posts).toHaveLength(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("スマホの幅では下のタブのすぐ上に出す", async ({ page }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true });
      await openWriting(page);
      // コーデックは広い幅で選び (狭い幅では ⚙ の中の並びが違う)、開いたまま縮める
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("tabbar")).toBeVisible();
      const compose = (await page.getByTestId("jikkyo-compose").boundingBox())!;
      const tabbar = (await page.getByTestId("tabbar").boundingBox())!;
      expect(compose.y + compose.height).toBeLessThanOrEqual(tabbar.y);
      expect(tabbar.y - (compose.y + compose.height)).toBeLessThan(16);
    } finally {
      await setJikkyo(page, false);
    }
  });

  /*
   * 「書く」で右端の縦の列が4つになる。スマホの縦の低い枠では、列を下の操作バーの上で止め、
   * 入りきらないものを左へもう1列に並べる (丸は縮めない。全画面のボタンに重ねない)
   */
  test("スマホの縦でも、右端の列は下の操作バーに重ならない", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeNx(page, { quiet: true });
      await deviceOn(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await goto(page, `/live?service=${MX.id}`);
      await wakeControls(page, "live-frame");
      const write = page.getByTestId("live-write");
      await expect(write).toBeVisible();
      await expect(page.getByTestId("live-seek")).toBeVisible();
      expect(await overlayTroubles(page, "live-frame")).toEqual([]);

      const record = (await page.getByTestId("live-record").boundingBox())!;
      const pencil = (await write.boundingBox())!;
      const seek = (await page.getByTestId("live-seek").boundingBox())!;
      // 丸は 40px のまま。右の縁の列はそのままで、「書く」はその左に
      expect(pencil.width).toBe(40);
      expect(pencil.height).toBe(40);
      expect(pencil.x + pencil.width).toBeLessThanOrEqual(record.x);
      for (const id of ["live-record", "live-data-button", "live-shot"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x).toBe(record.x);
        // 再生位置のバーにも掛からない
        expect(box.y + box.height).toBeLessThanOrEqual(seek.y);
      }
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

  /**
   * 勢いの中継を偽物に (サーバから NX-Jikkyo へは行かせない)。
   * 1 回目は フジ > BS11 > MX、2 回目からは MX > BS11 > フジ
   */
  async function fakeRanking(page: Page): Promise<void> {
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
  }

  /** タブを開き、1 回目の返事で並ぶまで */
  async function openTab(page: Page): Promise<void> {
    await deviceOn(page);
    await goto(page, `/live?service=${MX.id}`);
    await page.getByTestId("live-type-jikkyo").click();
    await expect(page.getByTestId("live-force").first()).toContainText("40");
    expect((await order(page)).slice(0, 3)).toEqual([FUJI.id, BS11.id, MX.id]);
  }

  /** 見えるようになったことにして、30 秒待たずに取り直させる (2 回目の返事)。MX の数字が替わるまで */
  async function refresh(page: Page): Promise<void> {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page
        .locator(`[data-testid="live-channel"][data-service="${MX.id}"]`)
        .getByTestId("live-force"),
    ).toContainText("100");
  }

  /** 行が滑り始めた回数を数える (並べ直した行の `translate` の transition) */
  async function countSlides(page: Page): Promise<() => Promise<number>> {
    await page.evaluate(() => {
      const box = window as unknown as { slides: number };
      box.slides = 0;
      document.addEventListener("transitionrun", (event) => {
        if (event.propertyName === "translate") box.slides++;
      });
    });
    return () =>
      page.evaluate(() => (window as unknown as { slides: number }).slides);
  }

  test("数字が新しくなるたびに勢いの順に並べ直す。動きを減らす設定では滑らせずに置き換える", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeRanking(page);
      await openTab(page);
      const slid = await countSlides(page);
      await refresh(page);
      expect((await order(page)).slice(0, 3)).toEqual([
        MX.id,
        BS11.id,
        FUJI.id,
      ]);
      // E2E の既定は動きを減らす設定 (`playwright.config.ts`)。時間が 0 なので滑らない
      expect(await slid()).toBe(0);
      // ほかのタブには数を付けない
      await page.getByTestId("live-type-GR").click();
      await expect(page.getByTestId("live-force")).toHaveCount(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("動きを減らす設定でなければ、並べ直した行は前の場所から滑る", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await setJikkyo(page, true);
    try {
      await fakeRanking(page);
      await openTab(page);
      const slid = await countSlides(page);
      await refresh(page);
      expect((await order(page)).slice(0, 3)).toEqual([
        MX.id,
        BS11.id,
        FUJI.id,
      ]);
      await expect.poll(slid).toBeGreaterThan(0);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("一覧にポインタが乗っている間は並べ直さず、離れたら並べ直す", async ({
    page,
  }) => {
    await setJikkyo(page, true);
    try {
      await fakeRanking(page);
      await openTab(page);
      const first = await order(page);
      // 押そうとして 3 番目の行 (MX) に乗せる
      const mx = page.locator(
        `[data-testid="live-channel"][data-service="${MX.id}"]`,
      );
      await mx.hover();
      await refresh(page);
      // 数字は替わるが、並びはそのまま。待っても乗っている間は替えない
      expect(await order(page)).toEqual(first);
      await page.waitForTimeout(1_500);
      expect(await order(page)).toEqual(first);
      // 離れたら (少し待って) 並べ直す
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await order(page)).slice(0, 3))
        .toEqual([MX.id, BS11.id, FUJI.id]);
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
