import type { Locator } from "@playwright/test";

import { expect, goto, recordOne, test } from "./helpers";
import { deviceOn, setJikkyo } from "./jikkyo";

/**
 * **録画の実況** のコメントの一覧 (docs/watch.md の「実況」)。過去ログ API は `page.route` で偽物に差し替える。
 *
 * 57-jikkyo-recorded から分けたもの。どれも録画を 1 本録ってから見るので、まとめると 1 分を超える。
 * 別のファイルにして並べて流す。世帯の設定は終わったら既定 (オフ) に戻す
 */

test.describe("録画の実況", () => {
  test("コメントの一覧は再生位置に合わせて読み直し、行を押すとその時刻へ飛ぶ", async ({
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
      // 偽の過去ログ。録画の先頭から 0.1 秒おきに、先頭からの番号を本文にしたコメント
      await page.route(
        "https://jikkyo.tsukumijima.net/api/kakolog/**",
        (route) => {
          const packet = [];
          for (let n = 0; n < 1200; n++) {
            const at = target.head + n * 100;
            packet.push({
              chat: {
                thread: "1",
                date: String(Math.floor(at / 1000)),
                date_usec: String((at % 1000) * 1000),
                user_id: "fake",
                content: `${n}番`,
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
      await page.addInitScript(() =>
        localStorage.setItem("player-jikkyo-list", "1"),
      );
      /*
       * 再生位置は時計で進める (上と同じく偽の録画は再生できない)。飛んだら (`currentTime` を書いたら) そこから進める。
       * 偽の録画は数秒しかなく、それより先の放送時刻は録画の終わりに留まるので、戻る向きに飛んで確かめる
       */
      await page.route(/\/api\/recordings\/\d+\/(file|stream)/, () => {});
      await page.addInitScript(() => {
        let base = 0;
        let from = Date.now();
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
          configurable: true,
          get: () => base + (Date.now() - from) / 2000,
          set: (to: number) => {
            base = to;
            from = Date.now();
          },
        });
      });
      await goto(page, `/watch/${id}`);
      const rows = page.getByTestId("jikkyo-list-row");
      const number = async (row: Locator) =>
        Number(
          /^(\d+)番/.exec(
            (await row.locator(".text").textContent()) ?? "",
          )?.[1],
        );
      // 進むにつれて、新しいものが下に増える
      await expect
        .poll(() => rows.count(), { timeout: 30_000 })
        .toBeGreaterThan(20);
      const before = await number(rows.last());
      await expect.poll(() => number(rows.last())).toBeGreaterThan(before);

      // 時刻は書かれた時刻ではなく、録画の中の再生位置 (操作バーの位置と同じ形)。押せるボタン
      const count = await rows.count();
      const pick = rows.nth(count - 20);
      const at = pick.getByTestId("jikkyo-list-at");
      const label = (await at.textContent()) ?? "";
      expect(label).toMatch(/^\d+:\d{2}$/);
      await expect(at).toHaveAttribute("aria-label", `${label} へ移る`);
      expect(await at.evaluate((el) => el.tagName)).toBe("BUTTON");
      // 時刻を押すと、その位置へ戻り、そこまでのもので並べ直す
      const to = await number(pick);
      await at.click();
      await expect.poll(() => number(rows.last())).toBeLessThan(to + 10);
      expect(await number(rows.last())).toBeGreaterThanOrEqual(to);
    } finally {
      await setJikkyo(page, false);
    }
  });

  test("録画では、再生位置より後のコメントを「ここから先」の下に控えた字で並べる。下へ巻かなければ見えない", async ({
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
      // 偽の過去ログ。録画の先頭から 0.1 秒おきに、先頭からの番号を本文にしたコメント
      await page.route(
        "https://jikkyo.tsukumijima.net/api/kakolog/**",
        (route) => {
          const packet = [];
          for (let n = 0; n < 1200; n++) {
            const at = target.head + n * 100;
            packet.push({
              chat: {
                thread: "1",
                date: String(Math.floor(at / 1000)),
                date_usec: String((at % 1000) * 1000),
                user_id: "fake",
                content: `${n}番`,
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
      await page.addInitScript(() =>
        localStorage.setItem("player-jikkyo-list", "1"),
      );
      // 再生位置は止めておく (1.5 秒)。飛んだら (`currentTime` を書いたら) そこに留まる
      await page.route(/\/api\/recordings\/\d+\/(file|stream)/, () => {});
      await page.addInitScript(() => {
        let at = 1.5;
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
          configurable: true,
          get: () => at,
          set: (to: number) => {
            at = to;
          },
        });
      });
      await goto(page, `/watch/${id}`);
      const scroller = page.getByTestId("jikkyo-list-rows");
      const rows = page.getByTestId("jikkyo-list-row");
      const ahead = page.getByTestId("jikkyo-list-ahead-row");
      const mark = page.getByTestId("jikkyo-list-ahead");
      const back = page.getByTestId("jikkyo-list-latest");
      const number = async (row: Locator) =>
        Number(
          /^(\d+)番/.exec(
            (await row.locator(".text").textContent()) ?? "",
          )?.[1],
        );
      await expect
        .poll(() => rows.count(), { timeout: 30_000 })
        .toBeGreaterThan(5);
      // 再生位置までの次のものから
      expect(await number(ahead.first())).toBe((await number(rows.last())) + 1);
      // ふだんの見え方は変わらない。再生位置までのいちばん新しい行が下の端で、この先は下の外
      const box = (await scroller.boundingBox())!;
      const newest = (await rows.last().boundingBox())!;
      expect(
        Math.abs(box.y + box.height - (newest.y + newest.height)),
      ).toBeLessThan(2);
      expect((await mark.boundingBox())!.y).toBeGreaterThanOrEqual(
        box.y + box.height - 1,
      );
      await expect(back).toHaveCount(0);

      // 下へ巻くと「ここから先」の後に、控えた字で出る。付いていくのを止め、「いまへ」を出す
      await scroller.evaluate((el) => {
        el.scrollTop += el.clientHeight / 2;
      });
      await expect(back).toHaveText("いまへ");
      const shown = (await mark.boundingBox())!;
      expect(shown.y).toBeGreaterThanOrEqual(box.y);
      expect(shown.y + shown.height).toBeLessThanOrEqual(box.y + box.height);
      const color = (row: Locator) =>
        row.locator(".text").evaluate((el) => getComputedStyle(el).color);
      const muted = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--dp-muted)";
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      expect(await color(ahead.first())).toBe(muted);
      expect(await color(rows.last())).not.toBe(muted);

      // この先の行を押すとそこへ飛び、その「いま」で並べ直す
      const pick = ahead.nth(3);
      const to = await number(pick);
      await pick.click();
      await expect.poll(() => number(rows.last())).toBe(to);
      await expect.poll(() => number(ahead.first())).toBe(to + 1);
      await expect(back).toHaveCount(0);

      // 「いまへ」で戻る (下へ巻いても、上へ巻いても)。押してすぐでも、ホイールで巻けば止まる
      for (const down of [true, false]) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, down ? 2_000 : -5_000);
        await expect(back).toBeVisible();
        await back.click();
        await expect(back).toHaveCount(0);
        const again = (await scroller.boundingBox())!;
        expect((await mark.boundingBox())!.y).toBeGreaterThanOrEqual(
          again.y + again.height - 1,
        );
      }
    } finally {
      await setJikkyo(page, false);
    }
  });
});
