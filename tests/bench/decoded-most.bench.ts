import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import type { Page } from "@playwright/test";
import { tsHead } from "../../src/lib/ts/seek";
import { expect, goto, recordOne, setRecording, test } from "../e2e/helpers";
import {
  analyse,
  type Load,
  type Measured,
  type Path,
  type Result,
  summarize,
} from "./analyse";
import { media, SECONDS } from "./media";

/**
 * **デコードしたフレームを何枚まで持つか (`DECODED_MOST`) を測る** (docs/stream.md#デコードしたフレームを持つ数)。
 *
 * 互換モードの観る画面 (`canvas-player.ts`) に作り物の映像 (`media.ts`) を流し、worker の
 * `DECODED_MOST` を振って比べる。値はビルドし直さず、ページに差し込んだ `probe.js` が worker を読んで
 * 書き換えてから起こす。
 *
 * - `mpeg2` … 元の TS (`raw/worker.ts`)。WASM のデコーダの順番待ちの枚数・WASM のメモリ・フィールドの出方
 * - `av1` / `h264` … fMP4 (`raw/fmp4.ts`)。閉じていない VideoFrame と `decodeQueueSize` の枚数・コマの出方
 *
 * 数えるもの (`analyse`): 画面の切り替わり (rAF) ごとにどのコマ (MPEG-2 はフィールド) が出ていたかを並べ、
 * 一度も出なかったコマ (落ち)、50ms 以上変わらなかった回 (止まり)、いちばん長く変わらなかった間。
 * `busy` は CPU の数だけ空回りのプロセスを並べて、混んだ端末のふりをする。
 *
 * **ここには GPU が無い** (`--disable-gpu`)。VideoDecoder はソフトウェアでデコードし、VideoFrame は
 * CPU のメモリに置かれる。GPU の置き場が尽きて止まるか (fmp4.ts の心配) はここでは測れない。
 * 1080 を WebGL で描くのもソフトウェアなので、MPEG-2 は描くのが追いつかない (毎秒 14 フィールドほど)。
 * GPU のあるふだんの Chrome で測るには `BENCH_SERVE=1` で一式を立てたままにする (docs/stream.md)。
 *
 *     BENCH_VALUES=3,4,6,8,12 BENCH_PATHS=mpeg2,av1,h264 BENCH_LOADS=idle,busy BENCH_RUNS=3 \
 *       docker compose --profile docs run --rm docs bunx playwright test -c tests/bench
 *
 * 1回ずつの結果は `tests/bench/out/decoded-most.jsonl`、まとめは `decoded-most.md`
 */

const OUT = "tests/bench/out";
const list = (name: string, fallback: string) =>
  (process.env[name] ?? fallback).split(",").filter(Boolean);
const VALUES = list("BENCH_VALUES", "3,4,6,8,12").map(Number);
const PATHS = list("BENCH_PATHS", "mpeg2,av1,h264") as Path[];
const LOADS = list("BENCH_LOADS", "idle,busy") as Load[];
const RUNS = Number(process.env["BENCH_RUNS"] ?? 3);
const PROXY_PORT = Number(process.env["BENCH_PORT"] ?? 4180);
/** 出はじめてから数えはじめるまで (ms) */
const WARM = 3000;
/** 数える長さ (ms) */
const WINDOW = 15_000;

/** 空回りのプロセスを CPU の数だけ (混んだ端末のふり) */
function burn(): ChildProcess[] {
  return cpus().map(() =>
    spawn("bun", ["-e", "for(;;){}"], { stdio: "ignore" }),
  );
}

const PROBE = readFileSync(new URL("./probe.js", import.meta.url), "utf8");

type BenchWindow = {
  __benchInstall(options: object): void;
  __bench?: { error: string | null; measure(ms: number): Promise<Measured> };
};

async function playOnce(
  page: Page,
  base: string,
  id: string,
  path: Path,
  value: number,
): Promise<Measured | null> {
  // 開き直すたびにホームから (前の worker やデコーダを残さない)。差し込んでから、ページの中で観る画面へ移る
  await goto(page, `${base}/`);
  await page.evaluate(PROBE);
  await page.evaluate(
    (options) => (globalThis as unknown as BenchWindow).__benchInstall(options),
    {
      value,
      path,
      seconds: SECONDS,
    },
  );
  await page.evaluate((href) => {
    const a = document.createElement("a");
    a.href = href;
    document.body.append(a);
    a.click();
  }, `/watch/${id}`);
  const input = path === "mpeg2" ? "ts-mpeg2" : "fmp4";
  const canvas = page.locator(
    `[data-testid="live-raw"][data-input="${input}"]`,
  );
  try {
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-shown")) ?? 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(5);
  } catch {
    const error = await page.evaluate(
      () => (globalThis as unknown as BenchWindow).__bench?.error ?? null,
    );
    console.log(`描きはじめませんでした (${path} ${value}): ${error ?? ""}`);
    await page.screenshot({ path: `${OUT}/failed-${path}-${value}.png` });
    console.log(`  URL: ${page.url()}`);
    return null;
  }
  await page.waitForTimeout(WARM);
  // 測っている途中で諦めて worker を畳んだら失敗として数える
  return page
    .evaluate(
      (ms) => (globalThis as unknown as BenchWindow).__bench!.measure(ms),
      WINDOW,
    )
    .catch(() => null);
}
const EMPTY: Measured = {
  draws: [],
  held: [],
  liveMax: 0,
  outstandingMax: 0,
  decMax: 0,
  pushMs: [],
  wasm: 0,
  vsyncs: [],
  input: null,
};

