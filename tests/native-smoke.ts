/**
 * Windows と Mac の配布物 (`denpa-<バージョン>-windows-x64.zip`・`denpa-<バージョン>-darwin-arm64.tar.gz`) と、Android のアプリの ffmpeg を確かめる。
 * CI (test.yml の server-windows・server-macos) が、配布物の bun で流す。Android は、.github/android-app-smoke.sh が bun build で 1 つのファイルにまとめて
 * エミュレータに置き、debug の APK の確かめ用のサーバ (android/app/src/debug/assets/server/) が、アプリの子プロセスの bun からさらに子プロセスで流す。
 *
 *   bun tests/native-smoke.ts <配布物を開いた場所> <作業場所>
 *   bun native-smoke.js <nativeLibraryDir> <作業場所>   (Android。ffmpeg は libffmpeg.so・libffprobe.so)
 *
 * - 同梱の ffmpeg で、denpa が使う経路の主なもの (.github/image-smoke.sh と同じ素材と引数) を流す。
 *   部品を Dockerfile から読んで組んでいるので、足りなければここで落ちる。4K の局の HLG を SDR に直すフィルタ (uhd.HLG_TO_SDR) も流す
 * - 同梱の ffprobe で、TS・m2ts・mkv・mp4・fMP4 (HEVC Main10・AAC・ARIB 字幕、H.264・AV1・Opus) を読めるか (tests/native-ffprobe.ts)
 * - GPU のエンコーダ (Windows は NVENC・QSV・AMF、Mac は VideoToolbox) が組み込まれ、denpa が渡すオプションを持つか。
 *   GPU で試せないランナーでは、試しのエンコードが全部落ちて、ソフトウェアでエンコードするか
 * - Android は MediaCodec のエンコーダ (H.264・H.265・AV1) が組み込まれ、NDK の MediaCodec で (JVM の無いプロセスから) エンコードできるか。
 *   denpa の GPU の探し方 (hwenc.ts) にはまだつないでいないので、探すと GPU の方式は 0 になる
 * - ffmpeg の 4 本目の出口 (stream.sideOutput。Windows では名前付きパイプ、Mac は `pipe:3`) で、進み具合と matroska を受けられるか
 * - スリープを止められるか (awake.ts。Android は常駐サービスが止めるので見ない)。Windows は `powercfg /requests` に bun が出るか (管理者で動くランナーだけで読める)、
 *   Mac は `pmset -g assertions` にこのプロセスの `PreventUserIdleSystemSleep` が出るか
 * - Mac は、録画の前に起こす予約を置いて取り消せるか (awake.macPower。`pmset -g sched` で見る。root が要るので sudo で流す)
 */

import { join } from "node:path";

import { holdAwake, macPower } from "../src/lib/server/awake.ts";
import { sideOutput } from "../src/lib/server/stream.ts";
import { HLG_TO_SDR } from "../src/lib/server/uhd.ts";
import { probeSmoke } from "./native-ffprobe.ts";

const [root, work] = process.argv.slice(2);
if (root === undefined || work === undefined) {
  throw new Error("bun tests/native-smoke.ts <dir> <work>");
}
const windows = process.platform === "win32";
const android = process.platform === "android";
const exe = windows ? ".exe" : "";
const ffmpeg = android
  ? join(root, "libffmpeg.so")
  : join(root, "ffmpeg", `ffmpeg${exe}`);
const ffprobe = android
  ? join(root, "libffprobe.so")
  : join(root, "ffmpeg", `ffprobe${exe}`);
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
// GPU のエンコーダ (Windows は NVENC・QSV・AMF、Mac は VideoToolbox) は、ランナーで GPU を使えなくても組み込んである。
// VideoToolbox に AV1 のエンコーダは無い。Android の MediaCodec は hwenc.ts にまだつないでいないので、ここには入れずに下で別に試す
const gpuKinds = windows
  ? (["nvenc", "qsv", "amf"] as const)
  : android
    ? ([] as const)
    : (["videotoolbox"] as const);
