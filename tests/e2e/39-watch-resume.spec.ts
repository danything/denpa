import { statSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, goto, setRecording, test } from "./helpers";
import { sharedRecording } from "./watch";

/**
 * **元の TS (MPEG-2) を流している途中で切れたら、受け取ったバイトの続きをリクエストする** (`ts/raw-resume.ts`・
 * `canvas-player.ts`)。手元に溜まっているぶんは捨てずに再生し続け、使い切るまでは「繋ぎ直しています」を出さない。
 *
 * 切るのはページの `fetch` で、最初の `stream?codec=mpeg2` の本文を `CUT` の割合のバイトまで渡し、描き始めてから
 * ネットワークのエラー (`TypeError`) にする (ブラウザが接続を失ったときと同じ形で `reader.read()` が失敗する)。
 * 偽の放送の録画は 5 秒で、プレイヤーは描き始める前に全部を読めるので、描き始めるまで切るのを待たないと、
 * 手元のぶんを再生する前に切れたことになる。中身は偽の放送を録った本物の MPEG-2 で、canvas にデコードして描く
 */

/** 最初の応答で渡す割合 (流し始めた位置から録画の終わりまでのうち) */
const CUT = 0.6;

/** ページの fetch で見た `stream?codec=mpeg2` の応答 */
interface RawFetch {
  url: string;
  /** 応答の `X-Denpa-Offset` */
  offset: string | null;
  /** 本文を渡したバイト数 */
  bytes: number;
  /** 本文を切ったか */
  cut: boolean;
}

/**
 * 最初の `stream?codec=mpeg2` の本文を、流し始めた位置から録画の終わりまでの `CUT` の割合で切る (録画の大きさは `total`)。切るのは描き始めて (`data-shown` が 10 コマを超えて) から。
 * 続き (`offset=`) の応答は `hold` ms 待たせてから返す。見た応答は `window.__raw` に並べる
 */
async function cutRawOnce(
  page: Page,
  total: number,
  hold: number,
): Promise<void> {
  await page.addInitScript(
    ([total, ratio, hold]) => {
      const real = window.fetch.bind(window);
      const seen: RawFetch[] = [];
      (window as unknown as { __raw: RawFetch[] }).__raw = seen;
      const shown = (): number =>
        Number(
          document
            .querySelector('[data-testid="live-raw"]')
            ?.getAttribute("data-shown") ?? 0,
        );
      let cutDone = false;
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!/\/stream\?/.test(url) || !url.includes("codec=mpeg2"))
          return real(input, init);
        if (url.includes("offset="))
          await new Promise((resolve) => setTimeout(resolve, hold));
        const response = await real(input, init);
        const entry: RawFetch = {
          url,
          offset: response.headers.get("x-denpa-offset"),
          bytes: 0,
          cut: false,
        };
        seen.push(entry);
        if (cutDone || response.body === null) return response;
        cutDone = true;
        // 流し始めた位置から録画の終わりまでのうち、`ratio` の割合で切る
        const cut = Math.floor((total - Number(entry.offset)) * ratio);
        const reader = response.body.getReader();
        // 読みに来たときだけ渡す (先回りして詰めると、エラーにしたときに詰めたぶんが捨てられる)
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (entry.bytes >= cut) {
                while (shown() <= 10)
                  await new Promise((resolve) => setTimeout(resolve, 20));
                entry.cut = true;
                controller.error(new TypeError("network error"));
                void reader.cancel().catch(() => undefined);
                return;
              }
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              const part = value.slice(0, cut - entry.bytes);
              entry.bytes += part.length;
              controller.enqueue(part);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      }) as typeof fetch;
    },
    [total, CUT, hold] as const,
  );
}

/** 「繋ぎ直しています」を 1 コマでも出したか (`window.__seen` に数える) */
async function countResuming(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = { resuming: 0 };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const look = (): void => {
      if (
        document
          .querySelector('[data-testid="watch-status"]')
          ?.textContent?.includes("繋ぎ直しています") === true
      )
        seen.resuming++;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

/** 録画の大きさ (`watchable` が録ったときに読む) */
let size = 0;
/** 2 本のテストで 1 本の録画を使い回す (中身は読むだけ) */
const watchable = sharedRecording(({ libraryPath }) => {
  size = statSync(libraryPath).size;
});

const rawFetches = (page: Page): Promise<RawFetch[]> =>
  page.evaluate(() => (window as unknown as { __raw: RawFetch[] }).__raw);
const resumingSeen = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as unknown as { __seen: { resuming: number } }).__seen.resuming,
  );

test.describe("観る画面で元の TS が途中で切れる", () => {
  test.beforeAll(async ({ request }) => {
    // エンコードしない録画 (元の TS を MPEG-2 のまま canvas に描く)
    await setRecording(request, { codecs: [] });
  });
  test.afterAll(async ({ request }) => {
    await setRecording(request, {});
  });

  test("手元が足りていれば、繋ぎ直しを出さずに受け取ったバイトの続きをリクエストして描き続ける", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await cutRawOnce(page, size, 0);
    await countResuming(page);

    await goto(page, `/watch/${id}`);
    const canvas = page.locator(
      '[data-testid="live-raw"][data-input="ts-mpeg2"]',
    );
    const shown = async (): Promise<number> =>
      Number((await canvas.getAttribute("data-shown")) ?? 0);
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // 切れたあと、受け取ったバイトの続きを 1 回だけリクエストする
    await expect
      .poll(async () => (await rawFetches(page)).length, { timeout: 30_000 })
      .toBe(2);
    const [first, next] = await rawFetches(page);
    expect(first!.cut).toBe(true);
    const asked = new URL(next!.url, "http://x");
    expect(asked.searchParams.get("offset")).toBe(
      String(Number(first!.offset) + first!.bytes),
    );
    expect(next!.offset).toBe(asked.searchParams.get("offset"));

    // 続きのぶんも描く (切れた所で止まらない)。終わりまで描いても、観ていた位置からリクエストし直さない
    const before = await shown();
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(before + 30);
    await page.waitForTimeout(3_000);
    expect(await rawFetches(page)).toHaveLength(2);
    expect(await resumingSeen(page)).toBe(0);
  });

  test("手元を使い切ったら「繋ぎ直しています」を出し、続きが届けば描き続ける", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    // 続きを手元のぶん (3 秒ほど) より長く待たせる
    await cutRawOnce(page, size, 6_000);
    await countResuming(page);

    await goto(page, `/watch/${id}`);
    const canvas = page.locator(
      '[data-testid="live-raw"][data-input="ts-mpeg2"]',
    );
    const shown = async (): Promise<number> =>
      Number((await canvas.getAttribute("data-shown")) ?? 0);
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("watch-status")).toContainText(
      "繋ぎ直しています",
      { timeout: 30_000 },
    );
    const stalled = await shown();
    await expect
      .poll(async () => (await rawFetches(page)).length, { timeout: 30_000 })
      .toBe(2);
    const [first, next] = await rawFetches(page);
    expect(new URL(next!.url, "http://x").searchParams.get("offset")).toBe(
      String(Number(first!.offset) + first!.bytes),
    );
    // 続きが届いたら覆いを外して描き続ける
    await expect(page.getByTestId("watch-status")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(stalled + 30);
    expect(await rawFetches(page)).toHaveLength(2);
  });
});