test("DECODED_MOST を振って、コマの出方と持つ量を比べる", async ({
  page,
  request,
  stack,
}) => {
  mkdirSync(OUT, { recursive: true });
  const dir = `${OUT}/media`;
  const made = media(dir);
  const origin = tsHead(
    new Uint8Array(readFileSync(made.mpeg2).subarray(0, 4 * 1024 * 1024)),
  );
  if (origin === null) throw new Error("作った TS の頭の時刻が読めません");
  const proxy = spawn(
    "bun",
    [
      "tests/bench/proxy.ts",
      stack.appUrl,
      dir,
      String(PROXY_PORT),
      String(origin),
    ],
    {
      stdio: "inherit",
    },
  );
  const base = `http://127.0.0.1:${PROXY_PORT}`;
  try {
    await expect
      .poll(
        async () =>
          (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false,
      )
      .toBe(true);
    await setRecording(request, { codecs: [] });
    const { id } = await recordOne(page, request);
    // 描きはじめないときの手掛かり (worker を起こせない・デコーダが読めない)
    page.on("pageerror", (error) =>
      console.log(`ページのエラー: ${error.message}`),
    );

    /*
     * **GPU のあるふだんの Chrome で測る**ときは、ここで立てたままにする。コンテナのポートを外へ出して
     * (`-p 4180:4180`)、http://localhost:4180/ を開き、`probe.js` を貼って測る。`out/stop` を置けば降りる
     */
    if (process.env["BENCH_SERVE"] === "1") {
      rmSync(`${OUT}/stop`, { force: true });
      writeFileSync(
        `${OUT}/serve.json`,
        JSON.stringify({ id, port: PROXY_PORT }),
      );
      console.log(
        `観る画面: /watch/${id} (port ${PROXY_PORT})。止めるには ${OUT}/stop を置く`,
      );
      while (!existsSync(`${OUT}/stop`))
        await new Promise((resolve) => setTimeout(resolve, 1000));
      return;
    }

    const paths = [...PATHS];
    if (paths.includes("h264")) {
      await page.goto(`${base}/api/health`);
      const h264 = await page.evaluate(
        async () =>
          (await VideoDecoder.isConfigSupported({ codec: "avc1.64002a" }))
            .supported === true,
      );
      if (!h264) {
        console.log("この Chromium は H.264 をデコードできないので外す");
        paths.splice(paths.indexOf("h264"), 1);
      }
    }

    const jsonl = `${OUT}/decoded-most.jsonl`;
    writeFileSync(jsonl, "");
    const results: Result[] = [];
    for (const load of LOADS) {
      const burners = load === "busy" ? burn() : [];
      try {
        for (let run = 1; run <= RUNS; run++) {
          // 値の順で偏らないよう、回ごとに並びを回す
          const order = VALUES.map(
            (_, i) => VALUES[(i + run - 1) % VALUES.length]!,
          );
          for (const path of paths) {
            for (const value of order) {
              const measured = await playOnce(page, base, id, path, value);
              const expected = path === "mpeg2" ? "ts-mpeg2" : "fmp4";
              const ok = measured?.input === expected;
              const result = analyse(
                path,
                value,
                load,
                run,
                measured ?? EMPTY,
                ok,
              );
              results.push(result);
              appendFileSync(jsonl, `${JSON.stringify(result)}\n`);
              console.log(JSON.stringify(result));
            }
          }
        }
      } finally {
        for (const burner of burners) burner.kill("SIGKILL");
      }
    }
    const table = summarize(results);
    writeFileSync(`${OUT}/decoded-most.md`, `${table}\n`);
    console.log(table);
  } finally {
    // 立てたまま測ったとき・途中で落ちたときも、録画の設定を戻す
    await setRecording(request, {}).catch(() => undefined);
    proxy.kill("SIGTERM");
  }
});
