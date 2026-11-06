/**
 * Windows の配布物 (`denpa-<バージョン>-windows-x64.zip`) を確かめる。CI (test.yml の server-windows) が、
 * 配布物の bun で流す。
 *
 *   bun tests/windows-smoke.ts <配布物を開いた場所> <作業場所>
 *
 * - 同梱の ffmpeg で、denpa が使う経路の主なもの (.github/image-smoke.sh と同じ素材と引数) を流す。
 *   部品を Dockerfile から読んで組んでいるので、足りなければここで落ちる
 * - 進み具合を fd 3 (`-progress pipe:3`) で受けられるか。録画のエンコードと同じ受け方 (encoder.ts)
 * - スリープを止められるか (awake.ts)。`powercfg /requests` に bun が出るかを見る (管理者で動くランナーだけで読める)
 */

import { createServer } from "node:net";
import { join } from "node:path";

import { holdAwake } from "../src/lib/server/awake.ts";

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
for (const name of ["libx264", "libsvtav1", "libopus", "aac", "mjpeg"]) {
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

if (!(await holdAwake(true)))
  throw new Error("SetThreadExecutionState が失敗しました");
const requests = Bun.spawnSync(["powercfg.exe", "/requests"]).stdout.toString();
console.log(requests);
if (!/bun\.exe/i.test(requests))
  throw new Error("powercfg /requests に bun が出ません");
await holdAwake(false);
console.log("keep awake: ok");

// Windows では fd 3 を読めない。名前付きパイプで受けられるか試す
const pipeName = `\\\\.\\pipe\\denpa-smoke-${process.pid}`;
const received = new Promise<string>((resolve, reject) => {
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    socket.on("end", () => {
      server.close();
      resolve(text);
    });
    socket.on("error", reject);
  });
  server.on("error", reject);
  server.listen(pipeName);
});
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
    pipeName,
    "-f",
    "matroska",
    at("progress.mkv"),
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const timeout = new Promise<string>((_, reject) =>
  setTimeout(() => reject(new Error("timeout")), 60_000),
);
const progress = await Promise.race([received, timeout]).catch(
  (error: unknown) => `failed: ${String(error)}`,
);
const code = await proc.exited;
console.log(await new Response(proc.stderr).text());
if (code !== 0 || !progress.includes("progress=end")) {
  throw new Error(
    `名前付きパイプで進み具合を受けられません (終了コード ${code})\n${progress.slice(0, 500)}`,
  );
}
console.log("progress on a named pipe: ok");

// 字幕と同じく matroska をパイプへ流す
const pipe2 = `\\\\.\\pipe\\denpa-smoke-mkv-${process.pid}`;
const bytes = new Promise<number>((resolve, reject) => {
  const server = createServer((socket) => {
    let n = 0;
    socket.on("data", (chunk) => (n += chunk.length));
    socket.on("end", () => {
      server.close();
      resolve(n);
    });
    socket.on("error", reject);
  });
  server.listen(pipe2);
});
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
    "-c",
    "copy",
    "-f",
    "matroska",
    pipe2,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const n = await Promise.race([bytes, timeout.catch(() => -1)]);
console.log(`matroska on a named pipe: ${n} bytes, exit ${await mkv.exited}`);
if (!(n > 0)) throw new Error("名前付きパイプに matroska を流せません");
