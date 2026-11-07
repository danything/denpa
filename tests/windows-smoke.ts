/**
 * Windows の配布物 (`denpa-<バージョン>-windows-x64.zip`) を確かめる。CI (test.yml の server-windows) が、
 * 配布物の bun で流す。
 *
 *   bun tests/windows-smoke.ts <配布物を開いた場所> <作業場所>
 *
 * - 同梱の ffmpeg で、denpa が使う経路の主なもの (.github/image-smoke.sh と同じ素材と引数) を流す。
 *   部品を Dockerfile から読んで組んでいるので、足りなければここで落ちる
 * - GPU のエンコーダ (NVENC・QSV・AMF) が組み込まれ、denpa が渡すオプションを持つか。GPU の無いランナーでは
 *   試しのエンコードが全部落ちて、ソフトウェアでエンコードするか
 * - ffmpeg の 4 本目の出口 (stream.sideOutput。Windows では名前付きパイプ) で、進み具合と matroska を受けられるか
 * - スリープを止められるか (awake.ts)。`powercfg /requests` に bun が出るかを見る (管理者で動くランナーだけで読める)
 */

import { join } from "node:path";

import { holdAwake } from "../src/lib/server/awake.ts";
import { sideOutput } from "../src/lib/server/stream.ts";

const [root, work] = process.argv.slice(2);
if (root === undefined || work === undefined) {
  throw new Error("bun tests/windows-smoke.ts <dir> <work>");
}
const ffmpeg = join(root, "ffmpeg", "ffmpeg.exe");
const ffprobe = join(root, "ffmpeg", "ffprobe.exe");
const at = (name: string) => join(work, name);

async function ff(...args: string[]): Promise<void> {
  const proc = Bun.spawn(
    [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  // SVT-AV1 は自分の名前の付いた行を標準エラーに出す
  const errors = err
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("Svt["));
  if (code !== 0 || errors.length > 0) {
    throw new Error(`ffmpeg ${args.join(" ")}\n${errors.join("\n")}`);
  }
}

const encoders = Bun.spawnSync([
  ffmpeg,
  "-hide_banner",
  "-encoders",
]).stdout.toString();
// GPU のエンコーダ (NVENC・QSV・AMF) は、ランナーに GPU が無くても組み込んである
const gpuEncoders = ["nvenc", "qsv", "amf"].flatMap((kind) =>
  ["h264", "hevc", "av1"].map((codec) => `${codec}_${kind}`),
);
for (const name of [
  "libx264",
  "libsvtav1",
  "libopus",
  "aac",
  "mjpeg",
  ...gpuEncoders,
]) {
  if (!new RegExp(`\\b${name}\\b`).test(encoders))
    throw new Error(`エンコーダがありません: ${name}`);
}

await ff(
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1440x1080:rate=30000/1001:duration=3",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=1000:duration=3",
  "-c:v",
  "mpeg2video",
  "-flags",
  "+ilme+ildct",
  "-b:v",
  "8M",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-f",
  "mpegts",
  at("in.ts"),
);
const probed = Bun.spawnSync([
  ffprobe,
  "-v",
  "error",
  "-show_streams",
  "-of",
  "json",
  at("in.ts"),
]);
if (probed.exitCode !== 0 || !probed.stdout.toString().includes("mpeg2video"))
  throw new Error(`ffprobe が読めません: ${probed.stderr.toString()}`);
await ff(
  "-i",
  at("in.ts"),
  "-vf",
  "bwdif,scale=-2:720,setsar=1,format=yuv420p",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-filter_complex",
  "channelsplit[FL][FR];[FL]aformat=channel_layouts=mono[FLm];[FR]aformat=channel_layouts=mono[FRm]",
  "-map",
  "0:v",
  "-map",
  "[FLm]",
  "-map",
  "[FRm]",
  "-c:a",
  "libopus",
  "-b:a",
  "96k",
  "-f",
  "matroska",
  at("h264.mkv"),
);
await ff(
  "-i",
  at("in.ts"),
  "-vf",
  "bwdif,scale=-2:720,format=yuv420p10le",
  "-c:v",
  "libsvtav1",
  "-preset",
  "12",
  "-c:a",
  "libopus",
  "-f",
  "matroska",
  at("av1.mkv"),
);
await ff("-i", at("av1.mkv"), "-f", "null", "-");
await ff(
  "-i",
  at("in.ts"),
  "-vf",
  "bwdif=mode=send_frame",
  "-af",
  "pan=stereo|c0=c0|c1=c0",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-g",
  "60",
  "-c:a",
  "aac",
  "-b:a",
  "256k",
  "-ac",
  "2",
  "-f",
  "mp4",
  "-movflags",
  "frag_keyframe+empty_moov+default_base_moof",
  at("live.mp4"),
);
await ff(
  "-ss",
  "1",
  "-i",
  at("in.ts"),
  "-vf",
  "field=top,thumbnail,scale=320:-2,setsar=1",
  "-frames:v",
  "1",
  at("thumb.jpg"),
);
await ff(
  "-i",
  at("thumb.jpg"),
  "-map_metadata",
  "-1",
  "-frames:v",
  "1",
  "-c:v",
  "libsvtav1",
  "-preset",
  "8",
  "-crf",
  "30",
  "-svtav1-params",
  "avif=1",
  "-vf",
  "format=yuv420p",
  "-f",
  "avif",
  at("thumb.avif"),
);
await Bun.write(at("list.txt"), "file h264.mkv\nfile h264.mkv\n");
await ff(
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  at("list.txt"),
  "-map",
  "0",
  "-c",
  "copy",
  "-f",
  "matroska",
  at("cut.mkv"),
);
console.log("ffmpeg: ok");

/*
 * GPU のエンコーダ。ランナーに GPU は無いので、エンコードは通らない。ここで見るのは次の 3 つ。
 * 1. denpa が渡すエンコーダのオプション (hwenc.hwArgs・encoder.keyframeArgs) を、組み込んだエンコーダが持っている
 * 2. hwArgs の引数で起動すると、GPU が無いために落ちる (エンコーダやオプションの名前が違って落ちるのではない)
 * 3. 試しのエンコードが全部落ちると、GPU の方式は 0 になり、録画もライブもソフトウェアでエンコードする
 */
const options: Record<string, string[]> = {
  nvenc: ["gpu", "preset", "rc", "forced-idr", "delay", "zerolatency"],
  qsv: ["preset", "forced_idr", "async_depth"],
  amf: ["usage", "quality", "rc", "forced_idr", "async_depth"],
};
for (const name of gpuEncoders) {
  const help = Bun.spawnSync([
    ffmpeg,
    "-hide_banner",
    "-h",
    `encoder=${name}`,
  ]).stdout.toString();
  for (const option of options[name.split("_")[1]!]!) {
    if (!new RegExp(`^\\s+-${option}\\s`, "m").test(help))
      throw new Error(`${name} にオプション -${option} がありません`);
  }
}
const { config } = await import("../src/lib/server/config.ts");
config.ffmpeg = ffmpeg;
const { HW_CODECS } = await import("../src/lib/hw.ts");
const { hwArgs, hwChain, liveHw, probe } =
  await import("../src/lib/server/hwenc.ts");
for (const kind of ["nvenc", "qsv", "amf"] as const) {
  for (const codec of HW_CODECS) {
    const hw = hwArgs({ device: `${kind}0`, kind, gpu: 0 }, codec);
    const run = Bun.spawnSync([
      ffmpeg,
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      ...hw.device,
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=256x256:r=30:d=0.2",
      "-vf",
      hw.filter.join(","),
      "-c:v",
      ...hw.encoder,
      "-f",
      "null",
      "-",
    ]);
    const err = run.stderr.toString();
    console.log(`${codec}_${kind}: exit ${run.exitCode}`);
    if (/Unknown encoder|Unrecognized option|No such filter/.test(err))
      throw new Error(`${codec}_${kind} を起動できません:\n${err}`);
  }
}
const found = await probe();
console.log(found.message);
if (found.devices.length === 0) {
  for (const codec of HW_CODECS) {
    if (hwChain(codec, {}).length > 0 || liveHw(codec, {}) !== null)
      throw new Error(`GPU が無いのに ${codec} の方式が残っています`);
  }
  console.log("no GPU: software encoding: ok");
}

if (!(await holdAwake(true)))
  throw new Error("SetThreadExecutionState が失敗しました");
const requests = Bun.spawnSync(["powercfg.exe", "/requests"]).stdout.toString();
console.log(requests);
if (!/bun\.exe/i.test(requests))
  throw new Error("powercfg /requests に bun が出ません");
await holdAwake(false);
console.log("keep awake: ok");

// 4 本目の出口 (stream.sideOutput)。Windows では名前付きパイプ。録画のエンコードの進み具合と同じ渡し方
const timeout = (ms: number) =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms),
  );
