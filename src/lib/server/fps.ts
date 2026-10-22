/**
 * 録画を 30コマで出すか 60コマで出すかを、**フィールドを比べて**決める (純粋な計算と ffmpeg の引数)。
 * 実際に ffmpeg を回すのは `encoder.measureSmoothMotion`。
 *
 * 放送の TS に「本当のコマ数」は入っていない — EIT も符号化ヘッダも、素材が 24p の
 * アニメでも**全部 1080i/60 と名乗る** (本番の実測)。そこで素材を3つに分ける:
 *
 * - 24p 系 (アニメ・フィルム) … 3:2 のテレシネで、同じフィールドが5回に1回繰り返される (`fpsRepeat`)
 * - 30p … 上下のフィールドが同じ時刻のコマ (`fpsWeave`)
 * - 60i (実写・生放送) … どちらでもない
 *
 * 24p 系と 30p は 30コマ、60i は 60コマ。窓ごとに分けて多数決 (`pickSmooth`)。
 * 以前の「60コマに起こして重複を落とした残りの割合」は、bwdif が同じコマから少しずつ違う2枚を
 * 作るので、動きの激しいアニメ (OP) で 60コマ側に釣り上がった。実測の表は
 * docs/encode.md「コマ数は本編の映像から測って決める」に。
 *
 * **ほかのモジュールを読まない。** イメージの中の本物の ffmpeg で確かめるとき
 * (`scripts/fps-smoke.ts`) に、このファイルだけを持ち込んで動かすため
 */

/** 1窓の長さ(秒) */
export const FPS_WINDOW = 30;
/**
 * 測る窓の位置 (録画のどのあたりか)。**5窓・多数決** — 3窓だとアイキャッチや OP に
 * 1窓乗るだけで引きずられる。CM (エンコードしながら探すので、測る時点では分からない) に
 * 乗るのは多くて2窓 (本番の録画 117 本の CM 位置で数えた)
 */
export const FPS_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];
/** 24p 系 (テレシネ) とみなす `rep` の上限。アニメ本編 0.04〜0.42、実写の 60i 0.83〜0.93 */
const FPS_REPEAT = 0.45;
/** 30p とみなす `wr` の上限。30p 0.24〜0.40、それ以外 0.56 以上 (実写の 60i は 0.87〜0.97) */
const FPS_WEAVE = 0.5;
/** 動いているとみなす1秒の差の平均 (signalstats の YDIF)。下回る秒 (静止・黒) は数えない */
const FPS_MOTION = 0.5;
/** 窓を判定するのに要る、動いている秒の数。足りない窓は「測れない」 */
const FPS_MIN_SECONDS = 5;

/**
 * 1窓ぶんの ffmpeg の引数 (ffmpeg そのものは除く)。60コマに起こさず、フィールドそのものを比べる。
 *
 * - `top` … 上フィールドだけを並べ、前の上フィールドとの差 (YDIF) を出す。`fpsRepeat` の材料
 * - `fields` … 上下のフィールドを交互に並べ (`separatefields`)、隣との差を出す。`fpsWeave` の材料
 *
 * 出力は名前 (`metadata@top`) で見分ける。番号 (`Parsed_metadata_3`) はフィルタの並びで変わる。
 * **主映像 (HD) に固定する** (`0:v:0`)。GR には 1seg (H.264 320x180) が混じっていて、
 * 指さないとフィルタがそちらに当たる (実測で判明)
 */
export function fpsArgs(
  input: string,
  at: number,
  seconds = FPS_WINDOW,
): string[] {
  const filter =
    "[0:v:0]split[t][f];" +
    "[t]field=type=top,signalstats,metadata@top=mode=print:key=lavfi.signalstats.YDIF[top];" +
    "[f]separatefields,signalstats,metadata@fields=mode=print:key=lavfi.signalstats.YDIF[fields]";
  return [
    "-hide_banner",
    "-nostats",
    "-ss",
    String(Math.max(0, at)),
    "-t",
    String(seconds),
    "-i",
    input,
    "-filter_complex",
    filter,
    ...["top", "fields"].flatMap((out) => [
      "-map",
      `[${out}]`,
      "-fps_mode",
      "passthrough",
      "-f",
      "null",
      "-",
    ]),
  ];
}

/** フィルタが出した差の列。どちらも先頭 (前が無いので 0) は捨ててある */
export interface FieldDiffs {
  top: number[];
  fields: number[];
}

/** ffmpeg の標準エラーから、`metadata@top` / `metadata@fields` の YDIF を拾う */
export function parseFieldDiffs(lines: Iterable<string>): FieldDiffs {
  const out: FieldDiffs = { top: [], fields: [] };
  for (const line of lines) {
    const m = line.match(
      /\[metadata@(top|fields) @ [^\]]*\] lavfi\.signalstats\.YDIF=([\d.]+)/,
    );
    if (m) out[m[1] as keyof FieldDiffs].push(Number(m[2]));
  }
  return { top: out.top.slice(1), fields: out.fields.slice(1) };
}

