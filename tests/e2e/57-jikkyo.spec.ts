import type { APIRequestContext, Page } from "@playwright/test";

import { expect, goto, test } from "./helpers";

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
