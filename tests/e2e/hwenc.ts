import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";

import { setRecording, test } from "./helpers";

/**
 * GPU でエンコードするスペックの部品 (`26-hwenc`・`26-hwenc-hevc`。server/hwenc.ts)。
 *
 * **GPU は偽物** — `stack.hwDir` に `renderD128` のような名前でファイルを置くと
 * denpa にはデバイスとして見え、偽 ffmpeg は渡されたデバイスが在るのを見て VA-API の
 * 試しのエンコードを通す。消せば、エンコードしようとした GPU の方式が本物と同じく初期化で落ちる
 * (次の方式・ソフトウェアへ倒れるのを試せる)。
 * `mpp_service` を置くと Rockchip MPP (`RKMPP_DEVICE`)、`nvidia0` を置くと NVIDIA の GPU (`NVIDIA_DIR`) のデバイスとして見える
 */

export const GPUS = ["renderD128", "renderD129"];

export function clearGpus(dir: string): void {
  for (const name of readdirSync(dir))
    rmSync(`${dir}/${name}`, { force: true });
}

/**
 * ファイルの終わりに GPU を抜いて確かめ直す。**同じワーカーで次に流れるスペックが「GPU が無い」から始められるように**
 * (ワーカーはファイルをまたいで使い回す)
 */
export function forgetGpusAfterAll(): void {
  test.afterAll(async ({ stack, request }) => {
    clearGpus(stack.hwDir);
    await setRecording(request);
    await request.post("/settings/recording?/probeHw", { form: {} });
  });
}

/**
 * エンコードするときに偽 ffmpeg へ渡された引数、1回ぶんずつ。**書き途中の名前 (`.encoding`) へ
 * 出しているものだけ** — サムネイルなど、同じ経路を通る他の呼び出しは省く。
 *
 * **この録画のぶんだけ。** 入力は元のTS (`…-<録画の番号>.m2ts`)。
 * 同じワーカーの前のテストが残した予約が録れてエンコードされると、そのぶんまで混ざっていた (CI)。
 * 名前の尻で合わせる — エンコードしたものにチャプターを書き足すとき (`-c copy`) の `<元のTS>.chapters.txt` に当たらないように
 */
export function encodeRuns(
  file: string,
  recordingId: string | null,
): string[][] {
  if (!existsSync(file)) return [];
  const mine = new RegExp(`-${recordingId}\\.m2ts$`);
  return readFileSync(file, "utf8")
    .split("---\n")
    .filter((run) => run.trim() !== "")
    .map((run) => run.split("\n"))
    .filter((run) => run.some((a) => a.endsWith(".encoding")))
    .filter((run) => run.some((a, i) => run[i - 1] === "-i" && mine.test(a)));
}

/** 1回ぶんの引数から「どのデバイスを、何でエンコードしたか」。ソフトウェアならデバイスは無し */
export function wayOf(run: string[]): string {
  const encoder =
    run.find(
      (a) =>
        /_(vaapi|rkmpp|nvenc)$/.test(a) || a === "libx264" || a === "libsvtav1",
    ) ?? "?";
  const device = run.find((a) => a.startsWith("vaapi="));
  const port = device?.split("va:").at(-1)?.split("/").at(-1);
  return port === undefined ? encoder : `${port}:${encoder}`;
}
