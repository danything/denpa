import { writeFileSync } from "node:fs";

import type { Page, TestInfo, Worker } from "@playwright/test";

import {
  expect,
  goto,
  pickCodec,
  recordOne,
  setRecording,
  test,
  wakeControls,
} from "./helpers";

/**
 * **元の TS (60i の MPEG-2) を出す間合い** (docs/stream.md#コマを出す間合い--画面の切り替わりに合わせる。`raw/cadence.ts`)。
 *
 * 偽の放送の映像は上下のフィールドで別の時刻の映像にしてある (`ts/synth-av.ts`)。worker の WebGL の
 * 呼び出しを横から数え (どのコマを上げたか・どちらのフィールドを描いたか・いつ描いたか)、画面の
 * requestAnimationFrame の時刻と突き合わせて、**画面の切り替わりごとにどのフィールドが出ていたか**を並べる。
 * 同じフィールドが続けば重なり、2つ以上進めば飛び。数字は test-results に残す。
 *
 * 59.94 と 60 の差のぶん (約 17 秒に1回) の重なりは避けられない。ヘッドレスの画面の切り替わりは
 * 実機と違う (GPU も無い) ので、ここで見るのは「大きく崩れていないか」まで
 */

interface Draw {
  /** `performance.timeOrigin + performance.now()` の ms */
  at: number;
  /** 何枚目のコマを上げた後か (テクスチャを上げた回数) */
  upload: number;
  field: number;
}

/** worker の WebGL を横から数える。prototype を差し替えるので、もう作ってある文脈にも効く */
async function instrument(worker: Worker): Promise<void> {
  await worker
    .evaluate(() => {
      const scope = self as unknown as {
        __draws?: { at: number; upload: number; field: number }[];
        WebGL2RenderingContext?: typeof WebGL2RenderingContext;
      };
      const proto = scope.WebGL2RenderingContext?.prototype;
      if (proto === undefined || scope.__draws !== undefined) return;
      const draws: { at: number; upload: number; field: number }[] = [];
      scope.__draws = draws;
      let uploads = 0;
      let field = -1;
      const names = new WeakMap<object, string>();
      const getUniformLocation = proto.getUniformLocation;
      proto.getUniformLocation = function (program, name) {
        const location = getUniformLocation.call(this, program, name);
        if (location !== null) names.set(location, name);
        return location;
      };
      const uniform1i = proto.uniform1i;
      proto.uniform1i = function (location, value) {
        if (location !== null && names.get(location) === "field") field = value;
        return uniform1i.call(this, location, value);
      };
      // 1コマで3面 (Y・Cb・Cr) 上げる
      for (const name of ["texImage2D", "texSubImage2D"] as const) {
        const original = proto[name] as (...args: unknown[]) => void;
        (proto as unknown as Record<string, unknown>)[name] = function (
          this: unknown,
          ...args: unknown[]
        ) {
          uploads++;
          return original.apply(this, args);
        };
      }
      const drawArrays = proto.drawArrays;
      proto.drawArrays = function (mode, first, count) {
        draws.push({
          at: performance.timeOrigin + performance.now(),
          upload: Math.ceil(uploads / 3),
          field,
        });
        return drawArrays.call(this, mode, first, count);
      };
    })
    .catch(() => undefined);
}

interface Cadence {
  vsyncs: number;
  /** 画面の requestAnimationFrame が来なかった回の数 (rAF の間隔から割り戻す) */
  missed: number;
  draws: number;
  repeats: number;
  skips: number;
  /** 描いた間隔 (ms) */
  interval: { mean: number; sd: number; min: number; max: number };
  /** rAF ごとに進んだフィールドの数の度数 (rAF が来なかった回のぶんも含む) */
  steps: Record<string, number>;
}

/**
 * 画面の切り替わりごとに出ていたフィールドを並べ、重なり・飛びを数える。
 *
 * **rAF が来なかった回のぶん進むのは正しい。** CI はほかのスペック (エンコードなど) と並んで混み、
 * 画面の rAF が 2.5 秒 (150 回) のうち 20〜70 回来ないことがある。そのあいだもフィールドは時刻どおりに
 * 進むので、前の rAF からの間隔を rAF の1回ぶんの間隔で割った回数ぶん進むのを正しいとし、
 * それより少なければ重なり、多ければ飛びと数える
 */