const progressSide = sideOutput();
const proc = Bun.spawn(
  [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    at("in.ts"),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "libopus",
    "-nostats",
    "-progress",
    progressSide.url,
    "-f",
    "matroska",
    at("progress.mkv"),
  ],
  { stdio: ["ignore", "ignore", "pipe", ...progressSide.stdio] as never },
);
const progress = await Promise.race([
  new Response(progressSide.read(proc as never)).text(),
  timeout(60_000),
]);
const code = await proc.exited;
if (code !== 0 || !progress.includes("progress=end")) {
  throw new Error(
    `進み具合を受けられません (終了コード ${code})\n${progress.slice(0, 500)}`,
  );
}
console.log("progress on the side output: ok");

// ライブの字幕と同じく matroska を流す (字幕の代わりに音声)
const mkvSide = sideOutput();
const mkv = Bun.spawn(
  [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    at("in.ts"),
    "-map",
    "0:a",
    "-c:a",
    "libopus",
    "-cluster_time_limit",
    "1",
    "-flush_packets",
    "1",
    "-f",
    "matroska",
    mkvSide.url,
  ],
  { stdio: ["ignore", "ignore", "pipe", ...mkvSide.stdio] as never },
);
const body = await Promise.race([
  new Response(mkvSide.read(mkv as never)).arrayBuffer(),
  timeout(60_000),
]);
const mkvCode = await mkv.exited;
console.log(
  `matroska on the side output: ${body.byteLength} bytes, exit ${mkvCode}`,
);
if (mkvCode !== 0 || body.byteLength < 1000) {
  throw new Error(
    `4 本目の出口に matroska を流せません: ${await new Response(mkv.stderr as unknown as ReadableStream).text()}`,
  );
}

// 出口を開かないまま ffmpeg が終わっても、読む側は終わる
const failedSide = sideOutput();
const failed = Bun.spawn(
  [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "quiet",
    "-i",
    at("missing.ts"),
    "-f",
    "null",
    failedSide.url,
  ],
  {
    stdio: ["ignore", "ignore", "ignore", ...failedSide.stdio] as never,
  },
);
await Promise.race([
  new Response(failedSide.read(failed as never)).arrayBuffer(),
  timeout(30_000),
]);
console.log("side output closes when ffmpeg fails: ok");