const gpuCodecs = windows
  ? (["h264", "hevc", "av1"] as const)
  : (["h264", "hevc"] as const);
const gpuEncoders = gpuKinds.flatMap((kind) =>
  gpuCodecs.map((codec) => `${codec}_${kind}`),
);
const mediacodec = android
  ? ["h264", "hevc", "av1"].map((codec) => `${codec}_mediacodec`)
  : [];
for (const name of [
  "libx264",
  "libsvtav1",
  "libopus",
  "aac",
  "mjpeg",
  ...gpuEncoders,
  ...mediacodec,
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
// 4K の局のライブと録画の H.264・H.265 (live.uhdVideoArgs・encoder.ts)。10 ビットの映像を縮めて、HLG を SDR に直す
await ff(
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:rate=60000/1001:duration=1",
  "-vf",
  ["format=yuv420p10le", "scale=-2:180", ...HLG_TO_SDR].join(","),
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-f",
  "mp4",
  at("uhd.mp4"),
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
// CM のチャプターを書き足す (`cm.chapterArgs`)。H.264 の mkv にそのまま写して付ける
await Bun.write(
  at("chapters.txt"),
  ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=A\n",
);
await ff(
  "-i",
  at("h264.mkv"),
  "-i",
  at("chapters.txt"),
  "-map",
  "0",
  "-map_chapters",
  "1",
  "-c",
  "copy",
  "-f",
  "matroska",
  at("chapters.mkv"),
);
console.log("ffmpeg: ok");
// ffprobe は ffmpeg と別に、読む部品だけで組んである。denpa が読む形式を、denpa と同じ引数で読めるか
await probeSmoke(ffprobe, ff, at);

/*
 * GPU のエンコーダ。Windows のランナーに GPU は無いのでエンコードは通らない。Mac のランナーでは VideoToolbox が通る。
 * ここで見るのは次の 3 つ。
 * 1. denpa が渡すエンコーダのオプション (hwenc.hwArgs・hwenc.liveHwArgs) を、組み込んだエンコーダが持っている
 * 2. hwArgs の引数で起動すると、通るか GPU が無いために落ちる (エンコーダやオプションの名前が違って落ちるのではない)
 * 3. 試しのエンコードが全部落ちると、GPU の方式は 0 になり、録画もライブもソフトウェアでエンコードする。
 *    通ったものがあれば、その方式で放送に似せた素材をエンコードでき、試しのエンコードが落ちる ffmpeg で探し直すとソフトウェアに戻る
 */
const options: Record<string, string[]> = {
  nvenc: ["gpu", "preset", "rc", "delay", "zerolatency"],
  qsv: ["preset", "async_depth"],
  amf: ["usage", "quality", "rc", "async_depth"],
  videotoolbox: ["profile", "prio_speed", "realtime"],
};
/**
 * 名前の付いた値で渡すオプションは、その値も選択肢にあるか見る。AMF は録画の高画質の指定 (`high_quality`)、
 * 高画質の指定が通らない世代向けの指定 (`transcoding`・`quality`)、ライブの指定 (`ultralowlatency`・`speed`・`vbr_latency`)
 */
const choices: Record<string, Record<string, string[]>> = {
  amf: {
    usage: ["high_quality", "transcoding", "ultralowlatency"],
    quality: ["high_quality", "quality", "speed"],
    rc: ["vbr_peak", "vbr_latency"],
  },
};
/** `-h encoder=…` の、あるオプションの下に並ぶ選択肢の名前 */
function choicesOf(help: string, option: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s+-${option}\\s`).test(line),
  );
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s+-/.test(line) || !/^\s{3,}\S/.test(line)) break;
    names.push(line.trim().split(/\s+/)[0]!);
  }
  return names;
}
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
  for (const [option, values] of Object.entries(
    choices[name.split("_")[1]!] ?? {},
  )) {
    const have = choicesOf(help, option);
    for (const value of values) {
      if (!have.includes(value))
        throw new Error(`${name} の -${option} に ${value} がありません`);
    }
  }
}
/*
 * Android: MediaCodec のエンコーダを NDK で (JVM の無いこのプロセスから) 1 秒ずつ流す。エミュレータにもソフトウェアの
 * c2.android のエンコーダがあるので通る。端末によって無いコーデックがある (AV1 は Android 14 から) ので、通らなくても止めず、
 * H.264 が通らないときだけ止める
 */
for (const name of mediacodec) {
  try {
    await ff(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30:duration=1",
      "-vf",
      "format=nv12",
      "-c:v",
      name,
      "-ndk_codec",
      "1",
      "-g",
      "30",
      "-f",
      "null",
      "-",
    );
    console.log(`${name}: ok`);
  } catch (error) {
    if (name === "h264_mediacodec") throw error;
    console.log(`${name}: ${String(error)}`);
  }
}
const { config } = await import("../src/lib/server/config.ts");
config.ffmpeg = ffmpeg;
const { HW_CODECS } = await import("../src/lib/hw.ts");
const { hwArgs, hwChain, liveHw, liveHwArgs, probe } =
  await import("../src/lib/server/hwenc.ts");
type Way = Parameters<typeof hwArgs>[0];
/** 録画とライブの引数で 1 回ずつ起動する。名前が違って落ちたのなら止める */
function tryArgs(label: string, args: string[]): number {
  const run = Bun.spawnSync([
    ffmpeg,
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    ...args,
    "-f",
    "null",
    "-",
  ]);
  const err = run.stderr.toString();
  console.log(`${label}: exit ${run.exitCode}`);
  if (
    /Unknown encoder|Unrecognized option|No such filter|Option not found|Unable to parse option value|Error setting option/.test(
      err,
    )
  )
    throw new Error(`${label} を起動できません:\n${err}`);
  return run.exitCode;
}
for (const kind of gpuKinds) {
  for (const codec of gpuCodecs) {
    const way: Way = windows
      ? { device: `${kind}0`, kind, gpu: 0 }
      : { device: kind, kind };
    const source = ["-f", "lavfi", "-i", "nullsrc=s=256x256:r=30:d=0.2"];
    const hw = hwArgs(way, codec);
    tryArgs(`${codec}_${kind}`, [
      ...hw.device,
      ...source,
      "-vf",
      hw.filter.join(","),
      "-c:v",
      ...hw.encoder,
    ]);
    // QSV の CPU のメモリのまま渡す形 (GPU のメモリへ移せない Kaby Lake などで使う。#2342)
    if (kind === "qsv") {
      const sys = hwArgs({ ...way, qsvSystem: true }, codec);
      tryArgs(`${codec}_${kind} (system memory)`, [
        ...sys.device,
        ...source,
        "-vf",
        sys.filter.join(","),
        "-c:v",
        ...sys.encoder,
      ]);
    }
    // AMF の古い世代向けの指定 (高画質の指定が通らない GPU で録画に使う)
    if (kind === "amf") {
      const old = hwArgs({ ...way, amfTranscoding: true }, codec);
      tryArgs(`${codec}_${kind} (transcoding)`, [
        ...old.device,
        ...source,
        "-vf",
        old.filter.join(","),
        "-c:v",
        ...old.encoder,
      ]);
    }
    const live = liveHwArgs({ way, full: false }, codec);
    tryArgs(`${codec}_${kind} (live)`, [
      ...live.input,
      ...source,
      "-vf",
      live.filter.join(","),
      "-c:v",
      ...live.encoder,
    ]);
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
} else {
  // 試しのエンコードが通った方式は、放送に似せた素材でも録画の引数で通る
  for (const codec of HW_CODECS) {
    const way = hwChain(codec, {})[0];
    if (way === undefined) continue;
    const hw = hwArgs(way, codec);
    await ff(
      ...hw.device,
      "-i",
      at("in.ts"),
      "-vf",
      ["bwdif", ...hw.filter].join(","),
      "-c:v",
      ...hw.encoder,
      "-an",
      "-f",
      "matroska",
      at(`gpu-${codec}.mkv`),
    );
    console.log(`${codec} on ${way.kind}: ok`);
  }
  // 試しのエンコードが全部落ちる ffmpeg (いつも 1 で終わる `false`。Mac) で探し直すと、方式は 0 になってソフトウェアに戻る
  if (!windows) {
    config.ffmpeg = "/usr/bin/false";
    const none = await probe();
    console.log(none.message);
    if (none.devices.length !== 0)
      throw new Error("試しのエンコードが落ちたのに方式が残っています");
    for (const codec of HW_CODECS) {
      if (hwChain(codec, {}).length > 0 || liveHw(codec, {}) !== null)
        throw new Error(
          `試しのエンコードが落ちたのに ${codec} の方式が残っています`,
        );
    }
    console.log("GPU fails: software encoding: ok");
    config.ffmpeg = ffmpeg;
  }
}

if (!(await holdAwake(true))) throw new Error("スリープを止められません");
if (windows) {
  const requests = Bun.spawnSync([
    "powercfg.exe",
    "/requests",
  ]).stdout.toString();
  console.log(requests);
  if (!/bun\.exe/i.test(requests))
    throw new Error("powercfg /requests に bun が出ません");
} else if (!android) {
  const assertions = Bun.spawnSync([
    "pmset",
    "-g",
    "assertions",
  ]).stdout.toString();
  console.log(assertions);
  const mine = assertions
    .split("\n")
    .filter((line) => line.includes(`pid ${process.pid}(`));
  if (
    !mine.some(
      (line) =>
        line.includes("PreventUserIdleSystemSleep") && line.includes("denpa"),
    )
  )
    throw new Error("pmset -g assertions に denpa の抑止が出ません");
}
await holdAwake(false);
console.log("keep awake: ok");

/*
 * Mac: 録画の前に起こす予約 (power.ts と同じ呼び出し)。1 日先に置いて `pmset -g sched` に出ることを見て、取り消す。
 * root でないと置けないので、CI は sudo で流す
 */
if (process.platform === "darwin") {
  const power = await macPower();
  if (power === null) throw new Error("IOKit を読めません");
  const when = Math.floor((Date.now() + 86_400_000) / 1000) * 1000;
  const by = `denpa-smoke-${process.pid}`;
  const sched = () => Bun.spawnSync(["pmset", "-g", "sched"]).stdout.toString();
  const code = power.schedule(when, by);
  if (code !== 0)
    throw new Error(
      `IOPMSchedulePowerEvent が 0x${(code >>> 0).toString(16)} を返しました`,
    );
  const listed = sched();
  console.log(listed);
  if (!listed.includes(by))
    throw new Error("pmset -g sched に起こす予約が出ません");
  const cancelled = power.cancel(when, by);
  if (cancelled !== 0 || sched().includes(by))
    throw new Error(
      `起こす予約を取り消せません (0x${(cancelled >>> 0).toString(16)})`,
    );
  console.log("wake schedule: ok");
}

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

// ffmpeg を起こせなかった (Bun.spawn が投げた) ときも、名前付きパイプを待ち受けたまま残さない
if (windows) {
  const { connect } = await import("node:net");
  const unspawned = sideOutput();
  try {
    Bun.spawn([at("no-such-ffmpeg.exe"), unspawned.url]);
  } catch {
    // 起こせない。ここで read を呼ばない
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const left = await new Promise<boolean>((resolve) => {
    const socket = connect(unspawned.url);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (left)
    throw new Error(
      "ffmpeg を起こせなかったのに、名前付きパイプが残っています",
    );
  console.log("side output closes when ffmpeg cannot start: ok");
}
