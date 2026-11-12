import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, goto } from "./helpers";

/**
 * 実況のテスト (57-jikkyo・57-jikkyo-write・57-jikkyo-list・57-jikkyo-recorded・57-jikkyo-recorded-list) の道具
 */

/** 設定画面の「実況」を切り替えて、保存し終えるまで */
export async function setJikkyo(page: Page, on: boolean): Promise<void> {
  await goto(page, "/settings/integrations");
  await page.getByTestId("jikkyo-setting").setChecked(on);
  await expect(page.getByTestId("saved-result")).toBeVisible();
}

/** 勢いの偽物 (`fakeRanking`) を置いたページ */
export const ranked = new WeakSet<Page>();

/** 端末の ⚙ の「実況」をオンにしておく (読み込む前に) */
export async function deviceOn(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("player-jikkyo", "1"));
  /*
   * 両方オンだとライブは「実況」タブで開き、勢いを訊く。サーバから NX-Jikkyo へ行かせないよう、空の返事にしておく
   * (勢いを見るテストの `fakeRanking` が先でも後でも、そちらを使う)
   */
  if (!ranked.has(page))
    await page.route("**/api/jikkyo/ranking", (route) =>
      route.fulfill({ json: { at: Date.now(), channels: [] } }),
    );
}

/** 書き込みの返事の偽物。`ok` は受け付けて、コメントの WS から `yourpost: 1` で戻す。`none` は返事をしない */
export type Reply = "ok" | "NOT_ON_AIR" | "INVALID_MESSAGE" | "none";

/** 画面が送った書き込み (`postComment` の `data`) */
export interface Posted {
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
export async function fakeNx(
  page: Page,
  opts: {
    refuse?: () => boolean;
    text?: string;
    /** 本文を替えて流す (それぞれを同じ時刻に) */
    texts?: string[];
    mail?: string;
    /** `texts` のそれぞれの `mail` (無いものは `mail`) */
    mails?: (string | undefined)[];
    quiet?: boolean;
    reply?: () => Reply;
  } = {},
): Promise<{
  watched: string[];
  posts: Posted[];
  /** コメントの WS へ、ほかの人の書き込みの形 (`yourpost` 無し) で流す。`offsets` は書かれた時刻を今からずらす量 (ms) */
  emit: (content: string, offsets?: number[]) => void;
}> {
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
            const texts = opts.texts ?? [opts.text ?? "テストのコメント"];
            texts.forEach((content, i) => {
              const mail = opts.mails?.[i] ?? opts.mail;
              ws.send(
                JSON.stringify({
                  chat: {
                    thread: "1",
                    date: Math.floor(at / 1000),
                    date_usec: (at % 1000) * 1000,
                    user_id: "fake",
                    ...(mail === undefined ? {} : { mail }),
                    content,
                  },
                }),
              );
            });
          }
        }, 500);
      });
      ws.onClose(() => {
        if (timer !== null) clearInterval(timer);
      });
    },
  );
  const emit = (content: string, offsets = [0]) => {
    for (const offset of offsets) {
      const at = Date.now() + offset;
      comments?.send(
        JSON.stringify({
          chat: {
            thread: "1",
            date: Math.floor(at / 1000),
            date_usec: (at % 1000) * 1000,
            user_id: "official",
            mail: "184",
            content,
          },
        }),
      );
    }
  };
  return { watched, posts, emit };
}
