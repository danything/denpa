import { rmSync, writeFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

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

/**
 * 音のボタンに乗せて、浮かんだ縦のつまみを返す (マウスの端末。広い枠では ⚙ につまみは無い)。
 * 返したあともポインタはボタンの上に残る
 */
async function soundSlider(
  page: Page,
  prefix: keyof typeof STAGE,
): Promise<Locator> {
  await wakeControls(page, STAGE[prefix]);
  await page.getByTestId(`${prefix}-sound`).hover();
  const slider = page.getByTestId(`${prefix}-sound-volume`);
  await expect(slider).toBeVisible();
  return slider;
}

/** 音のボタンの縦のつまみを `level` (%) に。フォーカスはつまみから外す (キーを画面に渡す) */
async function setVolume(
  page: Page,
  prefix: keyof typeof STAGE,
  level: number,
): Promise<void> {
  const slider = await soundSlider(page, prefix);
  await slider.fill(String(level));
  await expect(slider).toHaveValue(String(level));
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
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
    await expect(await soundSlider(page, "live")).toHaveValue("70");
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

  test("3画面で同じ音量を使い、どの画面でも ↑↓ で変えられる", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await setVolume(page, "live", 50);
    // ライブも ↑↓ で変わり、映像の上に今の音量を出す
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("live-volume-note")).toHaveText("音量 55%");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("live-volume-note")).toHaveText("音量 60%");
    // m で消音の切り替え (追っかけ・観る画面と同じ割り当て)
    const sound = page.getByTestId("live-sound");
    const name = (await sound.getAttribute("aria-label"))!;
    await page.keyboard.press("m");
    await expect(sound).not.toHaveAccessibleName(name);
    await page.keyboard.press("m");
    await expect(sound).toHaveAccessibleName(name);
    await expect(await soundSlider(page, "live")).toHaveValue("60");

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
      await expect(await soundSlider(page, "chase")).toHaveValue("60");
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
    await expect(await soundSlider(page, "watch")).toHaveValue("55");
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

/**
 * **音のボタンに乗せると縦のつまみが浮かぶ** (`SoundButton`)。マウスで指せる端末だけ。
 * 指の端末 (車のタブレットなど) と、畳んで音のボタンごと ⚙ に入ったときは ⚙ のつまみを使う (つまみは画面に1つだけ)
 */
test.describe("音のボタンの縦のつまみ", () => {
  test("乗せると真上に出て、縦に動かす・ホイールで変わり、⚙ には置かない。外れたら閉じ、キーボードでも開く", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const button = page.getByTestId("live-sound");
    const pop = page.getByTestId("live-sound-pop");
    const slider = page.getByTestId("live-sound-volume");

    await wakeControls(page, STAGE.live);
    await expect(pop).toBeHidden();
    await button.hover();
    await expect(pop).toBeVisible();
    // ボタンの真上に、縦長で
    const at = (await button.boundingBox())!;
    const box = (await slider.boundingBox())!;
    expect(box.height).toBeGreaterThan(box.width);
    expect(box.y + box.height).toBeLessThanOrEqual(at.y + 1);
    expect(
      Math.abs(box.x + box.width / 2 - (at.x + at.width / 2)),
    ).toBeLessThan(2);
    await expect(slider).toHaveValue("100");

    // 下の端までつまんで下ろすと 0%、半ばまで上げると 50% 前後
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height + 20, { steps: 5 });
    await expect(slider).toHaveValue("0");
    await page.mouse.move(x, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const half = Number(await slider.inputValue());
    expect(half).toBeGreaterThanOrEqual(40);
    expect(half).toBeLessThanOrEqual(60);
    await expect(pop).toContainText(`${half}%`);

    // ホイールで 1 刻み (上へ回すと大きく)
    await page.mouse.wheel(0, -100);
    await expect(slider).toHaveValue(String(half + 5));
    await page.mouse.wheel(0, 100);
    await page.mouse.wheel(0, 100);
    await expect(slider).toHaveValue(String(half - 5));

    // 押すと今までどおり消音の切り替え (開いたまま)
    // (自動再生を断られて消えていることもあるので、名前が替わって戻るかで見る)
    const name = (await button.getAttribute("aria-label"))!;
    await button.click();
    await expect(button).not.toHaveAccessibleName(name);
    await expect(pop).toBeVisible();
    await button.click();
    await expect(button).toHaveAccessibleName(name);

    // 外れたら少し待ってから閉じる
    const stage = (await page.getByTestId(STAGE.live).boundingBox())!;
    await page.mouse.move(stage.x + stage.width / 2, stage.y + 20);
    await expect(pop).toBeVisible();
    await expect(pop).toBeHidden();

    // つまみは画面に1つだけ。マウスの端末の広い枠では ⚙ に音量のつまみを置かない
    await openSettings(page, "live");
    await expect(page.getByTestId("live-settings-menu")).toBeVisible();
    await expect(page.getByTestId("live-volume")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("live-settings-menu")).toBeHidden();

    // キーボードでボタンに来ても開き、つまみは ↑↓ で動く
    await wakeControls(page, STAGE.live);
    await page.getByTestId("live-play").focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(pop).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(slider).toHaveValue(String(half));
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
  });
});

