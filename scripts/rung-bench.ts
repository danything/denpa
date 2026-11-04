/**
 * **回線に合わせて下げた段 (`src/lib/rungs.ts`) の変換が、その機械で実時間に間に合うかを測る** (RK3588 向け。docs/encode.md
 * 「段を下げた変換の重さを測る」)。本物の ffmpeg で、段の引数と同じものを `-f null` に通し、コマ数/秒と CPU のコア数を出す。
 *
 * - H.265 1080p (ソフトウェアでデコード) → 30 コマ・縮める → hevc_rkmpp / h264_rkmpp (段 1 = 720p・段 2 = 540p)
 * - MPEG-2 1080i (放送) → bwdif で 30 コマ・縮める → 同じ
 * - MPEG-2 1080i → x264 veryfast (段 1・段 2)
 * - MPP を何本同時に動かせるか (MPEG-2 → h264_rkmpp の段 1 を 1 本ずつ増やし、どれかが 29.97 コマ/秒を割るまで)
 *
 * 映像の引数は `live.ts` の `videoArgs` (段 1〜3) と同じものをここで組む。イメージの中では src の依存を読めないため
 * (`scripts/fps-smoke.ts` と同じ。読むのは依存の無い `rungs.ts` だけ)。ずれていないかは `rung-bench.test.ts` が確かめる。
 *
 * 使い方 (イメージの bun で。チェックアウトを読み取り専用で渡し、RK3588 のデバイスを渡す):
 *
 *     docker run --rm -v "$PWD:/src:ro" -v /tmp/bench:/work -w /work \
 *       --device /dev/mpp_service --device /dev/dma_heap \
 *       --entrypoint /usr/local/bin/bun ghcr.io/danything/denpa:latest \
 *       /src/scripts/rung-bench.ts /work [放送の TS] [H.265 の mkv]
 *
 * 素材を渡さなければ testsrc2 (と noise) から作る。合成の映像はエンコードしやすいので、本物の放送の録画 (TS) と
 * エンコード済みの H.265 を渡したほうが実際に近い。測るのは先頭の `SECONDS` 秒
 */
import { type Rung, RUNG_SPECS } from "../src/lib/rungs";

/** 測る長さ (秒) */
const SECONDS = 30;
/** 実時間 (放送の 29.97 コマ/秒) */
const REALTIME = 30000 / 1001;
/** 同時に動かす本数の上限 */
const PARALLEL_MOST = 8;

export type BenchEncoder = "hevc_rkmpp" | "h264_rkmpp" | "libx264";

/**
 * 段 1〜3 の映像のフィルタとエンコーダ (`-c:v` のあと)。`live.ts` の `rungVideo` と同じ (GPU は Rockchip MPP、
 * ソフトウェアは x264)。MPP のレート制御は `hwenc.ts` の `rkmppRate` と同じ
 */
export function benchVideo(
  encoder: BenchEncoder,
  interlaced: boolean,
  rung: Exclude<Rung, 0>,
): { filter: string; encoder: string[] } {
  const spec = RUNG_SPECS[rung];
  const bps = spec.videoKbps * 1000;
  const cpu = [
    interlaced ? "bwdif=mode=send_frame" : `fps=${spec.fps * 1000}/1001`,
    `scale=-2:${spec.height}`,
  ];
  const gop = ["-g", String(spec.fps)];
  if (encoder === "libx264") {
    return {
      filter: cpu.join(","),
      encoder: [
        "libx264",
        ..."-preset veryfast -tune zerolatency -crf 23".split(" "),
        "-maxrate:v",
        String(bps),
        "-bufsize:v",
        String(bps),
        ...gop,
      ],
    };
  }
  return {
    filter: [...cpu, "format=nv12"].join(","),
    encoder: [
      encoder,
      "-rc",
      "avbr",
      "-b:v",
      String(bps),
      "-maxrate",
      String(Math.round((bps * 17) / 16)),
      "-minrate",
      String(Math.round(bps / 16)),
      ...gop,
      ...(encoder === "hevc_rkmpp" ? ["-tag:v", "hvc1"] : []),
    ],
  };
}

/** ffmpeg の `-benchmark` と進み具合の行から、コマ数と使った時間を読む。読めなければ null */
export function readBench(
  stderr: string,
): { frames: number; utime: number; stime: number; rtime: number } | null {
  const bench = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(
    stderr,
  );
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
  if (bench === null || frames === undefined) return null;
  return {
    frames: Number(frames),
    utime: Number(bench[1]),
    stime: Number(bench[2]),
    rtime: Number(bench[3]),
  };
}

interface Result {
  name: string;
  /** コマ数/秒 */
  fps: number;
  /** 使った CPU (コア数) */
  cores: number;
}

