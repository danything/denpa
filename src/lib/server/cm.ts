import { clock, LOGO_OK, LOGO_UNUSABLE } from "../format";
import {
  decideCm,
  intersect,
  missingVideo,
  type Range,
  totalLength,
} from "../ts/cm-decide";
import { OFF, ON } from "../ts/logo-detect";
import type { CmMaterial } from "./cm-material";
import { type Scan, scan, type ScanWant } from "./cm-scan";
import { config } from "./config";
import { logoRepo, share } from "./logo-data";
import { openLogo } from "./logo-own";
import { recordingInput, recordingProbeInput } from "./recording-io";
import { run } from "./stream";
import { tsProbe } from "./ts-probe";

/**
 * CM 検出。
 *
 * **1 本の ffmpeg で 1 回だけデコードして材料を取り** (`cm-scan.ts`。無音・場面の切れ目・局ロゴの枠)、
 * 境目は TS で決める (`ts/cm-decide.ts`)。
 *
 * - **ロゴの消えている所を CM にする**。境目は近くの「無音 + 切れ目」に寄せる
 * - ロゴが使えない (覚えられない・当たらない・結果がおかしい) ときは、同じ材料から
 *   **CM の尺 (15 秒の倍数) だけで**決め直す。もう一度デコードはしない
 *
 * 見つけた CM はチャプターにするだけで、エンコードしたものは切らない (誤検出しても本編が消えない)。
 */

export type { Range };

/**
 * これ以上が CM 判定になったら、その結果は信じない。
 *
 * **ロゴでも尺だけでも同じ値を使う。** どちらも「番組が丸ごと CM」は
 * 検出が効いていない兆候で、本編を削るより CM が残るほうが被害が小さい。
 */
const MAX_CM_RATIO = 0.5;

/**
 * CM 判定が占める割合 (0〜1)。**映像の欠けた所 (`missing`) は分母にも分子にも入れない。** 欠けた所は CM か番組か決められない。
 * 尺で割っていた頃は、途中から最後まで映像が欠けた録画で、欠けた所のぶん割合が上がっていた (`ts/cm-decide.missingVideo`)
 */
function cmShare(cm: Range[], duration: number, missing: Range[]): number {
  const known = duration - totalLength(missing);
  if (!Number.isFinite(known) || known <= 0) return 0;
  return (totalLength(cm) - totalLength(intersect(cm, missing))) / known;
}

/** CM 判定が占める割合 (%。整数に丸める) */
export function cmRatio(
  cm: Range[],
  duration: number,
  missing: Range[] = [],
): number {
  return Math.round(cmShare(cm, duration, missing) * 100);
}

/**
 * CM 判定が多すぎないか。
 *
 * ロゴを覚えたてのときなど、「先頭の 2 秒だけ本編」のような結果になることがある。
 */
export function tooMuchCm(
  cm: Range[],
  duration: number,
  missing: Range[] = [],
): boolean {
  return cmShare(cm, duration, missing) >= MAX_CM_RATIO;
}

/** これより短い区間は作らない (チャプターが増えるだけで飛ばす役に立たない) */
const MIN_RANGE = 0.5;

/**
 * 区間の裏返し。CM を渡して本編の区間をもらう (チャプター)。
 *
 * 渡された区間は並べ替えてから使う。
 *
 * {@link MIN_RANGE} より短い隙間は作らない。
 */
export function invertRanges(ranges: Range[], duration: number): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  let cursor = 0;
  for (const block of sorted) {
    if (block.start - cursor > MIN_RANGE)
      out.push({ start: cursor, end: block.start });
    cursor = Math.max(cursor, block.end);
  }
  if (duration - cursor > MIN_RANGE) out.push({ start: cursor, end: duration });
  return out;
}

