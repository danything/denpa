import { rmSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { MX } from "../fake/services";
import {
  expect,
  flipSetting,
  goto,
  openSettings,
  pickCodec,
  recordOne,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";

/**
 * **音量** (`src/lib/components/player/volume.svelte.ts`・`src/lib/sound.ts`)。
 *
 * 放送は動画サイトより小さめにそろえてあるので、既定 (100%) は +6 dB で鳴らし、つまみで 0% まで下げられる。
 * 割れないようにリミッタを必ず通す。ここでは**鳴っている音を測る** — `AudioNode.connect` を包んで、音の入口
 * (`<video>` の音・canvas の経路のデコードした音) と出口 (ページの出口・`<audio>` へのストリーム) に
 * AnalyserNode を付け、RMS とピークを比べる。
 *
 * 音は合成のものだけ。`<video>` の経路は偽 ffmpeg の fMP4 (440Hz のサイン波。`tests/fake/fmp4-loop.ts`)、
 * canvas の経路 (MPEG-2。偽エージェントの音は無音) は入口に発振器をつないで測る
 */

/** 入口と出口に AnalyserNode を付ける (`measure`)。ページの中に `__hubs` として残す */
async function hookAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Hub {
      /** 入口がどちらの経路か */
      kind: "element" | "buffer";
      /** 音の入口がつながった先 (音量の GainNode・消音の GainNode) */
      input: AudioNode;
      pre: AnalyserNode;
      post: AnalyserNode | null;
    }
    const hubs = new Map<BaseAudioContext, Hub>();
    const posts = new Map<BaseAudioContext, AnalyserNode>();
    (globalThis as { __hubs?: unknown }).__hubs = hubs;
    const connect = AudioNode.prototype.connect as (
      this: AudioNode,
      ...args: unknown[]
    ) => unknown;
    /*
     * **測る所には、聞こえないほど小さな音 (-120 dBFS) をいつも足しておく。** Chromium は無音 (GainNode が 0 など) が来ると
     * AnalyserNode を回さなくなり、最後に測ったものを返し続ける (無音を測れない)
     */
    const analyser = (context: BaseAudioContext) => {
      const node = context.createAnalyser();
      node.fftSize = 2048;
      const floor = context.createConstantSource();
      floor.offset.value = 1e-6;
      connect.call(floor, node);
      floor.start();
      return node;
    };
    AudioNode.prototype.connect = function (
      this: AudioNode,
      ...args: unknown[]
    ) {
      const result = connect.apply(this, args);
      const [destination] = args;
      if (!(destination instanceof AudioNode)) return result;
      const context = this.context;
      if (
        destination instanceof AudioDestinationNode ||
        destination instanceof MediaStreamAudioDestinationNode
      ) {
        let post = posts.get(context);
        if (post === undefined) {
          post = analyser(context);
          posts.set(context, post);
        }
        connect.call(this, post);
        const hub = hubs.get(context);
        if (hub !== undefined) hub.post = post;
      }
      const kind =
        this instanceof MediaElementAudioSourceNode
          ? "element"
          : this instanceof AudioBufferSourceNode
            ? "buffer"
            : null;
      if (kind !== null) {
        let hub = hubs.get(context);
        if (hub === undefined) {
          hub = {
            kind,
            input: destination,
            pre: analyser(context),
            post: posts.get(context) ?? null,
          };
          hubs.set(context, hub);
        }
        hub.input = destination;
        connect.call(this, hub.pre);
      }
      return result;
    } as typeof AudioNode.prototype.connect;
  });
}

interface Level {
  /** RMS (dBFS) */
  rms: number;
  /** ピーク (dBFS) */
  peak: number;
}

/** `kind` の経路の入口と出口を `ms` の間測る。入口は `inject` で発振器をつないだらそちら */
async function measure(
  page: Page,
  kind: "element" | "buffer",
  ms = 1_000,
): Promise<{ pre: Level; post: Level }> {
  return await page.evaluate(
    async ({ kind, ms }) => {
      const hubs = (
        globalThis as unknown as {
          __hubs: Map<
            BaseAudioContext,
            {
              kind: string;
              pre: AnalyserNode;
              post: AnalyserNode | null;
              injected?: AnalyserNode;
            }
          >;
        }
      ).__hubs;
      const hub = [...hubs.entries()]
        .filter(([context, h]) => context.state !== "closed" && h.kind === kind)
        .at(-1)?.[1];
      if (hub === undefined || hub.post === null) throw new Error("未接続");
      const pre = hub.injected ?? hub.pre;
      const post = hub.post;
      const sums = { pre: [0, 0, 0], post: [0, 0, 0] };
      const buffer = new Float32Array(post.fftSize);
      const take = (node: AnalyserNode, sum: number[]) => {
        node.getFloatTimeDomainData(buffer);
        for (const v of buffer) {
          sum[0]! += v * v;
          sum[1]! += 1;
          sum[2] = Math.max(sum[2]!, Math.abs(v));
        }
      };
      // 測る所の窓 (2048 標本) に、変える前の音が残っている間は待つ
      await new Promise((r) => setTimeout(r, 200));
      const end = performance.now() + ms;
      while (performance.now() < end) {
        take(pre, sums.pre);
        take(post, sums.post);
        await new Promise((r) => setTimeout(r, 40));
      }
      const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
      const level = (sum: number[]) => ({
        rms: db(Math.sqrt(sum[0]! / sum[1]!)),
        peak: db(sum[2]!),
      });
      return { pre: level(sums.pre), post: level(sums.post) };
    },
    { kind, ms },
  );
}