function ffmpeg(args: string[]): Bun.Subprocess<"ignore", "ignore", "pipe"> {
  return Bun.spawn(["ffmpeg", "-hide_banner", "-nostdin", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}

/** 1 本測る。失敗したら理由を出して null */
async function measure(
  name: string,
  input: string,
  video: { filter: string; encoder: string[] },
): Promise<Result | null> {
  const proc = ffmpeg([
    "-benchmark",
    "-stats_period",
    "1",
    "-t",
    String(SECONDS),
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    video.filter,
    "-an",
    "-c:v",
    ...video.encoder,
    "-f",
    "null",
    "-",
  ]);
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  const read = readBench(stderr);
  if (code !== 0 || read === null || read.rtime <= 0) {
    console.log(
      `${name}: 失敗しました (${code}) ${stderr.trim().split("\n").slice(-2).join(" / ")}`,
    );
    return null;
  }
  return {
    name,
    fps: read.frames / read.rtime,
    cores: (read.utime + read.stime) / read.rtime,
  };
}

/** 1 行に出す。実時間の何倍かも添える */
function show(result: Result): void {
  console.log(
    `${result.name}: ${result.fps.toFixed(1)} コマ/秒 (実時間の ${(result.fps / REALTIME).toFixed(2)} 倍)、CPU ${result.cores.toFixed(2)} コア`,
  );
}

/** そのエンコーダが使えるか (`ffmpeg -encoders` に載っていて、1 コマ通るか) */
async function usable(encoder: BenchEncoder): Promise<boolean> {
  const proc = ffmpeg([
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=256x256:r=30:d=0.2",
    "-vf",
    "format=nv12",
    "-c:v",
    encoder,
    "-f",
    "null",
    "-",
  ]);
  return (await proc.exited) === 0;
}

/** 合成の素材を作る。放送に似せた 1440x1080 の 29.97i の MPEG-2 と、1920x1080 の 59.94p の H.265 (hevc_rkmpp で作る) */
async function synth(dir: string, hevc: boolean) {
  const source = [
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1920x1080:rate=60000/1001:duration=${SECONDS},noise=alls=12:allf=t`,
  ];
  const made = async (args: string[]) =>
    (await ffmpeg(["-loglevel", "error", "-y", ...source, ...args]).exited) ===
    0;
  const mpeg2 = `${dir}/rung-bench-mpeg2.ts`;
  const ok = await made([
    ..."-vf scale=1440:1080,tinterlace=mode=interleave_top,setsar=4/3".split(
      " ",
    ),
    ..."-c:v mpeg2video -b:v 14M -maxrate 16M -bufsize 8M -flags +ilme+ildct -top 1 -f mpegts".split(
      " ",
    ),
    mpeg2,
  ]);
  if (!ok) throw new Error("MPEG-2 の素材を作れませんでした");
  const h265 = `${dir}/rung-bench-hevc.mkv`;
  const hevcOk =
    hevc &&
    (await made([
      ..."-vf format=nv12 -c:v hevc_rkmpp -rc avbr -b:v 10500000".split(" "),
      h265,
    ]));
  return { mpeg2, hevc: hevcOk ? h265 : null };
}

async function main(): Promise<void> {
  const [dir = ".", mpeg2Arg, hevcArg] = process.argv.slice(2);
  const encoders = ["hevc_rkmpp", "h264_rkmpp", "libx264"] as const;
  const ready = new Map<BenchEncoder, boolean>();
  for (const encoder of encoders) ready.set(encoder, await usable(encoder));
  console.log(
    `使えるエンコーダ: ${encoders.filter((e) => ready.get(e)).join(", ") || "無し"}`,
  );
  const made =
    mpeg2Arg === undefined
      ? await synth(dir, ready.get("hevc_rkmpp") === true)
      : { mpeg2: mpeg2Arg, hevc: hevcArg ?? null };

  const results: Result[] = [];
  const run = async (
    name: string,
    input: string | null,
    encoder: BenchEncoder,
    interlaced: boolean,
    rung: Exclude<Rung, 0>,
  ) => {
    if (input === null || ready.get(encoder) !== true) return;
    const result = await measure(
      name,
      input,
      benchVideo(encoder, interlaced, rung),
    );
    if (result !== null) {
      results.push(result);
      show(result);
    }
  };

  for (const encoder of ["hevc_rkmpp", "h264_rkmpp"] as const) {
    for (const rung of [1, 2] as const) {
      const p = `${RUNG_SPECS[rung].height}p30`;
      await run(
        `H.265 1080p → ${encoder} ${p}`,
        made.hevc,
        encoder,
        false,
        rung,
      );
      await run(
        `MPEG-2 1080i → ${encoder} ${p}`,
        made.mpeg2,
        encoder,
        true,
        rung,
      );
    }
  }
  for (const rung of [2, 1] as const) {
    const p = `${RUNG_SPECS[rung].height}p30`;
    await run(
      `MPEG-2 1080i → x264 veryfast ${p}`,
      made.mpeg2,
      "libx264",
      true,
      rung,
    );
  }

  if (ready.get("h264_rkmpp") === true) {
    console.log("MPP を同時に動かす (MPEG-2 1080i → h264_rkmpp 720p30)");
    for (let n = 1; n <= PARALLEL_MOST; n++) {
      const all = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          measure(
            `${n} 本の ${i + 1} 本目`,
            made.mpeg2,
            benchVideo("h264_rkmpp", true, 1),
          ),
        ),
      );
      const done = all.filter((r): r is Result => r !== null);
      const slowest = Math.min(...done.map((r) => r.fps));
      const cores = done.reduce((sum, r) => sum + r.cores, 0);
      console.log(
        `${n} 本: いちばん遅いもの ${slowest.toFixed(1)} コマ/秒、CPU 合わせて ${cores.toFixed(2)} コア${done.length < n ? ` (${n - done.length} 本が失敗)` : ""}`,
      );
      if (done.length < n || slowest < REALTIME) break;
    }
  }
}

if (import.meta.main) await main();
