/**
 * 撮った画像を docs/images へ置く。どちらもそのままの大きさ (1600×900) で、**静止画は WebP、
 * アニメーションは 30fps の AVIF** にする。アニメーションは画面を巻く・開くといった動きを見せるもので、
 * コマを間引いたり縮めたりするとカクカクにぼやける。AV1 は止まっている間のコマがほとんど場所を取らないので、
 * コマを減らさずに WebP の数分の一の大きさで済む (30fps の WebP は巻く画面で 1 枚数 MB になる)。
 *
 *     bun scripts/docs-images.ts              # 撮ってあるぶん全部
 *     bun scripts/docs-images.ts guide-anim   # 名前を挙げると、そのぶんだけ
 *
 * 元は scripts/capture-docs.ts が docs/images/.capture に置く。組むのは ffmpeg (静止画は libwebp、
 * アニメーションは libsvtav1)。静止画は RGB のまま libwebp に渡し (`bgra`)、YUV への変換を libwebp に任せる
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
const ANIM_FPS = 30;

/** 透明を落として (撮った PNG はどれも不透明) RGB のまま libwebp へ */
const RGB = "format=rgb24,format=bgra";

/**
 * アニメーションの YUV。sRGB の画面なので BT.709 の係数・フルレンジで変換し、その旨をファイルにも書く
 * (書かないとブラウザによって色の読み方が変わり、背景の色がずれる)
 */
const AV1_COLOR = [
  "scale=out_color_matrix=bt709:out_range=full:flags=accurate_rnd+full_chroma_int",
  "format=yuv420p",
  "setparams=range=full:colorspace=bt709:color_primaries=bt709:color_trc=iec61966-2-1",
].join(",");
/**
 * crf は 28 (細い字が崩れない程度)。scm=1 は画面の録画向けの道具 (同じ形の繰り返し・平らな面) を使う設定で、
 * 字の多い画面では 1〜2 割小さくなる。libaom は先読みの設定によっては途中で落ちるので、SVT-AV1 にしている
 */
const AV1 = [
  ...["-c:v", "libsvtav1", "-preset", "5", "-crf", "28"],
  ...["-svtav1-params", "scm=1"],
];

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

function anim(name: string): void {
  const dir = join(SRC, `${name}.frames`);
  const delays = JSON.parse(
    readFileSync(join(dir, "delays.json"), "utf8"),
  ) as number[];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .slice(0, delays.length);
  if (files.length === 0) throw new Error(`${name}: コマがありません`);
  const tmp = mkdtempSync(join(tmpdir(), "docs-images-"));
  try {
    // 撮ったコマは届いた時刻のまま (間隔はまちまち)。見せる長さをミリ秒の時刻で渡し
    // (`framerate 1000` で刻みを 1 ミリ秒にする。既定の 1/25 秒では短いコマの時刻が丸まる)、ffmpeg で 30fps に揃える。
    // concat は最後のコマの長さを読まないので、最後のコマをもう 1 回並べ、全体の長さで切る
    const list = ["ffconcat version 1.0"];
    const entry = (f: string) => [
      `file '${join(dir, f)}'`,
      "option framerate 1000",
    ];
    files.forEach((f, i) =>
      list.push(...entry(f), `duration ${(delays[i]! / 1000).toFixed(3)}`),
    );
    list.push(...entry(files.at(-1)!));
    const ms = delays.reduce((sum, d) => sum + d, 0);
    const txt = join(tmp, "list.txt");
    writeFileSync(txt, `${list.join("\n")}\n`);
    const out = join(DST, `${name}.avif`);
    ffmpeg([
      ...["-f", "concat", "-safe", "0", "-i", txt],
      ...["-vf", `fps=${ANIM_FPS},${AV1_COLOR}`],
      ...AV1,
      ...["-t", (ms / 1000).toFixed(3), "-loop", "0", out],
    ]);
    console.log(
      name,
      files.length,
      "frames ->",
      `${ANIM_FPS}fps`,
      `${(ms / 1000).toFixed(1)}s`,
      kb(out),
      "KB",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 撮ってあるものを docs/images に置く。names を挙げるとそのぶんだけ */
export function toDocsImages(names: readonly string[] = []): void {
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

if (import.meta.main) toDocsImages(process.argv.slice(2));