/** 値と、それを出せた (動いていた) 秒の数 */
export interface Score {
  value: number;
  seconds: number;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 列を1秒ずつ切り、動いている秒だけ `score` に掛けて中央値を採る */
function perSecond(
  values: number[],
  perSec: number,
  score: (second: number[]) => number,
): Score {
  const scores: number[] = [];
  for (let i = 0; i + perSec <= values.length; i += perSec) {
    const second = values.slice(i, i + perSec);
    if (mean(second) < FPS_MOTION) continue;
    const s = score(second);
    if (Number.isFinite(s)) scores.push(s);
  }
  scores.sort((a, b) => a - b);
  return {
    value: scores[Math.floor(scores.length / 2)] ?? Number.NaN,
    seconds: scores.length,
  };
}

/**
 * **同じフィールドの繰り返し** (`rep`)。上フィールドどうしの差を1秒 (30個) ずつ位相 mod 5 で平均し、
 * いちばん小さい位相 ÷ 残り4つの平均。3:2 のテレシネは5回に1回同じフィールドを繰り返すので
 * 0 に近く、60i と 30p は 1 に近い
 */
export function fpsRepeat(top: number[]): Score {
  return perSecond(top, 30, (second) => {
    const phase = [0, 0, 0, 0, 0];
    second.forEach((v, i) => {
      phase[i % 5] = (phase[i % 5] ?? 0) + v;
    });
    const min = Math.min(...phase);
    const others = (phase.reduce((a, b) => a + b, 0) - min) / 4;
    return others > 0 ? min / others : Number.NaN;
  });
}

/**
 * **同じコマの上下の差** (`wr`)。交互に並べたフィールドの差を「同じコマの上と下」と
 * 「コマをまたぐ」に分け、小さいほう ÷ 大きいほう。30p は上下が同じ時刻のコマなので低く、
 * 60i とテレシネは 1 に近い
 */
export function fpsWeave(fields: number[]): Score {
  return perSecond(fields, 60, (second) => {
    const within = mean(second.filter((_, i) => i % 2 === 0));
    const across = mean(second.filter((_, i) => i % 2 === 1));
    const max = Math.max(within, across);
    return max > 0 ? Math.min(within, across) / max : Number.NaN;
  });
}

/** 窓の素材。`null` は測れない (静止・黒・失敗) */
export type FpsKind = "24p" | "30p" | "60i" | null;

/** 窓1つを、繰り返し (`rep`) と上下の差 (`wr`) から分ける */
export function classifyWindow(rep: Score, wr: Score): FpsKind {
  if (rep.seconds < FPS_MIN_SECONDS) return null;
  if (rep.value < FPS_REPEAT) return "24p";
  if (wr.seconds < FPS_MIN_SECONDS) return null;
  return wr.value < FPS_WEAVE ? "30p" : "60i";
}

/** 1窓の測った結果 */
export interface FpsWindow {
  rep: Score;
  wr: Score;
  kind: FpsKind;
}

/** 測れなかった窓 (ffmpeg の失敗など) */
export const UNMEASURED: FpsWindow = {
  rep: { value: Number.NaN, seconds: 0 },
  wr: { value: Number.NaN, seconds: 0 },
  kind: null,
};

/** ffmpeg (`fpsArgs`) の標準エラーの行から、1窓を分ける */
export function judgeWindow(lines: Iterable<string>): FpsWindow {
  const diffs = parseFieldDiffs(lines);
  const rep = fpsRepeat(diffs.top);
  const wr = fpsWeave(diffs.fields);
  return { rep, wr, kind: classifyWindow(rep, wr) };
}

/**
 * 窓の多数決で 60コマにするか決める。**迷ったら 60コマ** — 60i が 24p 系 + 30p と同数以上、
 * または測れた窓が無ければ 60。本物の 60i を 30コマに落とすと動きが崩れるが、逆は無駄が出るだけ
 */
export function pickSmooth(kinds: FpsKind[]): boolean {
  const smooth = kinds.filter((k) => k === "60i").length;
  const film = kinds.filter((k) => k === "24p" || k === "30p").length;
  return smooth >= film;
}

/** ログに出す1窓。`24p (rep 0.12 / wr 0.95)`。閾値を詰め直すときの材料 */
export function windowLabel(w: FpsWindow): string {
  const n = (s: Score) => (Number.isFinite(s.value) ? s.value.toFixed(2) : "-");
  return `${w.kind ?? "測れず"} (rep ${n(w.rep)} / wr ${n(w.wr)})`;
}
