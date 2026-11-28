import type { Page } from "@playwright/test";

import { workerStack } from "../stack";
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

/** 書き込みの返事の偽物。`ok` は受け付けて、購読にも流す */
export type Reply = "ok" | "rejected";

/** 画面が送った書き込み (denpa のサーバが hub へ送ったもの) */
export interface Posted {
  channel: string;
  author: string;
  text: string;
  color?: string;
  position?: string;
  size?: string;
}

/** 公式の視聴の WebSocket に送られた書き込み (`postComment` の `data`) */
export interface OfficialPost {
  text: string;
  vpos: number;
  isAnonymous: boolean;
}

function hub(): string {
  if (workerStack === null) throw new Error("ワーカーの 1 式が立っていません");
  return workerStack.hubUrl;
}

/**
 * 実況のコメントの偽物 (偽の denpa-hub の `/jikkyo/*`。`tests/fake/denpa-hub.ts`)。購読に `text` の本文 (`mail` 付き) を流し続ける
 * (`quiet` なら流さない)。書き込みは hub に貯まり、`reply` のとおりに返る。端末は外へ繋がず、denpa のサーバが hub に繋ぐ
 */
export async function fakeComments(
  opts: {
    refuse?: boolean;
    text?: string;
    /** 本文を替えて流す (それぞれを同じ時刻に) */
    texts?: string[];
    mail?: string;
    /** `texts` のそれぞれの `mail` (無いものは `mail`) */
    mails?: (string | undefined)[];
    quiet?: boolean;
    reply?: Reply;
    /** 過去ログの返事のコメント (`{ at, text, mail?, src }`)。`error` なら hub が 503 を返す */
    kakolog?: unknown[] | "error";
  } = {},
): Promise<{
  /** 購読された局 */
  watched: () => Promise<string[]>;
  posts: () => Promise<Posted[]>;
  /** 過去ログで訊かれたもの (`jk9?from=…&to=…`) */
  kakolog: () => Promise<string[]>;
  /** 購読へ流す。`offsets` は書かれた時刻を今からずらす量 (ms)。`src` は出どころ */
  emit: (text: string, offsets?: number[], src?: string) => Promise<void>;
}> {
  const { mails, ...rest } = opts;
  const control = await fetch(`${hub()}/__control/jikkyo`, {
    method: "POST",
    body: JSON.stringify({ ...rest, mails: mails?.map((m) => m ?? null) }),
  });
  if (!control.ok) throw new Error(`偽の hub: ${control.status}`);
  const state = async () =>
    (
      (await (await fetch(`${hub()}/__control/state`)).json()) as {
        jikkyo: { posts: Posted[]; watched: string[]; kakolog: string[] };
      }
    ).jikkyo;
  return {
    watched: async () => (await state()).watched,
    posts: async () => (await state()).posts,
    kakolog: async () => (await state()).kakolog,
    emit: async (text, offsets = [0], src = "nx") => {
      await fetch(`${hub()}/__control/jikkyo/emit`, {
        method: "POST",
        body: JSON.stringify({
          channel: "jk9",
          comments: offsets.map((offset) => ({
            at: Date.now() + offset,
            text,
            mail: "184",
            src,
          })),
        }),
      });
    },
  };
}
