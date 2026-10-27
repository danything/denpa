/**
 * 撮った画像を docs/images へ置く。**静止画はそのままの大きさ (1600×900) で、
 * アニメーションは 1120×630 に縮めて** WebP にする。アニメーションは、同じフレームが続くところを 1 枚に
 * まとめてその間だけ長く見せる (押した瞬間だけ変わる画面は、ほとんどのコマが同じ)。
 *
 *     bun scripts/docs-webp.ts              # 撮ってあるぶん全部
 *     bun scripts/docs-webp.ts guide-anim   # 名前を挙げると、そのぶんだけ
 *
 * 元は scripts/capture-docs.ts が docs/images/.capture に置く。組むのは ffmpeg (libwebp)。
 * RGB のまま libwebp に渡し (`bgra`)、YUV への変換を libwebp に任せる
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FFMPEG = process.env["DOCS_FFMPEG"] ?? "/usr/bin/ffmpeg";
const SRC = resolve(process.env["OUT"] ?? "docs/images/.capture");
const DST = "docs/images";
/** 撮るのは広い画面 (1600×900)、貼るのは 1120×630 まで縮めて軽くする */
const ANIM_WIDTH = 1120;
/** コマが多いと重くなる。これを超えたら 1 つ飛ばしにして、その分だけ長く見せる */
const MAX_FRAMES = 40;

/** 透明を落として (撮った PNG はどれも不透明) RGB のまま libwebp へ */
const RGB = "format=rgb24,format=bgra";
const SCALE = `scale='min(${ANIM_WIDTH},iw)':-1:flags=lanczos+accurate_rnd+full_chroma_int`;

function ffmpeg(args: string[]): string {
  const r = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg が失敗しました: ${r.stderr}`);
  return r.stdout;
}

const kb = (file: string) => Math.round(statSync(file).size / 1024);

/**
 * 同じコマをまとめ、多すぎれば間引く。hashes は縮めたあとの中身。
 * 返すのは残すコマの番号と、それぞれを見せる長さ (ミリ秒)
 */
function plan(
  hashes: readonly string[],
  delays: readonly number[],
): { index: number; ms: number }[] {
  let frames: { index: number; ms: number }[] = [];
  hashes.forEach((hash, i) => {
    const ms = delays[i] ?? 0;
    const last = frames.at(-1);
    if (last !== undefined && hashes[last.index] === hash) last.ms += ms;
    else frames.push({ index: i, ms });
  });
  while (frames.length > MAX_FRAMES)
    frames = frames.flatMap((f, i, all) =>
      i % 2 === 0 ? [{ index: f.index, ms: f.ms + (all[i + 1]?.ms ?? 0) }] : [],
    );
  return frames;
}

function still(name: string): void {
  const out = join(DST, `${name}.webp`);
  ffmpeg([
    "-i",
    join(SRC, `${name}.png`),
    "-vf",
    RGB,
    ...["-c:v", "libwebp", "-quality", "80", "-compression_level", "6"],
    out,
  ]);
  console.log(name, "still", kb(out), "KB");
}

/**
 * 最後のコマの長さを、全体が total ミリ秒になるように書き直す。ffmpeg は最後のコマの長さを
 * libwebp に渡さず、libwebp はそれまでのコマの長さの平均で埋めるので
 */
function setTotal(file: string, total: number): void {
  const buf = readFileSync(file);
  const frames: number[] = [];
  for (let p = 12; p + 8 <= buf.length;) {
    const size = buf.readUInt32LE(p + 4);
    if (buf.toString("ascii", p, p + 4) === "ANMF") frames.push(p + 8);
    p += 8 + size + (size & 1);
  }
  const last = frames.pop();
  // 1 コマに縮まったものは静止画として書かれる (長さが無い)
  if (last === undefined) return;
  const before = frames.reduce(
    (sum, at) => sum + buf.readUIntLE(at + 12, 3),
    0,
  );
  if (before >= total) throw new Error(`${file}: コマの長さが合いません`);
  buf.writeUIntLE(total - before, last + 12, 3);
  writeFileSync(file, buf);
}

function anim(name: string): void {
  const dir = join(SRC, `${name}.frames`);
  const delays = JSON.parse(
    readFileSync(join(dir, "delays.json"), "utf8"),
  ) as number[];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .slice(0, delays.length);
  const tmp = mkdtempSync(join(tmpdir(), "docs-webp-"));
  try {
    // 縮めたあとの中身でコマを見比べる (縮めると同じになるコマもまとまる)
    const all = join(tmp, "all.txt");
    writeFileSync(
      all,
      `ffconcat version 1.0\n${files.map((f) => `file '${join(dir, f)}'\n`).join("")}`,
    );
    const hashes = ffmpeg([
      ...["-f", "concat", "-safe", "0", "-i", all],
      ...["-vf", `${RGB},${SCALE}`, "-fps_mode", "passthrough"],
      ...["-f", "framemd5", "-"],
    ])
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => l.split(",").at(-1)?.trim() ?? "");
    if (hashes.length !== files.length)
      throw new Error(`${name}: コマの数が合いません`);
    const frames = plan(hashes, delays);
    if (frames.length === 0) throw new Error(`${name}: コマがありません`);

    // 見せる長さはミリ秒の時刻で渡す (`framerate 1000` で刻みを 1 ミリ秒にする)
    const list = ["ffconcat version 1.0"];
    for (const f of frames) {
      list.push(
        `file '${join(dir, files[f.index]!)}'`,
        "option framerate 1000",
        `duration ${(f.ms / 1000).toFixed(3)}`,
      );
    }
    const kept = join(tmp, "kept.txt");
    writeFileSync(kept, `${list.join("\n")}\n`);
    const out = join(DST, `${name}.webp`);
    ffmpeg([
      ...["-f", "concat", "-safe", "0", "-i", kept],
      ...["-vf", `${RGB},${SCALE}`, "-fps_mode", "passthrough"],
      ...["-c:v", "libwebp_anim", "-quality", "62", "-compression_level", "4"],
      ...["-loop", "0", out],
    ]);
    setTotal(
      out,
      frames.reduce((sum, f) => sum + f.ms, 0),
    );
    console.log(
      name,
      files.length,
      "->",
      frames.length,
      "frames",
      kb(out),
      "KB",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 撮ってあるものを WebP にする。names を挙げるとそのぶんだけ */
export function toWebp(names: readonly string[] = []): void {
  if (!existsSync(SRC)) throw new Error(`${SRC} がありません`);
  const want = (n: string) => names.length === 0 || names.includes(n);
  const entries = readdirSync(SRC).sort();
  for (const f of entries)
    if (f.endsWith(".png") && want(f.slice(0, -".png".length)))
      still(f.slice(0, -".png".length));
  for (const f of entries)
    if (f.endsWith(".frames") && want(f.slice(0, -".frames".length)))
      anim(f.slice(0, -".frames".length));
}

if (import.meta.main) toWebp(process.argv.slice(2));
