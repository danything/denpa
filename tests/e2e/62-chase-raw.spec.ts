import { rmSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { MX } from "../fake/services";
import {
  expect,
  goto,
  pickCodec,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **追っかけも放送のまま (MPEG-2) で観る** ([docs/stream.md](../../docs/stream.md#追っかけも放送のままで送る))。
 *
 * E2E は 127.0.0.1 で開くので家の中で、「自動」なら追っかけも MPEG-2 になる (`#lib/live-choice.ts` の `autoOrder`)。
 * 録っている最中に観る (25-chase と同じく、地上波のいまの番組 (偽番組は30分) を録る)。偽の録画は本当にデコードできる
 * MPEG-2 と AAC なので (`packages/arib/src/synth-av.ts`)、canvas の描いたコマ数が進むところまで見る。
 * エンコードは失敗させておく (止めたあとエンコードできると元の TS が無くなり、リクエストし直しが断られる)
 */

/** 送った指示 (WebSocket の JSON)。開く前に仕込む */
async function recordCommands(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent = window as unknown as { __sent: Record<string, unknown>[] };
    sent.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") sent.__sent.push(JSON.parse(data));
      return send.call(this, data);
    };
  });
}

/** 送った指示のうち `type` のもの */
function commands(page: Page, type: string) {
  return page.evaluate(
    (type) =>
      (
        window as unknown as { __sent: Record<string, unknown>[] }
      ).__sent.filter((c) => c["type"] === type),
    type,
  );
}

test.describe("追っかけを MPEG-2 のまま観る", () => {
  /** 録っている番組 (止めるのに使う) */
  let programId: number | null = null;
  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });
  test.afterEach(async ({ request, stack }) => {
    // 地上波の偽番組は30分あるので、止めないと次のテストまでチューナーを塞ぐ
    if (programId !== null) {
      await request.post("/guide?/cancel", {
        form: { programId: String(programId) },
      });
    }
    programId = null;
    rmSync(stack.failFile, { force: true });
  });

  test("家の中の自動では MPEG-2 で描き、速さは出さず、止めている間はサーバに送るのを止めさせる", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    writeFileSync(stack.failFile, "1");
    const services = (await (await request.get("/api/services")).json()) as {
      id: number;
      now: { id: number } | null;
    }[];
    programId = services.find((s) => s.id === MX.id)?.now?.id ?? null;
    expect(programId, `${MX.name} にいま放送中の番組が要る`).not.toBeNull();
    expect(
      (
        await request.post("/live?/record", {
          form: { service: String(MX.id) },
        })
      ).ok(),
    ).toBe(true);
    let id = 0;
    await expect(async () => {
      type Item = { id: number; recording: boolean };
      const list = (await (
        await request.get("/api/recordings")
      ).json()) as Item[];
      id = list.find((rec) => rec.recording)?.id ?? 0;
      expect(id).toBeGreaterThan(0);
    }).toPass({ timeout: 120_000, intervals: [500] });
    // 録れている長さが少し要る (先頭から観て、戻すため)
    await page.waitForTimeout(12_000);

    await recordCommands(page);
    await goto(page, `/chase/${id}`);
    await expect(page.getByTestId("chase-title")).toBeVisible();

    // **元の TS をそのまま受け取って、この端末でデコードして描く**
    const canvas = page.locator(
      '[data-testid="live-raw"][data-input="ts-mpeg2"]',
    );
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const shown = async () =>
      Number((await canvas.getAttribute("data-shown")) ?? 0);
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-audio")) ?? 0),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    const [asked] = await commands(page, "chase");
    expect(asked).toMatchObject({ type: "chase", raw: true });
    await wakeControls(page, "chase");
    await expect(page.getByTestId("chase-codec")).toContainText(
      "自動 (MPEG-2)",
    );

    // 速さは等速だけ (互換モードと同じく、canvas に描くときは切り替えを出さない)
    await expect(page.getByTestId("chase-speed")).toHaveCount(0);

    // **止めたら送るのを止めさせ、止めた所から再開する** (リクエストし直さない)
    const play = page.getByTestId("chase-play");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "再生");
    await expect
      .poll(async () => (await commands(page, "hold")).at(-1))
      .toEqual({ type: "hold", on: true });
    const paused = await shown();
    await page.waitForTimeout(1_500);
    expect(await shown()).toBeLessThanOrEqual(paused + 2);
    await wakeControls(page, "chase");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(paused + 10);
    // 手元が 10 秒を切ったら送り直させる (`holdFeed`)
    await expect
      .poll(async () => (await commands(page, "hold")).at(-1), {
        timeout: 30_000,
      })
      .toEqual({ type: "hold", on: false });
    expect(await commands(page, "chase")).toHaveLength(1);

    /*
     * **戻すとリクエストし直し、戻した先から進む。** 再生位置は届いた PTS から録画の先頭の PTS (`timeline` の
     * `origin`) を引いて出す。読みものの「m:ss / m:ss」の左で見る
     */
    const status = page
      .getByTestId("chase-controls")
      .getByText(/^\d+:\d\d \/ \d+:\d\d$/);
    const where = async () => {
      const text = (await status.textContent()) ?? "";
      const [m = 0, s = 0] = text.split(" / ")[0]!.split(":").map(Number);
      return m * 60 + s;
    };
    await expect.poll(where, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
    const before = await where();
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => (await commands(page, "chase")).length)
      .toBe(2);
    const [, again] = await commands(page, "chase");
    expect(again).toMatchObject({ raw: true });
    expect(Number(again!["at"])).toBeLessThan(before);
    await expect
      .poll(where, { timeout: 15_000 })
      .toBeLessThan(Math.max(0, before - 10) + 3);
    const after = await where();
    await expect.poll(where, { timeout: 15_000 }).toBeGreaterThan(after);

    // **H.264 を選ぶとエンコードしたものを `<video>` で観て、速さも出る**
    await wakeControls(page, "chase");
    await pickCodec(page, "chase", "h264");
    await expect(page.getByTestId("live-raw")).toHaveCount(0, {
      timeout: 30_000,
    });
    const last = (await commands(page, "chase")).at(-1);
    expect(last).toMatchObject({ raw: false, codec: "h264" });
    await wakeControls(page, "chase");
    await expect(page.getByTestId("chase-speed")).toBeVisible();
  });
});