/** `kind` の経路の入口に発振器をつなぐ (振幅 `amplitude`)。`measure` の入口はこちらになる。null で外す */
async function inject(
  page: Page,
  kind: "element" | "buffer",
  amplitude: number | null,
): Promise<void> {
  await page.evaluate(
    ({ kind, amplitude }) => {
      const store = globalThis as unknown as {
        __hubs: Map<
          BaseAudioContext,
          { kind: string; input: AudioNode; injected?: AnalyserNode }
        >;
        __stop?: () => void;
      };
      store.__stop?.();
      delete store.__stop;
      const entry = [...store.__hubs.entries()]
        .filter(([context, h]) => context.state !== "closed" && h.kind === kind)
        .at(-1);
      if (entry === undefined) throw new Error("未接続");
      const [context, hub] = entry;
      if (amplitude === null) {
        delete hub.injected;
        return;
      }
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 1000;
      const gain = context.createGain();
      gain.gain.value = amplitude;
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      oscillator.connect(gain);
      gain.connect(hub.input);
      gain.connect(analyser);
      oscillator.start();
      hub.injected = analyser;
      store.__stop = () => {
        oscillator.stop();
        gain.disconnect();
      };
    },
    { kind, amplitude },
  );
}

/** 経路の入口が来ている (`<video>` なら Web Audio に通した、canvas ならデコードした音を鳴らし始めた) */
async function waitHooked(
  page: Page,
  kind: "element" | "buffer",
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (kind) =>
            [
              ...(
                globalThis as unknown as {
                  __hubs: Map<
                    BaseAudioContext,
                    { kind: string; post: unknown }
                  >;
                }
              ).__hubs.entries(),
            ].some(
              ([context, h]) =>
                context.state === "running" &&
                h.kind === kind &&
                h.post !== null,
            ),
          kind,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** 舞台の testid。操作列を出すときに動かす所 */
const STAGE = { live: "live-frame", chase: "chase", watch: "watch-stage" };

/** ⚙ のつまみを `level` (%) に */
async function setVolume(
  page: Page,
  prefix: keyof typeof STAGE,
  level: number,
): Promise<void> {
  await wakeControls(page, STAGE[prefix]);
  await openSettings(page, prefix);
  await page.getByTestId(`${prefix}-volume`).fill(String(level));
  await expect(page.getByTestId(`${prefix}-volume`)).toHaveValue(String(level));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`${prefix}-settings-menu`)).toBeHidden();
}

/** 押したことにして AudioContext を起こし、断られて消音になっていれば音を出す */
async function letPlay(page: Page): Promise<void> {
  await page.keyboard.press("Shift");
  const unmute = page.getByRole("button", { name: "音を出す" }).first();
  if (await unmute.isVisible()) await unmute.click();
}

const near = (value: number, want: number, within = 0.6) =>
  expect(Math.abs(value - want), `${value} dB (目安 ${want} dB)`).toBeLessThan(
    within,
  );