/**
 * 区間の時刻を、捨てた先頭のぶんだけ前へ詰める。
 *
 * エンコードは先頭 (映像が出るまでの音声だけの区間、実機で 0.5〜0.9 秒) を
 * `-ss` で捨てて 0 秒から始める (`encoder.headSkip`)。検出した時刻をそのまま
 * チャプターに書くと**全チャプターがそのぶん遅れて入り**、CM の自動スキップは
 * 毎回そのぶん CM を見せてから飛んで、着地も本編に食い込んでいた
 * (字幕はエンコードする ffmpeg が映像と一緒に詰める)。
 *
 * 詰めた結果 {@link MIN_RANGE} も残らない区間は落とす。
 */
export function shiftRanges(ranges: Range[], by: number): Range[] {
  if (by <= 0) return ranges;
  return ranges
    .map((r) => ({ start: Math.max(0, r.start - by), end: r.end - by }))
    .filter((r) => r.end - r.start > MIN_RANGE);
}

/**
 * 本編と CM を交互に並べたチャプター。エンコードしたものに書くもの (`chapterMetadata`) と、
 * エンコード済みが無い録画の CM 飛ばし (`api/recordings/<id>/chapters`) で同じものを使う
 */
export function chapterList(
  cm: Range[],
  duration: number,
): { start: number; end: number; title: string }[] {
  const keep = invertRanges(cm, duration);
  return [
    ...keep.map((r) => ({ ...r, title: "本編" })),
    ...cm.map((r) => ({ ...r, title: "CM" })),
  ].sort((a, b) => a.start - b.start);
}

/**
 * ffmetadata 形式のチャプター定義。本編と CM を交互のチャプターにして、
 * プレイヤーのチャプター送りで CM を飛ばせるようにする (ファイルは切らない)。
 */
export function chapterMetadata(cm: Range[], duration: number): string {
  const lines = [";FFMETADATA1"];
  for (const chapter of chapterList(cm, duration)) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${Math.round(chapter.start * 1000)}`,
      `END=${Math.round(chapter.end * 1000)}`,
      `title=${chapter.title}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** チャプターを差し替えて書き直す。再エンコードしない。`chapters` が null ならチャプターを外す */
export function chapterArgs(
  input: string,
  chapters: string | null,
  output: string,
): string[] {
  return [
    config.ffmpeg,
    "-y",
    "-v",
    "error",
    ...recordingInput(input),
    ...(chapters === null
      ? ["-map", "0", "-map_chapters", "-1"]
      : ["-i", chapters, "-map", "0", "-map_chapters", "1"]),
    "-c",
    "copy",
    "-f",
    "matroska",
    output,
  ];
}

/**
 * ffprobe の `key=value` 出力を読む。**位置では読まない。**
 *
 * - 1 本の TS に局がいくつも入っていると (TOKYO MX)、`-select_streams v:0` でも
 *   **同じ行が番組の数だけ並ぶ**
 * - `-show_entries` に**書いた順では返らない** (`avg_frame_rate,width,height` が幅,高さ,fps の順で来る)
 *
 * キーで引き、**同じキーは最初のものを採る**。
 */
export function fields(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!map.has(key)) map.set(key, line.slice(eq + 1).trim());
  }
  return map;
}

/** `30000/1001` の形式のフレームレートを数に直す。読めなければ NaN */
export function parseFrameRate(value: string | undefined): number {
  const [num = NaN, den] = (value ?? "").trim().split("/").map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? fps : NaN;
}

