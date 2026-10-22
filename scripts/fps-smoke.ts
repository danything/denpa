/**
 * コマ数の見分け方 (`src/lib/server/fps.ts`) を、**本物の ffmpeg と合成の映像で**確かめる。
 *
 * 単体テストは偽の ffmpeg で回るので、フィルタの出力の形 (`metadata@top` の行) や、実際の
 * テレシネ・60i・30p で値が分かれるかはここでしか見ていない。イメージの中で動かす
 * (`.github/image-smoke.sh`)。放送のデータは使わず、testsrc2 から放送と同じ形
 * (1440x1080 の MPEG-2 インターレースの TS) を作る。
 *
 * 使い方: bun scripts/fps-smoke.ts [作業用のディレクトリ]
 */
import { fpsArgs, judgeWindow, windowLabel } from "../src/lib/server/fps";

const dir = process.argv[2] ?? ".";
const SECONDS = 10;
const src = (rate: string, size = "1440x1080") =>
  `testsrc2=size=${size}:rate=${rate}:duration=${SECONDS}`;

/** 素材ごとの作り方 (ffmpeg の入力とフィルタ) と、なってほしい判定 */
const cases: { name: string; make: string[]; want: string }[] = [
  {
    name: "telecine",
    make: [
      "-f",
      "lavfi",
      "-i",
      src("24000/1001"),
      "-vf",
      "telecine=pattern=23",
    ],
    want: "24p",
  },
  {
    name: "telecine-noise",
    make: [
      "-f",
      "lavfi",
      "-i",
      src("24000/1001"),
      "-vf",
      "noise=alls=8:allf=t,telecine=pattern=23",
    ],
    want: "24p",
  },
  {
    // 画面の下に 60i で流れるテロップの帯が乗ったアニメ
    name: "telecine-telop",
    make: [
      ...["-f", "lavfi", "-i", src("24000/1001")],
      ...["-f", "lavfi", "-i", src("60000/1001", "1440x120")],
      ...[
        "-filter_complex",
        "[0]telecine=pattern=23[t];[1]tinterlace=mode=interleave_top[k];[t][k]overlay=y=920",
      ],
    ],
    want: "24p",
  },
  {
    name: "60i",
    make: [
      "-f",
      "lavfi",
      "-i",
      src("60000/1001"),
      "-vf",
      "tinterlace=mode=interleave_top",
    ],
    want: "60i",
  },
  { name: "30p", make: ["-f", "lavfi", "-i", src("30000/1001")], want: "30p" },
];

let ok = true;
for (const c of cases) {
  const file = `${dir}/fps-${c.name}.ts`;
  const made = Bun.spawnSync([
    "ffmpeg",
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
    ...c.make,
    ...[
      "-c:v",
      "mpeg2video",
      "-flags",
      "+ilme+ildct",
      "-b:v",
      "15M",
      "-f",
      "mpegts",
      file,
    ],
  ]);
  if (made.exitCode !== 0) {
    console.error(`${c.name}: 作れません\n${made.stderr.toString()}`);
    ok = false;
    continue;
  }
  const measured = Bun.spawnSync(["ffmpeg", ...fpsArgs(file, 0, SECONDS)]);
  const window = judgeWindow(measured.stderr.toString().split("\n"));
  const good = measured.exitCode === 0 && window.kind === c.want;
  console.log(
    `${good ? "ok" : "NG"} ${c.name}: ${windowLabel(window)} (なってほしいのは ${c.want})`,
  );
  if (!good) ok = false;
}
process.exit(ok ? 0 : 1);