test.describe("音量", () => {
  test.beforeEach(async ({ request, stack }) => {
    await syncEpg(request);
    writeFileSync(stack.liveFmp4File, "");
  });
  test.afterEach(async ({ stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
  });

  test("<video> の音: 100% は +6 dB、下げれば小さく 0% で無音。リミッタで割れず、消音も効き、読み直しても残る", async ({
    page,
  }) => {
    await hookAudio(page);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect
      .poll(
        () =>
          page
            .getByTestId("live-video")
            .evaluate((v) => (v as HTMLVideoElement).currentTime),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(1);
    await letPlay(page);
    await waitHooked(page, "element");

    // 既定 (100%) は +6 dB
    const full = await measure(page, "element");
    console.log("100%", JSON.stringify(full));
    near(full.post.rms - full.pre.rms, 6);

    // 50% は 100% より 12 dB 小さい
    await setVolume(page, "live", 50);
    const half = await measure(page, "element");
    console.log("50%", JSON.stringify(half));
    near(half.post.rms - half.pre.rms, 6 - 12.04);

    // 0% は無音
    await setVolume(page, "live", 0);
    const none = await measure(page, "element");
    expect(none.pre.rms).toBeGreaterThan(-40);
    expect(none.post.peak).toBeLessThan(-90);

    // 大きな音 (0 dBFS) を足しても、出口のピークは 0 dBFS を超えない
    await setVolume(page, "live", 100);
    await inject(page, "element", 1);
    const loud = await measure(page, "element", 1_500);
    console.log("0 dBFS を足した 100%", JSON.stringify(loud));
    expect(loud.pre.peak).toBeGreaterThan(-0.5);
    expect(loud.post.peak).toBeLessThan(0);
    await inject(page, "element", null);

    // 消音は音量とは別に効く
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-sound").click();
    const muted = await measure(page, "element");
    expect(muted.post.peak).toBeLessThan(-90);
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-sound").click();

    // 端末ごとに覚えていて、読み直しても残る
    await setVolume(page, "live", 70);
    await page.reload();
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await openSettings(page, "live");
    await expect(page.getByTestId("live-volume")).toHaveValue("70");
    // つまみは名前と値の下で、メニューの幅いっぱい (Pico の `[role="group"]` の横並びにしない)
    const slider = await page.getByTestId("live-volume").boundingBox();
    const head = await page
      .getByTestId("live-settings-menu")
      .locator(".volume-head")
      .boundingBox();
    expect(slider!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
    expect(Math.abs(slider!.width - head!.width)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await letPlay(page);
    await waitHooked(page, "element");
    const kept = await measure(page, "element");
    near(kept.post.rms - kept.pre.rms, 6 + 40 * Math.log10(0.7));
  });

  /*
   * canvas の経路 (MPEG-2) は RawEngine の中で掛ける。バックグラウンド再生をオンにして `<audio>` を通しても
   * (`Outlet.route`) 同じ所で効く
   */
  test("canvas の経路: バックグラウンド再生で <audio> を通しても、100% は +6 dB、消音で無音", async ({
    page,
  }) => {
    await hookAudio(page);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "mpeg2");
    const canvas = page.getByTestId("live-raw");
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-audio")) ?? 0),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);
    await letPlay(page);
    await waitHooked(page, "buffer");

    await wakeControls(page, "live-frame");
    await flipSetting(page, "live", "background");
    const audio = page.getByTestId("live-raw-audio");
    await expect
      .poll(() => audio.evaluate((a) => (a as HTMLAudioElement).paused), {
        timeout: 10_000,
      })
      .toBe(false);

    await inject(page, "buffer", 0.1);
    const full = await measure(page, "buffer");
    console.log("canvas 100%", JSON.stringify(full));
    near(full.post.rms - full.pre.rms, 6);

    await setVolume(page, "live", 50);
    const half = await measure(page, "buffer");
    near(half.post.rms - half.pre.rms, 6 - 12.04);

    await setVolume(page, "live", 100);
    await inject(page, "buffer", 1);
    const loud = await measure(page, "buffer", 1_500);
    console.log("canvas 0 dBFS を足した 100%", JSON.stringify(loud));
    expect(loud.post.peak).toBeLessThan(0);

    await wakeControls(page, "live-frame");
    await page.getByTestId("live-sound").click();
    const muted = await measure(page, "buffer");
    expect(muted.post.peak).toBeLessThan(-90);
    await inject(page, "buffer", null);
  });

  test("3画面で同じ音量を使い、観る画面と追っかけでは ↑↓ でも変えられる", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await setVolume(page, "live", 60);

    // 追っかけ (録っている最中の録画)
    expect(
      (
        await request.post("/live?/record", {
          form: { service: String(MX.id) },
        })
      ).ok(),
    ).toBe(true);
    let id = "";
    try {
      await expect(async () => {
        const list = (await (await request.get("/api/recordings")).json()) as {
          id: number;
          recording: boolean;
          program_id: number;
        }[];
        const rec = list.find((item) => item.recording);
        expect(rec).toBeDefined();
        id = String(rec!.id);
      }).toPass({ timeout: 60_000, intervals: [500] });
      await goto(page, `/chase/${id}`);
      await expect(page.getByTestId("chase-title")).toBeVisible();
      await wakeControls(page, STAGE.chase);
      await openSettings(page, "chase");
      await expect(page.getByTestId("chase-volume")).toHaveValue("60");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chase-settings-menu")).toBeHidden();
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      await page.keyboard.press("ArrowDown");
      await expect(page.getByTestId("chase-volume-note")).toHaveText(
        "音量 55%",
      );
    } finally {
      const services = (await (await request.get("/api/services")).json()) as {
        id: number;
        now: { id: number } | null;
      }[];
      const now = services.find((s) => s.id === MX.id)?.now;
      if (now)
        await request.post("/guide?/cancel", {
          form: { programId: String(now.id) },
        });
    }

    // 観る画面
    const { id: watchId } = await recordOne(page, request);
    await goto(page, `/watch/${watchId}`);
    await wakeControls(page, STAGE.watch);
    await openSettings(page, "watch");
    await expect(page.getByTestId("watch-volume")).toHaveValue("55");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("watch-settings-menu")).toBeHidden();
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("watch-volume-note")).toHaveText("音量 65%");
    // 100% より上には行かない
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("watch-volume-note")).toHaveText("音量 100%");
  });
});