function cadence(draws: Draw[], vsyncs: number[]): Cadence {
  const order = new Map<number, number>();
  for (const draw of draws)
    if (!order.has(draw.upload)) order.set(draw.upload, order.size);
  // 上が先のコマ (偽の放送はトップファースト)。上 = 0、下 = 1
  const id = (draw: Draw) =>
    2 * order.get(draw.upload)! + (draw.field === 1 ? 1 : 0);
  const seen: { at: number; field: number }[] = [];
  let at = 0;
  for (const vsync of vsyncs) {
    while (at < draws.length && draws[at]!.at < vsync) at++;
    if (at > 0) seen.push({ at: vsync, field: id(draws[at - 1]!) });
  }
  const periods = vsyncs
    .slice(1)
    .map((vsync, i) => vsync - vsyncs[i]!)
    .sort((a, b) => a - b);
  /*
   * 半分より多く来ないこともあるので、中央値ではなく短い側 (下から 1 割) を1回ぶんとする。
   * それでも 2 回ぶんを拾うほど来ないときのために、テストの画面 (60Hz) の 1.1 倍で頭を押さえる
   */
  const period = Math.min(
    periods[Math.floor(periods.length / 10)] ?? 1000 / 60,
    (1000 / 60) * 1.1,
  );
  const steps: Record<string, number> = {};
  let missed = 0;
  let repeats = 0;
  let skips = 0;
  for (let i = 1; i < seen.length; i++) {
    const expected = Math.max(
      1,
      Math.round((seen[i]!.at - seen[i - 1]!.at) / period),
    );
    missed += expected - 1;
    const step = seen[i]!.field - seen[i - 1]!.field;
    steps[step] = (steps[step] ?? 0) + 1;
    if (step < expected) repeats++;
    else if (step > expected) skips++;
  }
  const gaps = draws.slice(1).map((draw, i) => draw.at - draws[i]!.at);
  const mean =
    gaps.reduce((sum, gap) => sum + gap, 0) / Math.max(1, gaps.length);
  const sd = Math.sqrt(
    gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) /
      Math.max(1, gaps.length),
  );
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    vsyncs: vsyncs.length,
    missed,
    draws: draws.length,
    repeats,
    skips,
    interval: {
      mean: round(mean),
      sd: round(sd),
      min: round(Math.min(...gaps)),
      max: round(Math.max(...gaps)),
    },
    steps,
  };
}

/** `ms` のあいだ、画面の切り替わりと worker の描いた回を控えて数える */
async function measure(
  page: Page,
  workers: Worker[],
  ms: number,
): Promise<Cadence> {
  const from = await page.evaluate(
    () => performance.timeOrigin + performance.now(),
  );
  const vsyncs = await page.evaluate(
    (ms) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        const end = performance.now() + ms;
        const frame = (at: number) => {
          out.push(performance.timeOrigin + at);
          if (at < end) requestAnimationFrame(frame);
          else resolve(out);
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );
  const lists = await Promise.all(
    workers.map((worker) =>
      worker
        .evaluate(() => (self as unknown as { __draws?: Draw[] }).__draws ?? [])
        .catch(() => [] as Draw[]),
    ),
  );
  const all = lists.flat().sort((a, b) => a.at - b.at);
  const draws = all.filter((draw) => draw.at >= from - 100);
  return cadence(draws, vsyncs);
}

/** 続けて何枚か撮る (動きの段差を目で見るため) */
async function shots(page: Page, info: TestInfo, name: string): Promise<void> {
  const canvas = page.getByTestId("live-raw");
  for (let i = 0; i < 6; i++) {
    await canvas.screenshot({ path: info.outputPath(`${name}-${i}.png`) });
  }
}

test.describe("元の TS を出す間合い", () => {
  test.afterAll(async ({ request }) => {
    await setRecording(request, {});
  });

  test("観る画面で元の TS を流すと、画面の切り替わりごとにフィールドが1つずつ進む", async ({
    page,
    request,
  }, info) => {
    test.setTimeout(180_000);
    // エンコードしない録画 (元の TS だけ)
    await setRecording(request, { codecs: [] });
    const { id } = await recordOne(page, request);
    /*
     * **互換モードで MPEG-2 を選ぶ** (canvas に描く経路)。ふだんの観る画面は元の TS をサーバが変換して
     * `<video>` に流し、出す間合いはブラウザが決める (40-watch-compat と同じ入れ方)
     */
    await page.addInitScript(() => {
      localStorage.setItem("canvas-video", "on");
      localStorage.setItem("canvas-drive-notice", "1");
    });
    const workers: Worker[] = [];
    page.on("worker", (worker) => {
      workers.push(worker);
      void instrument(worker);
    });

    await goto(page, `/watch/${id}`);
    await wakeControls(page, "watch-stage");
    await pickCodec(page, "watch", "mpeg2");
    const canvas = page.locator(
      '[data-testid="live-raw"][data-input="ts-mpeg2"]',
    );
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => Number((await canvas.getAttribute("data-shown")) ?? 0))
      .toBeGreaterThan(5);

    // 偽の番組は 5 秒。出はじめてから 2.5 秒ぶん
    const result = await measure(page, workers, 2500);
    await shots(page, info, "watch");
    writeFileSync(
      info.outputPath("cadence.json"),
      JSON.stringify(result, null, 2),
    );
    await info.attach("cadence", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    console.log(`観る画面: ${JSON.stringify(result)}`);

    expect(result.draws).toBeGreaterThan(60);
    /*
     * 飛びと重なりは、ほぼ無い。手元 (Xvfb の上で headed) で 150 回の切り替わりのうち、直す前は
     * 重なり 9・飛び 8、直した後は 0・0 (ヘッドレスで 2・1)。CI は混むので少し余裕を持たせる。
     * rAF が来なかった回 (`missed`) のぶん進んだのは飛びに数えない (`cadence`)。
     *
     * **rAF が来ない回が多いほど、前後の回もずれる** (ページが止められている)。CI で落ちたときは 150 回のうち
     * 来なかった回が 19〜53 で、重なりと飛びはその 4 分の 1 ほど。映像は 256x144 なので描く手間ではなく、
     * ランナーの混み具合。来なかった回の 4 分の 1 までは余裕に足す (直す前の手元の 17 は、来なかった回が少なくても超える)
     */
    expect(result.repeats + result.skips).toBeLessThanOrEqual(
      8 + Math.floor(result.missed / 4),
    );
  });
});