test.describe("指の端末の音のボタン", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1280, height: 800 },
  });

  test("押しても縦のつまみは出ず、消音を切り替えるだけ", async ({ page }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(false);

    const bar = page.getByTestId("live-controls");
    if ((await bar.getAttribute("data-shown")) !== "true") {
      const stage = (await page.getByTestId(STAGE.live).boundingBox())!;
      await page.touchscreen.tap(
        stage.x + stage.width / 2,
        stage.y + stage.height / 2,
      );
    }
    await expect(bar).toHaveAttribute("data-shown", "true");
    const button = page.getByTestId("live-sound");
    const name = await button.getAttribute("aria-label");
    await button.tap();
    await expect(button).not.toHaveAccessibleName(name!);
    await expect(page.getByTestId("live-sound-pop")).toBeHidden();

    // 代わりに ⚙ の先頭に音量のつまみ。← → で動かし、↓ はほかの行と同じく次の行へ (音量は変えない)
    const gear = page.getByTestId("live-settings");
    await gear.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("live-settings-menu")).toBeVisible();
    const volume = page.getByTestId("live-volume");
    await expect(volume).toBeFocused();
    await expect(volume).toHaveValue("100");
    await page.keyboard.press("ArrowLeft");
    await expect(volume).toHaveValue("95");
    await page.keyboard.press("ArrowRight");
    await expect(volume).toHaveValue("100");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("live-data-receive")).toBeFocused();
    await expect(volume).toHaveValue("100");
    // つまみは名前と値の下で、メニューの幅いっぱい (Pico の `[role="group"]` の横並びにしない)
    const slider = (await volume.boundingBox())!;
    const head = (await page
      .getByTestId("live-settings-menu")
      .locator(".volume-head")
      .boundingBox())!;
    expect(slider.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
    expect(Math.abs(slider.width - head.width)).toBeLessThan(2);
  });
});

/** マウスの端末でも、畳んで音のボタンごと ⚙ に入ったら (狭い枠) ⚙ につまみを置く */
test.describe("畳んだ枠の音量", () => {
  test.use({ viewport: { width: 400, height: 800 } });

  test("音のボタンは ⚙ の「消音」の行になり、音量のつまみも ⚙ に出る", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(true);
    await expect(page.getByTestId(STAGE.live)).toHaveAttribute("data-fold", "");

    await wakeControls(page, STAGE.live);
    await expect(page.getByTestId("live-sound")).toBeHidden();
    await openSettings(page, "live");
    await expect(page.getByTestId("live-mute")).toBeVisible();
    const volume = page.getByTestId("live-volume");
    await expect(volume).toBeVisible();
    await volume.fill("40");
    await expect(page.getByTestId("live-settings-menu")).toContainText("40%");
  });
});

/**
 * **⚙ の開け閉めは `toggle` を待たない** (`Menu.svelte`)。`toggle` は後のタスクで届くので、重い CI では開いてから
 * 届くまでに押した Esc が効かず、閉じてから届くまでに動かしたフォーカスを遅れて引き金へ戻していた (閉じた直後の
 * ↑↓ が引き金に当たってメニューを開き直す)。ここでは popover の `toggle` を止めておき、届く前に操作してから届ける
 */
test.describe("⚙ の開け閉めと遅れて届く toggle", () => {
  test("届く前の Esc で閉じ、閉じた後に動かしたフォーカスを奪わない", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // 止めている popover と、止めた間のもとの状態 (oldState)。届けるときは1回にまとめる (ブラウザと同じ)
      const held = new Map<HTMLElement, string>();
      (globalThis as { __release?: () => void }).__release = () => {
        for (const [target, oldState] of held) {
          const newState = target.matches(":popover-open") ? "open" : "closed";
          target.dispatchEvent(
            new ToggleEvent("toggle", { oldState, newState }),
          );
        }
        held.clear();
      };
      window.addEventListener(
        "toggle",
        (event) => {
          const target = event.target;
          if (
            !event.isTrusted ||
            !(target instanceof HTMLElement) ||
            !target.hasAttribute("popover")
          )
            return;
          event.stopImmediatePropagation();
          if (!held.has(target))
            held.set(target, (event as ToggleEvent).oldState);
        },
        true,
      );
    });
    const release = () =>
      page.evaluate(() =>
        (globalThis as unknown as { __release: () => void }).__release(),
      );
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const menu = page.getByTestId("live-settings-menu");
    const trigger = page.getByTestId("live-settings");

    // 開いて、toggle が届く前の Esc
    await wakeControls(page, STAGE.live);
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await release();
    await expect(menu).toBeHidden();

    // 中にフォーカスがある間に閉じると、その場で引き金へ戻る。そこから動かしたフォーカスは、
    // 後から届いた toggle に奪われない
    await wakeControls(page, STAGE.live);
    await trigger.click();
    await expect(menu).toBeVisible();
    await release();
    await page.getByTestId("live-ambient").focus();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await release();
    await expect(trigger).not.toBeFocused();
    await expect(menu).toBeHidden();
  });
});