/** ffprobe を 1 回動かして、標準出力を返す */
async function probe(input: string, args: string[]): Promise<string> {
  const result = await run(
    [config.ffprobe, "-v", "error", ...args, ...recordingProbeInput(input)],
    {
      stdout: true,
    },
  );
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * 尺とフレームレートを先に取る (ffmpeg の stderr の `Duration:` は TS によっては出ない)。
 *
 * **頭出し (`probeLeadIn`) はここに含めない。** あちらは実際にデコードしてみる
 * ぶんだけ高くつくのに、要るのはエンコードする前の 1 回だけ
 */
export async function probeVideo(input: string): Promise<{
  duration: number;
  fps: number;
  width: number;
  height: number;
  formatStart: number;
  packetStart: number;
  sar: number;
}> {
  const read = (args: string[]) => probe(input, args);

  let format = new Map<string, string>();
  let stream = new Map<string, string>();
  try {
    // `nk=1` (キーを出さない) にはしない。キーで引くために必ず `key=value` で受ける
    format = fields(
      await read([
        "-show_entries",
        "format=duration,start_time",
        "-of",
        "default=nw=1",
      ]),
    );
    stream = fields(
      await read([
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,width,height,start_time,sample_aspect_ratio",
        "-of",
        "default=nw=1",
      ]),
    );
  } catch {
    // ffprobe が使えない環境。呼ぶ側が NaN を見て諦める
  }
  const finite = (value: number) => (Number.isFinite(value) ? value : NaN);
  const positive = (value: number) => (value > 0 ? finite(value) : NaN);
  return {
    duration: positive(Number(format.get("duration"))),
    fps: positive(parseFrameRate(stream.get("avg_frame_rate"))),
    // 映像の大きさ (エンコード先の大きさ・映像が在るかの見分け・ロゴ探し)
    width: positive(Number(stream.get("width"))),
    height: positive(Number(stream.get("height"))),
    /**
     * **入れ物そのものの始まり (PTS)。** 先頭からの秒数ではなく放送の時刻で、
     * この録画では 6115.51 だった。
     *
     * ffmpeg は入力の時刻からこれを引いて 0 から数え直す。**同じ TS を
     * 別々に ffmpeg へ通すときは、双方が同じものを引いていないと噛み合わない**。
     * 頭出し (`probeLeadIn`) もこれを引いて測る
     */
    formatStart: finite(Number(format.get("start_time"))),
    /** 映像の最初の**パケット**の時刻 (PTS)。デコードできるコマを探せなかったときの代用 */
    packetStart: Number(stream.get("start_time")),
    /**
     * 画素の横長さ。1440x1080 の地上波 HD は 4:3 で、これを掛けると 1920 になる。
     * 読めなければ 1 (正方形) とみなす
     */
    sar: parseRatio(stream.get("sample_aspect_ratio")),
  };
}

/**
 * ffprobe の JSON から、**中身のある音声**が音声の何本目かを読み取る (`0:a:<n>` の n)。
 *
 * 中身があるかは `channels` で見る。探り (`tsProbe`) の間に 1 パケットも来なかった
 * 音声はデコードできておらず、0 のまま出てくる
 */
export function liveAudioIndexes(json: string): number[] {
  const parsed = JSON.parse(json) as { streams?: { channels?: number }[] };
  return (parsed.streams ?? []).flatMap((stream, index) =>
    (stream.channels ?? 0) > 0 ? [index] : [],
  );
}

/**
 * エンコードするときに使う音声 (音声の何本目か)。**先頭に中身の無い音声は使わない。**
 *
 * 録画の末尾には次の番組の先頭が少し入る。次の番組が副音声つきだと、その音声の PID が
 * 最後の十数秒だけ現れ、`-map 0:a` はそれも 1 本の音声として取り込んでしまう
 * (出来上がりに**末尾にしか中身の無い音声トラック**が入る)。
 *
 * **探りの長さはエンコードするほうと揃える** (`tsProbe`)。何本目かで名指しするので、
 * 見えている音声の並びが食い違うと別の音声を指してしまう。
 *
 * 分からなければ空を返し、呼ぶ側は全部使う
 */
export async function probeLiveAudio(
  input: string,
  lead = 0,
): Promise<number[]> {
  try {
    return liveAudioIndexes(
      await probe(input, [
        ...tsProbe(lead),
        "-select_streams",
        "a",
        "-show_entries",
        "stream=channels",
        "-of",
        "json",
      ]),
    );
  } catch {
    return [];
  }
}

/**
 * **映像が出るまでの、音声だけの区間 (秒)。エンコードするときに先頭から捨てる長さ。**
 *
 * TS は音声のほうが先に始まっているのがふつうで、実機では 0.930 秒あった。
 * 残したままエンコードすると出来上がりも音声だけの区間から始まり、**1 コマ目を 0 秒として
 * 数えるプレイヤー**ではそのぶん字幕が早く出る。ずらす (`-output_ts_offset`) のでは
 * 直らないので捨てる (`encoder.buildArgs` の `-ss`)。
 *
 * **測るのは「実際にデコードできた 1 コマ目」。** stream の `start_time` は最初の
 * **パケット**の時刻で、そこから何コマかは参照先が録れておらず捨てられる。
 * 実機ではその差が 0.567 秒 (17 コマ = 半 GOP) あった。
 *
 *     start_time 6115.872 / 実際に出た 1 コマ目 6116.439 (I)
 *
 * `probeVideo` とは別にしてある (理由はあちら)。`formatStart` はあちらで取ったものを渡す
 */
export async function probeLeadIn(
  input: string,
  formatStart: number,
  packetStart = NaN,
): Promise<number> {
  let first = NaN;
  try {
    first = firstFrameTime(
      // 上限 (MAX_LEAD_IN) より先まで読んでも使わないので、そのぶんだけ見る
      await probe(input, [
        "-select_streams",
        "v:0",
        "-show_frames",
        "-read_intervals",
        `%+${MAX_LEAD_IN + 1}`,
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "default=nw=1",
      ]),
    );
  } catch {
    // ffprobe が使えない環境。パケットの時刻で代用する
  }
  return leadIn(Number.isFinite(first) ? first : packetStart, formatStart);
}

/**
 * 頭出しとして認める上限 (秒)。**入れ物の始まりから数える。**
 *
 * TS の時刻は**放送の時刻そのもの** (PTS) で、先頭からの秒数ではない。実機では
 * 62170 のような値が入る。引き算を忘れるとその値がそのまま先頭を捨てる長さになり、
 * **17 時間ぶん読み飛ばして中身の無いものができあがる**。
 *
 * ずれが数秒を超えたら 0 にする。読み違えているほうが疑わしく、
 * 大きく捨てると壊れ方が派手になる
 */
const MAX_LEAD_IN = 5;

/**
 * `ffprobe -show_frames` の出力から、**最初にデコードできたコマの時刻**を読む。
 *
 * 先頭のほうは参照先が録れていないコマが混ざるので、ffprobe も ffmpeg も
 * 最初の I フレームまで捨てる。ここで返るのは捨て終わったあとの 1 コマ目。
 * 1 件も無ければ NaN (呼ぶ側がパケットの時刻で代用する)
 */
export function firstFrameTime(output: string): number {
  for (const line of output.split("\n")) {
    const match = /^best_effort_timestamp_time=(-?[\d.]+)/.exec(line.trim());
    if (match !== null) {
      const at = Number(match[1]);
      if (Number.isFinite(at)) return at;
    }
  }
  return NaN;
}

export function leadIn(streamStart: number, formatStart: number): number {
  if (!Number.isFinite(streamStart)) return 0;
  const from = Number.isFinite(formatStart) ? formatStart : 0;
  const lead = streamStart - from;
  return lead > 0 && lead <= MAX_LEAD_IN ? lead : 0;
}

/** `4:3` のような比を数にする。読めなければ 1 */
export function parseRatio(value: string | undefined): number {
  const match = /^(\d+)[:/](\d+)$/.exec((value ?? "").trim());
  if (match === null) return 1;
  const [, a, b] = match;
  const ratio = Number(a) / Number(b);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export interface CmDetection {
  cm: Range[];
  duration: number;
  note: string;
  /** 決めた材料。控えに残す (`cm-material-store.saveMaterial`)。読み方が欠けていたときは無い */
  material?: CmMaterial;
}

interface CmOptions {
  signal?: AbortSignal;
  /** 局の ID。覚えたロゴの置き場を局ごとに分けるのに使う */
  serviceId: number;
  /** 番組の尺 (秒。番組表)。録画の先頭と末尾に入った前後の番組を見分けるのに使う */
  programLength?: number;
  /** 番組表どおりなら番組が始まる秒 (録画の前のマージン。入れ物の先頭から) */
  programStart?: number;
  /** いま何をしているか。段階の名前だけでは進み具合が分からない */
  onStep?: (label: string) => void;
}

/** 決めた区間と尺を `by` 秒あとへずらす (入れ物の先頭からの秒に直す)。材料にはずらした長さを `offset` に残す */
export function shiftDetection(
  detection: CmDetection,
  by: number,
): CmDetection {
  return {
    ...detection,
    ...(detection.material !== undefined
      ? { material: { ...detection.material, offset: by } }
      : {}),
    cm: detection.cm.map((range) => ({
      start: range.start + by,
      end: range.end + by,
    })),
    duration: detection.duration + by,
  };
}

/** 読み方 (`openCm`) と、読んだ材料からの決め方 */
export interface CmReading {
  /**
   * 1 回のデコードで何を読むか。エンコードの ffmpeg に `cm-scan.scanReader` の出口を足す。
   * **デコードするたびに呼ぶ。** ロゴの点は読むたびに一から数える (再エンコードで途中までを持ち越さない)
   */
  want(): ScanWant;
  /** 入れ物の尺 (秒。ffprobe)。測れなければ NaN */
  duration: number;
  /**
   * 読み終えた材料から CM を決める。
   *
   * 材料の時刻は**先頭を `skip` 秒捨てた ffmpeg の時刻** (エンコードの `-ss` と同じだけ。`before` はその引数)。
   * 返す区間も同じ物差しで、**エンコードしたものの時刻**になる。ロゴを覚え直したときは、枠だけ同じ捨て方で読み直す。
   * `video` が偽なら映像は読めていない (音だけ読み直した) ので、尺だけで決める
   */
  decide(
    found: Scan,
    at: { skip: number; before: string[]; video?: boolean },
  ): Promise<CmDetection>;
}

/**
 * CM 検出の支度。尺と映像の大きさを測り、ロゴを開く (覚えていなければこの録画から覚える。
 * キーフレームだけ読むので速い)。**覚えられなくても続ける。** 無音と切れ目だけで決め直せる
 */
export async function openCm(
  input: string,
  options: CmOptions,
): Promise<CmReading> {
  const { signal, serviceId } = options;
  const step = options.onStep ?? (() => {});
  const probed = await probeVideo(input);
  const { duration: measured } = probed;
  // フレームレートはロゴの区間をならす窓の幅に使う
  const fps = Number.isFinite(probed.fps) ? probed.fps : config.cmFallbackFps;
  // 映像の無い録画 (ラジオ。尺は測れて大きさが無い) は音だけ読む。映像の出口を足すと ffmpeg ごと落ちる
  const video = !(Number.isNaN(probed.width) && Number.isFinite(measured));
  /** 支度で分かった、ロゴが使えない理由 (`decide` が尺だけで決めたときの覚え書きに足す) */
  let opening = video ? "" : "映像がありません";

  let logo: Exclude<Awaited<ReturnType<typeof openLogo>>, string> | null = null;
  if (video) {
    step("局ロゴを確かめています");
    const opened =
      probed.width > 0 && probed.height > 0
        ? await openLogo(input, probed, {
            repo: logoRepo(serviceId),
            signal,
            timeoutMs: config.cmDetectTimeout,
          })
        : "映像の大きさを読み取れませんでした";
    if (typeof opened === "string") opening = `ロゴ判定に失敗: ${opened}`;
    else logo = opened;
  }

  return {
    want: () => ({ video, logo: logo?.scan() ?? null, audio: true }),
    duration: measured,
    async decide(found, { skip, before, video: read = true }) {
      /** ロゴが使えなかった理由。呼ぶたびに支度のときの理由から始める */
      let why = opening;
      /*
       * 尺が ffprobe で測れなかったら、ffmpeg が出力した尺 (入れ物の尺)、
       * それも無ければ読めた最後のコマで代える。捨てた先頭のぶんは引く
       */
      const container = Number.isFinite(measured) ? measured : found.duration;
      const duration = Number.isFinite(container)
        ? container - skip
        : (found.times.at(-1) ?? Number.NaN);
      if (!Number.isFinite(duration) || duration <= 0)
        return {
          cm: [],
          duration: Number.NaN,
          note: "長さを読み取れませんでした",
        };

      // ロゴの枠とコマの時刻は順番で突き合わせる。数が合わなければ読み落としがあるので使わない
      let current = logo;
      // 映像の読み込みが落ちて音だけ読み直したなら、尺だけで決める (`encoder.ts`)
      if (!read) {
        why = "映像の読み込みに失敗しました";
        current = null;
      }
      if (current && found.logoFrames !== found.times.length) {
        why = `ロゴの枠の数 (${found.logoFrames}) とコマの数 (${found.times.length}) が合いません`;
        current = null;
      }

      // ロゴの区間を出す (覚えていたものが当たらなければ、覚え直して枠だけ読み直す)
      let lit: CmMaterial["logo"] = null;
      let logoModel: string | undefined;
      if (current) {
        step("本編と CM に分けています");
        const result = await current.finish(
          fps,
          async (again) =>
            (
              await scan(input, {
                signal,
                timeoutMs: config.cmDetectTimeout,
                video: true,
                audio: false,
                logo: again,
                before,
              })
            ).code,
        );
        if (result.code === 0) {
          console.log(`[cm] ロゴ判定: ${result.note}`);
          /*
           * **覚えたものを、同じ映像を流している局にも配る** (`logo-data.share`)。
           * サブチャンネルの枠で録れた番組が一から覚え直さないように
           */
          if (result.learned !== null)
            share(serviceId, result.learned.file, result.learned.again);
          lit = { spans: result.spans, scores: result.scores };
          logoModel = result.model;
        } else {
          why = `ロゴ判定に失敗: ${result.note}`;
        }
      }

      const material: CmMaterial = {
        offset: 0,
        duration,
        fps,
        programLength: options.programLength,
        programStart:
          options.programStart !== undefined
            ? options.programStart - skip
            : undefined,
        silences: found.silences,
        times: Float64Array.from(found.times),
        cuts: Float32Array.from(found.cuts),
        logo: lit,
        logoModel,
        why,
      };
      /*
       * 控えに残すのは映像まで読めたときだけ。音だけ読み直したもの・ロゴの枠が欠けたものは、
       * やり直すときに読み直したほうがよい
       */
      const keep =
        read && found.times.length > 0 && (logo === null || current !== null);
      return { ...decideFromMaterial(material), ...(keep ? { material } : {}) };
    },
  };
}

/** 並びの中央値。空なら NaN */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

/**
 * **ロゴで決めた結果を捨てたときに、ロゴがどう判定されていたかを覚え書きの後ろに足す。**
 * サーバのログは pod を入れ替えると消え、元の TS も残らないことがあるので、ロゴを見落としたのか
 * (本編なのに点が低い)、決め方がずれたのかを、覚え書きと録画の映像を突き合わせて分けられるようにする。
 *
 * - 当てた型の在り処と大きさ、ロゴが写っていたと判定したコマの割合
 * - 点の分布 (出たとみなす `ON` 以上、消えたとみなす `OFF` 未満、その間)
 * - ロゴで CM とした区間と、区間の中の点の中央値。本編なのに CM とした区間で点が `OFF` の近くまであれば、
 *   ロゴは写っていたが届かなかった。0 近くなら、型がその番組のロゴと合っていない
 *
 * 時刻は材料の物差し (エンコードした動画の時刻との差は 1 秒未満)
 */
export function logoDetail(material: CmMaterial, cm: Range[]): string {
  const { logo, times } = material;
  if (logo === null) return "";
  const { scores, spans } = logo;
  const frames = scores.length;
  const percent = (count: number) =>
    `${Math.round((count / Math.max(1, frames)) * 100)}%`;
  const lit = spans.reduce((sum, span) => sum + span.end - span.start + 1, 0);
  let high = 0;
  let low = 0;
  for (const value of scores) {
    if (value >= ON) high++;
    else if (value < OFF) low++;
  }
  const model =
    material.logoModel !== undefined && material.logoModel !== ""
      ? `${material.logoModel}、`
      : "";
  const ranges = cm.map((range) => {
    const inside: number[] = [];
    for (let i = 0; i < Math.min(frames, times.length); i++)
      if (times[i]! >= range.start && times[i]! < range.end)
        inside.push(scores[i]!);
    const middle = median(inside);
    const point = Number.isNaN(middle) ? "" : ` (点 ${middle.toFixed(2)})`;
    return `${clock(range.start)}〜${clock(range.end)}${point}`;
  });
  const between = frames - high - low;
  const parts = [
    `ロゴ: ${model}写っていたコマ ${percent(lit)}`,
    `ロゴの点: ${ON} 以上 ${percent(high)}、${OFF}〜${ON} ${percent(between)}、${OFF} 未満 ${percent(low)}`,
  ];
  if (ranges.length > 0)
    parts.push(`ロゴで CM とした区間: ${ranges.join("、")}`);
  return `。${parts.join("。")}`;
}

/**
 * 材料から CM を決める (読み直さない)。**ロゴで決め、使えなければ同じ材料から CM の尺だけで決め直す。**
 * 返す区間と尺は材料の物差し (`offset` は足さない)
 */
export function decideFromMaterial(material: CmMaterial): CmDetection {
  const { duration, times } = material;
  const at = (frame: number) =>
    frame < times.length ? times[frame]! : duration;
  const input = {
    duration,
    silences: material.silences,
    times,
    cuts: material.cuts,
    ...(material.programLength !== undefined
      ? { programLength: material.programLength }
      : {}),
    ...(material.programStart !== undefined
      ? { programStart: material.programStart }
      : {}),
  };
  let why = material.why;
  /** 映像の欠けた所。CM の割合に入れない (`cmShare`) */
  const missing = missingVideo(times, duration);
  /** ロゴで決めた結果を捨てたときに、覚え書きの後ろへ足すもの (`logoDetail`) */
  let detail = "";
  if (material.logo !== null) {
    const cm = decideCm({
      ...input,
      logo: material.logo.spans.map((s) => ({
        start: at(s.start),
        end: at(s.end + 1),
      })),
      logoScores: material.logo.scores,
    });
    if (cm.length === 0) why = "ロゴの消えている所がありませんでした";
    // 番組の半分以上が CM になったら、その結果は捨てて尺だけで決め直す (tooMuchCm)
    else if (tooMuchCm(cm, duration, missing))
      why = `番組の ${cmRatio(cm, duration, missing)}% が CM と判定されたため、この結果は使いません`;
    else return { cm, duration, note: LOGO_OK };
    detail = logoDetail(material, cm);
  }

  // ロゴを使わずに、CM の尺 (15 秒の倍数) だけで決める
  const cm = decideCm(input);
  // 落ちた理由まで書く。**この文言から「ロゴで判定できなかった」と画面に出すかを決める** (format.logoUnusable)
  return {
    cm: tooMuchCm(cm, duration, missing) ? [] : cm,
    duration,
    note: `無音 ${material.silences.length} 箇所 (${LOGO_UNUSABLE}: ${why})${detail}`,
  };
}
