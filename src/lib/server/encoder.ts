import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";

import {
  CAPTION_TEXT_VERSION,
  type CaptionPages,
} from "@danything/arib/caption-text";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import { audioChannels, audioTitles, DUAL_MONO } from "#lib/arib.js";

import {
  CODEC_LABEL,
  HW_CODECS,
  HW_KIND_LABEL,
  type HwCodec,
  SOFTWARE_CODECS,
} from "../hw";
import { encodeSource, recordedTransport, tsPathOf } from "../source";
import {
  type EncodeKind,
  type EncodePhase,
  type Recording,
  undecodableReason,
} from "../types";
import { fileSize } from "./chase";
import {
  chapterArgs,
  chapterMetadata,
  type CmDetection,
  type CmReading,
  decideFromMaterial,
  invertRanges,
  openCm,
  probeLeadIn,
  probeLiveAudio,
  probeVideo,
  shiftDetection,
  shiftRanges,
} from "./cm";
import { loadMaterial, saveMaterial } from "./cm-material-store";
import { type Scan, scan, type ScanReader, scanReader } from "./cm-scan";
import { config } from "./config";
import { noteDecoded, noteStillScrambled } from "./contracts";
import { affected, now, orm } from "./db";
import { slotPool } from "./encode-slots";
import { type ChaptersChanged, emit, type EncodeProgress } from "./events";
import { usedByOther } from "./files";
import {
  FPS_POINTS,
  FPS_WINDOW,
  fpsArgs,
  type FpsWindow,
  judgeWindow,
  pickSmooth,
  UNMEASURED,
  windowLabel,
} from "./fps";
import { pruneEmptyDirs, removeIfExists } from "./fsx";
import { hwArgs, hwChain, hwReady, type HwWay } from "./hwenc";
import {
  encodedFiles,
  encodedPath,
  encodedPaths,
  libraryFamily,
  libraryPath,
} from "./library";
import {
  removeSidecars,
  sidecarPaths,
  thumbnailPlace,
  writeThumbnail,
} from "./metadata";
import { remuxMmts } from "./mmts";
import { saveRecordedBml } from "./recorded-bml";
import { recordedBroadcast } from "./recorded-broadcast";
import { recordingSummary, tsHeadOf } from "./recording";
import { recordingInput } from "./recording-io";
import { encodeJobs, programs, recordings, services } from "./schema";
import { descramble, isDecoded, isScrambled } from "./scramble";
import { settings } from "./settings";
import { chunks, lines, lowerPriority, run, sideOutput } from "./stream";
import { displayTitle } from "./title";
import { tsProbe } from "./ts-probe";
import { HLG_PARAMS, HLG_TO_SDR, UHD_HEIGHT } from "./uhd";
import { saveVideoLoss } from "./video-loss";
import { notify } from "./webhook";

/**
 * インタレ解除の出し方。
 *
 * `bwdif` の既定は `send_field` で、**1 フィールドから 1 コマ作って 59.94p にする**。
 * 放送は 1080i (毎秒 60 フィールド) なので、実写・スポーツ・報道はこれで
 * 撮られたとおりの動きになる。コマ数が倍なのでエンコードの時間もサイズも
 * およそ倍になる (実測・地上波 1 分・AV1: 31.8 秒 26MB ↔ 16.9 秒 15MB)。
 *
 * **24p 系 (アニメ・フィルム) と 30p は倍にしない** (`smooth` が false。見分け方は `fps.ts`)。
 * 24p 系はプルダウンして 60 フィールドに入れているだけ、30p は上下が同じ時刻のコマなので、
 * フィールドごとにコマを作っても同じ画像が並ぶだけになる。滑らかさは少しも増えず、時間とサイズだけ倍になる。
 *
 * **インタレのコマだけを解除する** (`deint=interlaced`)。既定 (`all`) はプログレッシブのコマにも同じことをするので、
 * 720p (59.94p) の局を通すとコマ数が倍の 119.88p になっていた (本番の ffmpeg で 3 秒 180 コマが 360 コマ)。
 * 1080i はインタレの印が付いたコマなので、今までどおり解除する (確かめたのは ffmpeg で作った 1080i。実放送では確かめていない)
 */
export function deinterlace(smooth: boolean): string {
  return smooth
    ? "bwdif=deint=interlaced"
    : "bwdif=mode=send_frame:deint=interlaced";
}

/** 1 窓ぶん測る。ffmpeg が失敗したら「測れない」 */
async function measureWindow(
  input: string,
  at: number,
  signal: AbortSignal,
): Promise<FpsWindow> {
  const diffs: string[] = [];
  const result = await run([config.ffmpeg, ...fpsArgs(input, at)], {
    signal,
    // 録ったあとのエンコードの一部。ライブに CPU を譲る (stream.lowerPriority)
    lowPriority: true,
    // 1 コマ 2 行ずつ出るので、差の行だけ溜める
    onStderrLine: (line) => {
      if (line.includes("YDIF=")) diffs.push(line);
    },
  });
  return result.code === 0 ? judgeWindow(diffs) : UNMEASURED;
}

/**
 * 30 コマか 60 コマかを、録画から 5 窓測って決める。見分け方は `fps.ts`、実測の表と idet (縞の検出) が
 * 使えなかった話は [docs/encode.md](../../../docs/encode.md) に。
 *
 * **窓は録画全体に散らす。** CM はエンコードしながら探すので測る時点では分からないが、
 * 散らせば CM に重なるのは 5 窓のうち多くて 2 つで、多数決は動かない (CM はフィルム撮りも多い)。
 * 冒頭に固めると、アバン+OP の激しい動きに引きずられる
 */
async function measureSmoothMotion(
  source: string,
  durationSec: number,
  signal: AbortSignal,
): Promise<boolean> {
  const end =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : FPS_WINDOW;
  const span = Math.max(0, end - FPS_WINDOW);

  // 尺が窓より短いと 5 点が同じ位置に重なる。同じ 30 秒を測り直さない
  const offsets = [...new Set(FPS_POINTS.map((point) => span * point))];
  const windows: FpsWindow[] = [];
  for (const at of offsets) {
    if (signal.aborted) break;
    windows.push(await measureWindow(source, at, signal));
  }
  const smooth = pickSmooth(windows.map((w) => w.kind));
  // 窓ごとの値も出す。閾値 (fps.ts) を詰め直すときの材料
  console.log(
    `[fps] フィールドの実測: ${windows.map(windowLabel).join(" / ")} → ${smooth ? "60" : "30"} コマ`,
  );
  return smooth;
}

/**
 * **画素を正方形に直す。**
 *
 * 地上波の HD は 1440x1080 で送られてきて、画素が横長 (SAR 4:3) であることを
 * 別に添えて 16:9 に見せている。ffmpeg はその添え書きをそのまま写すので、
 * 引き伸ばさなければ出来上がりも 1440x1080 + SAR 4:3 になる。
 *
 * **1440x1080 のままにはしない。** 実測は docs/encode.md「地上波の HD は 1920x1080 に引き伸ばす」。
 *
 * - AV1 は映像の中に画素の縦横比を書く場所が無く、SAR は Matroska の DisplayWidth・DisplayHeight にしか残らない。
 *   ffmpeg はここに縦横比 (16 と 9) を書き、Firefox は AV1 のときそれを画素の数として読んで `videoWidth` を 16x9 と返す。
 *   映すのは 16:9 のまま。`videoWidth` で大きさを決める切り抜きの 1 コマが 16x9 の画素になる
 * - 画質 (XPSNR) を揃えて比べると、AV1 は大きさが変わらない (97〜103%)。H.264 は crf を 23 から 22.5 に下げて 88〜91% になる
 *
 * **大きさはこちらで測って渡す** (`probeVideo` の width と sar)。
 * `scale=trunc(iw*sar/2)*2` のように ffmpeg の式で書くと、SAR が読めない
 * 素材で `sar` が 0 になり、幅 0 で落ちる。数で渡せばその目はない
 */
function squarePixels(
  size: { width: number; height: number } | undefined,
): string | null {
  if (size === undefined) return null;
  return `scale=${size.width}:${size.height},setsar=1`;
}

/** 画面に出す、エンコードの経路の名前。`renderD128 の VA-API` / `ソフトウェア` */
function wayName(way: HwWay | undefined): string {
  return way === undefined
    ? "ソフトウェア"
    : `${basename(way.device)} の ${HW_KIND_LABEL[way.kind]}`;
}

/**
 * エンコードするコーデックの並び。**先頭 (1 本目) が CM を一緒に探す。** 選んだもの (AV1 → H.265 → H.264 の順。
 * `settings.parseCodecs`) のまま、H.265 をエンコードできる GPU が無ければ H.265 は外す (ソフトウェアのエンコーダを組んでいない)
 */
export function encodeOrder(
  chosen: readonly HwCodec[],
  hevcReady: boolean,
): HwCodec[] {
  return chosen.filter((codec) => codec !== "hevc" || hevcReady);
}

/** GPU のデバイスを回す番。1 本エンコードするごとに先頭のデバイスを入れ替える (hwenc.hwChain) */
let hwTurn = 0;

function videoArgs(
  codec: HwCodec,
  smooth: boolean,
  scale: string | null,
  hardware: HwWay | null,
  height = Number.NaN,
  uhd = false,
): { filter: string; encoder: string[]; device: string[] } {
  /*
   * **4K の局 (`uhd`) はインタレ解除も引き伸ばしもしない** (プログレッシブで、画素は正方形)。
   * AV1 は 2160p・10 ビット・HLG のまま出す (`HLG_PARAMS` でコマに色を書き込む)。H.264・H.265 は今の録画と同じ 1080p・8 ビットの SDR に縮めて直す
   * (`HLG_TO_SDR`。ライブの `uhdVideoArgs` と同じ)。理由は docs/encode.md「4K の局の録画」
   */
  const hdr = uhd && codec === "av1";
  const steps = uhd
    ? hdr
      ? [HLG_PARAMS]
      : [`scale=-2:${UHD_HEIGHT}`, ...HLG_TO_SDR]
    : [deinterlace(smooth), ...(scale === null ? [] : [scale])];
  if (hardware !== null) {
    /*
     * **GPU (VA-API・NVENC・QSV・AMF・VideoToolbox・Rockchip MPP)。** インタレ解除も引き伸ばしも CPU のフィルタで
     * 済ませ、エンコードするところだけ GPU に渡す。引数と画質の決め方は hwenc.hwArgs
     * (Rockchip MPP・NVENC・AMF・VideoToolbox は出す高さとコマ数でビットレートを決める)。
     * 使うかどうかは `hwChain` (起動時の試しのエンコードと設定)。**落ちたら次の方式か
     * ソフトウェアで再エンコードする** (runJob) ので、ここで保険はかけない
     */
    const hw = hwArgs(hardware, codec, {
      height: uhd ? UHD_HEIGHT : height,
      smooth,
    });
    return {
      filter: [...steps, ...hw.filter].join(","),
      encoder: hw.encoder,
      device: hw.device,
    };
  }
  /*
   * H.264 の crf 23 は AV1 の前の設定 (preset 9・crf 35) と同じ画質に揃えた値、medium は slow に
   * しても時間が増えるだけ。実測の表は docs/encode.md「H.264 は crf 23」
   *
   * AV1 は **preset と crf を書いておく**。SVT-AV1 の既定はバージョンで変わる (preset は
   * 2.3.0 が 10、4.2.0 が 8)。エンコードする速さと大きさは denpa が決める。
   *
   * **preset 8・crf 37** は前の preset 9・crf 35 とほぼ同じ大きさ (97%) で XPSNR が 0.26〜0.42 dB
   * 上がる。増えるのはエンコードの時間で 1.6 倍。
   *
   * **10 に戻さない。** 4.x の M10 以上は「機械にかけるための段」で、エンコードするたびに
   * visual artifacts が出ると警告される。実際に出るのは**シーンの変わり目の
   * ブロックノイズ**で、カット直後だけ大きく崩れる (最低 29.74dB → 9 なら 37.77dB)。
   * 実測は docs/encode.md「preset は 8・crf 37 (値は書いておく)」
   *
   * **8bit で出す** (10bit は 2% 小さいだけで 15% 遅く、Main10 をデコードできる相手が要る)。
   * 実測は docs/encode.md「10bit では出しません」
   *
   * **H.265 はソフトウェアでエンコードしない** (libx265 を組んでいない。GPU が全部落ちたら、その 1 本は失敗にする。
   * `runJob` の `encodeWays`)。ここに来るのは呼ぶ側の誤りなので、黙って別のコーデックにせず投げる
   */
  if (codec === "hevc")
    throw new Error("H.265 はソフトウェアではエンコードしません");
  return {
    filter: [...steps, hdr ? "format=yuv420p10le" : "format=yuv420p"].join(","),
    device: [],
    encoder:
      codec === "h264"
        ? ["libx264", "-preset", "medium", "-crf", "23"]
        : ["libsvtav1", "-preset", "8", "-crf", "37"],
  };
}

/** 進捗を DB に書き戻す間隔。1 フレームごとに書くと WAL が膨らみ、画面がちらつく */
const PROGRESS_INTERVAL = 2000;

/** 走っているジョブの ID。ffmpeg の起動前から入る */
const runningJobs = new Set<number>();
/**
 * 同時に走らせるエンコードの枠。**数えるのは ffmpeg の本数** (コーデックをいくつも選んだ録画は、コーデックごとに
 * 1 本ずつ同時に動く)。決め方は `encode-slots.ts`
 */
const slots = slotPool(
  () => config.encodeConcurrency,
  () => pump(),
);
/** kill 用。ffmpeg が起動している間だけ入る。コーデックごとに同時に走るので、ジョブごとに何本か */
const procs = new Map<number, Set<Bun.Subprocess>>();
/**
 * 中止の合図。ジョブが走っている間ずっとある。
 *
 * ffmpeg を kill するだけでは足りない。スクランブルの復号は向こうの
 * コンテナへの HTTP、ロゴを覚える・CM 検出だけやり直すときは別の ffmpeg で、どれも数十分かかることがある。
 * 「中止を押したのに何も起きない」を無くすため、段階ごとにこれを渡す
 */
const aborts = new Map<number, AbortController>();
/** ユーザーが止めたジョブ。失敗と区別して再試行しないため */
const canceled = new Set<number>();

interface EncodeOptions {
  /**
   * CM 検出の材料を取る出力 (`cm-scan.scanReader` の `outputs`)。エンコードする出力のあとに足して、**同じデコードから**
   * 読ませる。ロゴの枠は標準出力に来るので、進み具合は fd 3 で受ける (`-progress pipe:3`)
   */
  analysis?: string[];
  /**
   * 録画の先頭から本編が始まるまで (秒)。**探りをこれだけ延ばす** (`ts-probe.tsProbe`)。前の番組に字幕が無いと、
   * 本編の字幕は番組が変わってから現れるため (#2189)
   */
  probeLead?: number;
  /** 進み具合を書き出す先 (`stream.sideOutput` の `url`)。無ければ `pipe:3` */
  progress?: string;
  /**
   * 音声の何本目 (`0:a:<n>`) を何チャンネルで出すか。**番組表の構成で決める** (`arib.audioChannels`)。
   * ffmpeg は先頭の音声でエンコーダを開くので、前の番組がモノラルだと本編のステレオも 1 チャンネルになる (#2189)
   */
  audioChannels?: (number | undefined)[];
  /** 60 コマ/秒で出す。滑らかになる代わりに時間もサイズも約 2 倍 (measureSmoothMotion で決める) */
  smoothMotion?: boolean;
  /**
   * 映像が出るまでの音声だけの区間 (秒)。**先頭から捨てる長さ** (`probeLeadIn`)。
   *
   * 捨てると映像・音声・字幕が同じ瞬間から始まるので、時刻を読むプレイヤーでも
   * 1 コマ目から数えるプレイヤーでも同じ映像になる。捨てるのは映像がまだ無い
   * ところなので、見えるものは減らない
   */
  videoStart?: number;
  /**
   * 正方形の画素で出したときの大きさ。**渡されたときだけ引き伸ばす。**
   * 1440x1080 (SAR 4:3) なら 1920x1080。もともと正方形の素材では渡さない
   */
  displaySize?: { width: number; height: number };
  /**
   * 映像の高さ (`probeVideo`。引き伸ばすのは横だけなので、出すものも同じ高さ)。
   * Rockchip MPP・NVENC・AMF・VideoToolbox のビットレートを決めるのに使う (`hwenc.hwBitrate`)。測れなければ 1080 の値
   */
  height?: number;
  /** 音声トラックの名前。**番組表と同じ言い方** (`arib.audioTitles`) */
  audioTitles?: string[];
  /**
   * 使う音声 (音声の何本目か。`cm.probeLiveAudio`)。**冒頭に中身の無い音声を外すため。**
   * 無い・空なら全部使う。デュアルモノでは使わない (1 本を左右に割るだけ)
   */
  audioStreams?: number[];
  /** 入れ物 (mkv) の title に埋め込む番組名 (`title.displayTitle`) */
  mediaTitle?: string;
  /**
   * GPU でエンコードする経路 (どのデバイスを `vaapi` / `rkmpp` / `nvenc` / `qsv` / `amf` / `videotoolbox` のどれで)。使えるかどうかは
   * `hwenc.hwChain` が決めていて、runJob がその順に渡す。落ちたら次、
   * 最後はソフトウェア (undefined)
   */
  hardware?: HwWay | undefined;
  /**
   * エンコードする前に測った入力の尺と毎秒コマ数 (`probeVideo`)。
   * **進み具合の分母**をここから出す (`expectedFrames`)。
   * 測れなければ入力の読み位置に落ちるだけで、エンコードしたものには影響しない
   */
  probed?: { duration: number; fps: number };
  /**
   * 4K の局の録画か (`.mmts` を詰め替えた MP4 か、TS で送る 4K の局の TS が入力。`encodeInput`)。インタレ解除と引き伸ばしをせず、
   * AV1 は HLG のまま、H.264・H.265 は 1080p の SDR に直す (`videoArgs`)
   */
  uhd?: boolean;
}

/** これ以下は捨てない。1 コマにも満たないずれのために seek を掛けても得るものが無い */
const MIN_SKIP = 0.05;

/**
 * 先頭から捨てる長さ。**エンコードするほうと CM 検出のやり直し (`detectCm`。`encode_skip` の無い古い録画) で同じ値を使う。**
 *
 * ここが食い違うと、捨てたぶんだけチャプターがずれる。片方だけ「短いから捨てない」と
 * 判断することがないよう、判断そのものをここ 1 か所に置く
 */
export function headSkip(videoStart: number | undefined): number {
  const start = videoStart ?? 0;
  return Number.isFinite(start) && start > MIN_SKIP ? start : 0;
}

/**
 * `-ss` に渡す長さ。**エンコードするほうと進み具合の分母で同じ値を使う。**
 *
 * 2 つの理由が足し算になる (内訳は buildArgs のコメント)。ここが食い違うと、
 * 捨てた量と分母から引いた量がずれて、進み具合が最後まで届かない (または
 * 先に振り切れる)。片方だけ変えられないよう、足し算そのものをここ 1 か所に置く
 */
export function inputSkip(
  seek: number | null,
  videoStart: number | undefined,
): number {
  return (seek ?? 0) + headSkip(videoStart);
}

/**
 * **字幕トラックの入れ方。字幕はここ 1 か所で決める。**
 *
 * 放送の ARIB 字幕を**そのまま写す** (`-c:s copy`。Matroska では `S_ARIBSUB`、CodecPrivate は ffmpeg が書く)。
 * 観る画面はこれをサーバでデコードして文字の配置で描く (`api/recordings/<id>/captions.json`)。
 *
 * **字幕のストリームを名指しする** (`0:s:0`)。名指ししない既定の選び方では ARIB の字幕が落ちる。? は字幕の無い番組でも止めないため。
 * 局 (`0:p:<局>`) では名指ししない。録画の TS は 1 局に絞ってあり、前の番組から録ると、番組が変わってから現れた字幕を
 * ffmpeg が局の外に並べ、局の名指しに当たらず落ちる (#2189)。
 * 時刻は映像と同じだけ詰まる (先頭を捨てる `-ss` はストリームごとに同じ)
 */
function captionArgs(): string[] {
  return [
    "-map",
    "0:s:0?",
    "-c:s",
    "copy",
    "-metadata:s:s:0",
    "title=字幕",
    /*
     * 言語も付ける。default の印だけだと、プレイヤーの字幕自動選択
     * (「端末の言語に合う字幕を出す」設定) が言語不明のトラックを飛ばすことがある。
     * 写すのは最初の字幕 (s:0) だけで、国内の放送ではそれが日本語
     */
    "-metadata:s:s:0",
    "language=jpn",
    "-disposition:s:0",
    "default",
  ];
}

/**
 * ffmpeg の引数。字幕は埋め込まず、放送の ARIB 字幕をそのまま写す (`captionArgs`)。
 *
 * CM 検出の材料は同じ ffmpeg に取らせる (`analysis`)。
 */
export function buildArgs(
  input: string,
  output: string,
  audioType: number | null,
  seek: number | null,
  codec: HwCodec = "av1",
  options: EncodeOptions = {},
): string[] {
  const hardware = options.hardware ?? null;
  const video = videoArgs(
    codec,
    options.smoothMotion === true,
    squarePixels(options.displaySize),
    hardware,
    options.height,
    options.uhd === true,
  );

  const args = ["-y"];
  // GPU のデバイス。入力より前に開いておくと、エンコーダ (とフィルタ) がこれを使う
  args.push(...video.device);

  /*
   * **先頭を捨てる。** 2 つの理由が足し算になる。
   *
   * - `videoStart` … 映像が出るまでの音声だけの区間 (実機で 0.930 秒)。
   *   ここを残すと、1 コマ目を 0 秒として数えるプレイヤーで字幕がそのぶん早く出る。
   *   **ずらす (`-output_ts_offset`) のでは直らない**。Matroska は負の時刻を
   *   持てないので muxer が全トラックまとめて押し戻す (実測: 0.363 渡して
   *   動いたのは 0.022 だけ)。捨てれば映像も音声も 0.000 から始まる
   * - `seek` … 録画開始直後の 1 秒未満だけ、多重化されたもう一方の映像ストリームの
   *   PAT/PMT が確定しておらず、エンコーダの初期化 (fps/解像度確定) 自体が
   *   失敗することがある。最初の失敗を検知した後だけ渡す
   *   (常時捨てると本編側が削れるため)
   *
   * 字幕は同じ入力から写すので、映像と同じだけ詰まる。
   */
  args.push(
    ...inputArgs(inputSkip(seek, options.videoStart), options.probeLead ?? 0),
  );
  args.push(...recordingInput(input));
  /*
   * チャプター (CM の位置) はここでは入れない。境目はエンコードし終えてから決まるので、どのコーデックも
   * エンコードしたあとに `-c copy` で書き足す (`cm.chapterArgs`)
   */
  // map で解決できない (型が不明な) ストリームは黙ってスキップする。エンコード自体を止めないため
  args.push("-ignore_unknown");
  // 入れ物の title に番組名を入れる (プレイヤーの履歴・通知用)
  if (options.mediaTitle !== undefined && options.mediaTitle !== "") {
    args.push("-metadata", `title=${options.mediaTitle}`);
  }
  // インタレ解除 (bwdif は yadif よりコーミング残りが少ない)。
  // なめらかさの指定でコマ数が変わる (videoArgs)
  args.push("-vf", video.filter);
  // 映像のストリーム (? はラジオ相当の映像の無い録画でも失敗しないようにするため)
  args.push("-map", "0:v?", "-c:v", ...video.encoder);

  if (audioType === DUAL_MONO) {
    // 副音声は二か国語放送 (外国語) と解説放送 (日本語の音声ガイド) があり判別できないため、言語は und にする。
    // channelsplit の出力は FL/FR という位置情報付きの 1ch レイアウトのままだと libopus が受け付けないため、aformat で mono に付け替える
    args.push(
      "-filter_complex",
      "channelsplit[FL][FR];[FL]aformat=channel_layouts=mono[FLm];[FR]aformat=channel_layouts=mono[FRm]",
      "-map",
      "[FLm]",
      "-map",
      "[FRm]",
      "-metadata:s:a:0",
      "language=jpn",
      "-metadata:s:a:1",
      "language=und",
    );
  } else {
    // 音声ストリームを全て使う (多言語放送などで複数トラックある場合に備える)。
    // ただし冒頭に中身の無いもの (次の番組の副音声) は外す (`audioStreams`)
    const streams = options.audioStreams ?? [];
    if (streams.length === 0) args.push("-map", "0:a");
    for (const index of streams) args.push("-map", `0:a:${index}`);
    // チャンネル数は番組表の構成にそろえる (`audioChannels`)。出す何本目 (out) と、入力の何本目 (index) は `audioStreams` で対応する
    const channels = options.audioChannels ?? [];
    const inputs = streams.length === 0 ? channels.map((_, i) => i) : streams;
    inputs.forEach((index, out) => {
      const count = channels[index];
      if (count !== undefined) args.push(`-ac:a:${out}`, String(count));
    });
  }
  args.push("-c:a", "libopus", "-b:a", "256k"); // 元の放送 (AAC 256kbps) と同じビットレート

  // 字幕は**映像・音声のあと**に map する (= 最後のトラック)。映像が先頭でないと弱いデマルチプレクサがある
  args.push(...captionArgs());

  /*
   * **音声にも名前を付ける** (`arib.audioTitles`)。番組表と同じ言い方にするので、
   * 「主音声」「解説」がそのままプレイヤーの切り替えに出る。
   *
   * **多すぎても困らない。** 番組表が言っている本数と実際に入っている本数は
   * 食い違いうるが、ffmpeg は在りもしないトラックへの指定を黙って読み飛ばす
   * (実機で確認)。言語はデュアルモノのところで別に付けてある
   */
  (options.audioTitles ?? []).forEach((title, index) => {
    if (title === "") return;
    args.push(`-metadata:s:a:${index}`, `title=${title}`);
  });

  // トラックの default フラグを明示する (未設定だとプレイヤーが自動選択せず音声が出ないことがある。
  // 字幕は captionArgs で立てる)
  args.push("-disposition:v:0", "default", "-disposition:a:0", "default");

  /*
   * 進捗を key=value 形式で出力させる。stderr の人間向けログをパースするより確実。
   *
   * **出力は fd 3 (専用のパイプ)。** 標準出力は CM 検出のロゴの枠が使い (`analysis`)、標準エラーはログで
   * 混み合う (ログと進み具合は別のスレッドが書くので、同じ出力先では行が千切れることがある)。
   * 人間向けの進み具合の行 (`frame= …`) も止める
   */
  args.push("-nostats", "-progress", options.progress ?? "pipe:3");
  /*
   * 入れ物は名前ではなくここで決める。出力は書いている間だけ別名 (`<名前>.<jobId>.<codec>.encoding`) にしており、
   * ffmpeg は拡張子から入れ物を決めるので、付けないと
   * 「Unable to choose an output format」で始まる前に落ちる
   */
  args.push("-f", "matroska");
  args.push(output);
  // CM 検出の出力はエンコードする出力のあと。`-map` は出力ごとなので、エンコードするほうの指定は効かない
  if (options.analysis !== undefined) args.push(...options.analysis);

  return args;
}

/**
 * いま走っているエンコード (CM 検出のやり直しも) の本数。Windows と Mac をスリープさせないか (`power.ts`) と、
 * 通知領域・メニューバーのアプリが更新の前に確かめるとき (`/api/health`) に使う
 */
export function runningEncodes(): number {
  return runningJobs.size;
}

/** その録画で今生きているジョブ (待ち・実行中) の id。無ければ undefined */
export function activeEncodeJob(recordingId: number): number | undefined {
  return orm()
    .select({ id: encodeJobs.id })
    .from(encodeJobs)
    .where(
      and(
        eq(encodeJobs.recording_id, recordingId),
        inArray(encodeJobs.state, ["queued", "running"]),
      ),
    )
    .get()?.id;
}

/**
 * 待ち行列に入れる。**その録画に生きているジョブがあれば、それを返すだけ** (種類が違っても)。
 * エンコードしている最中に CM 検出のやり直しを重ねる (またはその逆) と、同じファイルを 2 つが書き換える
 */
export function enqueue(
  recordingId: number,
  kind: EncodeKind = "encode",
): number {
  const existing = activeEncodeJob(recordingId);
  if (existing !== undefined) return existing;

  return orm()
    .insert(encodeJobs)
    .values({
      recording_id: recordingId,
      kind,
      state: "queued",
      created_at: now(),
    })
    .returning({ id: encodeJobs.id })
    .get()!.id;
}

/**
 * 中止を指示したジョブが畳み終わるのを待っている呼び出し。
 * 畳み終わり (`pump` の finally) で呼ばれる
 */
const stopping = new Map<number, (() => void)[]>();

/**
 * 中止を待つ上限。**押した人を待たせすぎない。**
 *
 * ffmpeg は SIGTERM から 1 秒ほどで終わる (実測 923ms / 1078ms)。この待ちは
 * その 1 秒を待って**畳んだ結果を返す**ためのもので、間に合わなければ待つのをやめて
 * 返す。あとは畳み終わりの通知 (SSE) が追いつく
 */
const CANCEL_WAIT_MS = 5_000;

/** 畳み終わるまで待つ。上限を超えたら待つのをやめる (中止は続く) */
function settled(jobId: number): Promise<void> {
  if (!runningJobs.has(jobId)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      const waiting = (stopping.get(jobId) ?? []).filter((fn) => fn !== done);
      if (waiting.length === 0) stopping.delete(jobId);
      else stopping.set(jobId, waiting);
      resolve();
    };
    const timer = setTimeout(done, CANCEL_WAIT_MS);
    stopping.set(jobId, [...(stopping.get(jobId) ?? []), done]);
  });
}

/** 畳み終わったことを、待っている呼び出しに伝える */
function wakeStopping(jobId: number): void {
  for (const done of stopping.get(jobId) ?? []) done();
  stopping.delete(jobId);
}

/**
 * エンコードを中止する。**畳み終わってから返す。**
 *
 * 中止を伝えるだけで返すと、押した直後の読み直しは ffmpeg が終わる前に届き、画面が変わらない。
 * ffmpeg は SIGTERM から 1 秒ほどで終わるので、待ってから返せば押した人の画面は
 * その場で「録画済み」に変わる。**上限つき** (`CANCEL_WAIT_MS`) で、間に合わ
 * なければそのまま返す (あとは通知 (SSE) に任せる)
 */
export async function cancel(jobId: number): Promise<void> {
  canceled.add(jobId);
  // どの段階にいても止まるようにする。ffmpeg が回っていない段階もある
  aborts.get(jobId)?.abort();
  for (const proc of procs.get(jobId) ?? []) proc.kill();

  const stopped = orm()
    .update(encodeJobs)
    .set({ state: "canceled", finished_at: now() })
    .where(and(eq(encodeJobs.id, jobId), eq(encodeJobs.state, "queued")))
    .returning({ id: encodeJobs.id })
    .get();
  // まだ始まっていなければここで終わり。pump の finally を通らないので印もここで外す
  if (stopped !== undefined) {
    canceled.delete(jobId);
    emit("recordings");
    return;
  }
  // 待ってもいない・動いてもいない (終わったあとに押された)。印を残すと `isCanceling` が true のままになる
  if (!runningJobs.has(jobId)) {
    canceled.delete(jobId);
    return;
  }

  /*
   * 動いている分。**段階の名前を先に書き換えてから待つ**。上限に間に合わな
   * かったときでも、押した直後の読み直しが「中止しています」を読める
   * (割合を出している段階では出ないが、CM 検出のように数分かかる段階で効く)
   */
  writeStep(jobId, "中止しています");
  await settled(jobId);
}

/**
 * 中止を指示されて、まだ畳み終わっていないか。
 *
 * 一覧の行に添えて、中止のボタンを**畳み終わるまで回したままにする**ための
 * もの。押した返事 (`cancel`) は上限で切り上げることがあるので、返事だけで
 * ボタンを戻すと「回るのが止まったのにまだエンコード中」になる
 */
export function isCanceling(jobId: number): boolean {
  return canceled.has(jobId);
}

/** 段階を進めて画面にも伝える。押しても反応が無いように見えるのを防ぐ */
function setPhase(jobId: number, phase: EncodePhase, log: string): void {
  // 中止を指示された後は「中止しています」を残す (下の setStep と同じ)
  if (canceled.has(jobId)) return;
  orm()
    .update(encodeJobs)
    .set({ phase, log, percent: 0, eta_ms: null })
    .where(eq(encodeJobs.id, jobId))
    .run();
  emit("recordings");
}

/**
 * 段階の中で「いま何をしているか」だけ書き換える。
 *
 * 段階の名前 (「CM 検出中」) だけでは、進んでいるのか止まっているのかが分からない。
 *
 * **中止を指示された後は書き換えない**。`cancel` が書いた「中止しています」を、
 * 畳むまでの間に通る段階が上書きしないように
 */
function setStep(jobId: number, log: string): void {
  if (canceled.has(jobId)) return;
  writeStep(jobId, log);
}

function writeStep(jobId: number, log: string): void {
  orm().update(encodeJobs).set({ log }).where(eq(encodeJobs.id, jobId)).run();
  emit("recordings");
}

interface Progress {
  percent: number;
  /** 残り時間の見込み (ms)。速さが読めないうちは null */
  etaMs: number | null;
  log: string;
}

/** 残り時間を測る窓。直近の進み方だけ見る (速度は素材や場面で途中から変わる) */
const ETA_WINDOW_MS = 30_000;
/** これより短い窓からは速度を出さない。起動直後の数点だけで暴れた値を出さないため */
const ETA_MIN_SPAN_MS = 4_000;

/**
 * エンコード後のコマ数。進み具合の分母。測れなければ NaN。
 *
 * **入力のコマ数から出す** (尺 × 入力の毎秒コマ数)。出力の毎秒コマ数を
 * 決め打ちにはしない。インタレ解除 (`deinterlace`) はインタレのコマ (29.97 の 1080i) 1 つから
 * 60 コマ指定なら 2 コマ、30 コマ指定なら 1 コマ作る。プログレッシブのコマ (59.94 の 720p の局) は
 * 倍にしないので、入力が 50 コマ以上なら 60 コマ指定でも掛けない (掛けると 50% で止まる)。
 *
 * 先頭を捨てるぶん (`-ss`) はもうエンコードしないので引く
 */
export function expectedFrames(
  probed: { duration: number; fps: number } | undefined,
  skipSec: number,
  smooth: boolean,
): number {
  if (probed === undefined) return NaN;
  const seconds = probed.duration - (Number.isFinite(skipSec) ? skipSec : 0);
  if (!(Number.isFinite(seconds) && seconds > 0)) return NaN;
  if (!(Number.isFinite(probed.fps) && probed.fps > 0)) return NaN;
  return seconds * probed.fps * (smooth && probed.fps < 50 ? 2 : 1);
}

/**
 * 進み具合は**エンコードできたコマ数**から出す (`-progress` の `frame=` ÷ `expectedFrames`)。
 * 残り時間も同じ出どころ (直近 30 秒で何コマエンコードできたか)。
 *
 * **エンコーダが今どこにいるかを直に数えている**。`out_time_us` (mux が最後に書いた時刻。
 * 疎な字幕で先に飛ぶ) や入力の読み位置 (デマクサの位置。先に読み切ることがある) は使わない。
 * 読み位置は**分母 (尺) が測れなかったときの控え**。経緯は docs/encode.md「進み具合はエンコードできたコマ数から出す」
 */
export function encodeProgress(totalFrames: number, inputBytes: number) {
  const samples: { at: number; done: number }[] = [];
  // NaN 汚染を防ぐガードが要る (JSON 上 typeof NaN === 'number' で素通りするため)
  const measurable = (value: number) => Number.isFinite(value) && value > 0;

  return (
    at: number,
    pos: number,
    block: Record<string, string>,
    prev: number,
  ): Progress => {
    const frames = Number(block["frame"]);
    const counted =
      measurable(totalFrames) && Number.isFinite(frames) && frames >= 0;
    // 読み位置が取れない間 (/proc が無い・一瞬の読み損ね) もある
    const readable = measurable(inputBytes) && Number.isFinite(pos) && pos >= 0;
    // どちらも取れなければ前の値を保ち、当てずっぽうを出さない
    const done = counted
      ? Math.min(1, frames / totalFrames)
      : readable
        ? Math.min(1, pos / inputBytes)
        : NaN;
    /*
     * 前の値より下げない (読み損ねからの復帰で巻き戻って見えないように)。
     * **100% は ffmpeg が終わるまで出さない**。最後のコマをエンコードしても、
     * 溜めたフレームの出力と mux の後処理が残っている。エンコードし切った時点で
     * 100.0% と出すと、そこで止まって見える (失敗して最初からやり直す時は
     * 特に、100% → 0% と動いて二度おかしく見えた)
     */
    const fraction = Number.isFinite(done) ? done : prev;
    const percent =
      block["progress"] === "end"
        ? 1
        : Math.min(Math.max(prev, fraction), 0.99);

    let etaMs: number | null = null;
    if (Number.isFinite(done)) {
      samples.push({ at, done });
      while (samples.length > 0 && at - samples[0]!.at > ETA_WINDOW_MS)
        samples.shift();
      const oldest = samples[0]!;
      const spanMs = at - oldest.at;
      const gained = done - oldest.done;
      // 速さが読めないうち (窓がまだ短い・進んでいない) は null のまま
      if (spanMs >= ETA_MIN_SPAN_MS && gained > 0) {
        etaMs = Math.round(((1 - done) / gained) * spanMs);
      }
    }

    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
    const sizeMb = (
      parseInt(block["total_size"] ?? "", 10) /
      1024 /
      1024
    ).toFixed(1);
    const rateMbps = (parseFloat(block["bitrate"] ?? "") / 1000).toFixed(2);
    // 読み位置も残す。**割合には使っていないが、詰まった時の見立てに要る**
    // (デマクサだけ先に進んでいるのか、本当に遅いのかがこの 2 つを並べると分かる)
    return {
      percent,
      etaMs,
      log: `frame: ${counted ? `${frames}/${Math.round(totalFrames)}` : "数えられず"}, input: ${readable ? `${mb(pos)}/${mb(inputBytes)}MB` : "測れず"}, speed: ${block["speed"]}, size: ${sizeMb}MB, rate: ${rateMbps}Mbps, drop: ${block["drop_frames"]}`,
    };
  };
}

/**
 * ffmpeg が入力ファイルをどこまで読んだかを /proc から読む。
 *
 * 子プロセスとは同じ名前空間にいるので、/proc/<pid>/fd から入力ファイルを
 * 指している fd を探せば、/proc/<pid>/fdinfo/<fd> の pos がそのまま読み位置。
 * Linux 専用で、Windows・Mac では読めない。読めない環境では、分母 (尺) を測れなかったときに
 * 割合が動かなくなるだけで、エンコードしたものには影響しない。
 */
export function findInputFd(pid: number, path: string): number | null {
  try {
    for (const name of readdirSync(`/proc/${pid}/fd`)) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${name}`) === path)
          return Number(name);
      } catch {
        // 読んでいる間に閉じられた fd。次を見る
      }
    }
  } catch {
    // プロセスがもういないか、/proc の無い環境
  }
  return null;
}

/** 読み位置 (バイト)。fd が閉じられているなど、読めなければ NaN */
export function readInputPos(pid: number, fd: number): number {
  try {
    const m = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8").match(
      /^pos:\s*(\d+)/,
    );
    return m === null ? NaN : Number(m[1]);
  } catch {
    return NaN;
  }
}

/**
 * 失敗の理由を stderr から読み取る。
 *
 * 末尾をそのまま切り出すと警告ばかりが残って肝心の理由が見えない。エラーらしい行を優先して残す。
 */
export function failureReason(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.filter((line) =>
    /error|invalid|failed|no such file|permission denied|not supported|unable to|conversion failed/i.test(
      line,
    ),
  );
  const picked = errors.length > 0 ? errors : lines;
  return picked.slice(-8).join("\n").slice(-2000);
}

/**
 * コーデックごとの進み具合を 1 つにまとめる。**画面と DB の進み具合は 1 つしか無い** (`encode_jobs.percent`) ので、
 * 同時に動くコーデックを足し合わせて出す。
 *
 * - 割合は全部のコーデックの平均。エンコードし終えたものは 1、まだ始まっていない (枠を待っている) ものは 0
 * - 残り時間はいちばん遅いもの。まだ始まっていないもの・速さが読めないものがあれば出さない
 * - ログはコーデックの名前を添えて並べる (`AV1: frame … / H.264: frame …`)。1 本だけならそのまま
 */
export function combineProgress(
  parts: ReadonlyMap<HwCodec, Progress>,
  total: number,
): Progress {
  const values = [...parts.values()];
  if (total <= 1 && values.length <= 1)
    return values[0] ?? { percent: 0, etaMs: null, log: "" };
  const percent =
    values.reduce((sum, part) => sum + part.percent, 0) /
    Math.max(total, values.length);
  const running = values.filter((part) => part.percent < 1);
  const etaMs =
    values.length < total ||
    running.length === 0 ||
    running.some((part) => part.etaMs === null)
      ? null
      : Math.max(...running.map((part) => part.etaMs!));
  const log = [...parts.entries()]
    .map(([codec, part]) => `${CODEC_LABEL[codec]}: ${part.log}`)
    .join(" / ");
  return { percent, etaMs, log };
}

/**
 * ジョブの進み具合を DB に書き戻す。コーデックごとの ffmpeg が `part(codec)` に知らせ、まとめたもの (`combineProgress`) を
 * DB に書いて画面に流す。**書くのはジョブで間隔を空けて** (ffmpeg ごとに書くと、同時に動く本数だけ書く回数が増える)
 */
function progressMeter(jobId: number, recordingId: number, total: number) {
  const parts = new Map<HwCodec, Progress>();
  let lastWrite = 0;
  const write = (force: boolean) => {
    const at = Date.now();
    if (!force && at - lastWrite < PROGRESS_INTERVAL) return;
    // 中止を指示された後は「中止しています」を残す (setStep と同じ)
    if (canceled.has(jobId)) return;
    lastWrite = at;
    const { percent, etaMs, log } = combineProgress(parts, total);
    orm()
      .update(encodeJobs)
      .set({ percent, eta_ms: etaMs, log })
      .where(eq(encodeJobs.id, jobId))
      .run();
    // 進み具合は**中身ごと**流す (`encode` イベント)。画面は該当行の数字を書き換えるだけで済む
    emit("encode", {
      recordingId,
      percent,
      etaMs,
      log,
    } satisfies EncodeProgress);
  };
  return {
    /** そのコーデックの ffmpeg から進み具合を受け取る。`final` は ffmpeg が終わったとき (間隔を待たずに書く) */
    part:
      (codec: HwCodec) =>
      (progress: Progress, final: boolean): void => {
        parts.set(codec, progress);
        write(final);
      },
  };
}

/** ffmpeg の進み具合の渡し先 (`progressMeter` の `part`) */
type ProgressReport = (progress: Progress, final: boolean) => void;

async function runFfmpeg(
  jobId: number,
  report: ProgressReport,
  input: string,
  output: string,
  audioType: number | null,
  seek: number | null,
  codec: HwCodec,
  options: EncodeOptions = {},
  /** CM 検出を一緒にするときの読み取り関数 (`options.analysis` と組で渡す) */
  reader?: ScanReader,
) {
  // 4 本目の出力は進み具合 (`-progress`。`stream.sideOutput`)。標準出力は CM 検出のロゴの枠 (読まないなら捨てる)
  const side = sideOutput();
  const proc = Bun.spawn(
    [
      config.ffmpeg,
      ...buildArgs(input, output, audioType, seek, codec, {
        ...options,
        progress: side.url,
      }),
    ],
    {
      stdio: [
        "ignore",
        reader?.onStdout !== undefined ? "pipe" : "ignore",
        "pipe",
        ...side.stdio,
        // 型は Linux の形 (4 本) で見せる。Windows では 3 本 (`sideOutput`)
      ] as ["ignore", "pipe" | "ignore", "pipe", "pipe"],
    },
  );
  const progressPipe = side.read(proc as never);
  // 録画のエンコードは急がない。ライブに CPU を譲る (stream.lowerPriority)
  lowerPriority(proc.pid);
  const running = procs.get(jobId) ?? new Set<Bun.Subprocess>();
  running.add(proc);
  procs.set(jobId, running);
  // 起動する前に中止されていた (同時に動くコーデックの片方が、押されたのと同時に起動した)
  if (canceled.has(jobId)) proc.kill();

  /*
   * 進み具合はエンコードできたコマ数から出す (encodeProgress)。分母はエンコードする前に測った尺、
   * 分子は `-progress` の `frame=`。入力の読み位置は分母が測れなかったときの
   * 控えと、詰まった時の見立て用に読み続ける。
   * /proc の fd は実体のパスで見えるので、シンボリックリンクはここで解決しておく
   */
  let inputPath = input;
  let inputBytes = NaN;
  try {
    inputPath = realpathSync(input);
    inputBytes = statSync(inputPath).size;
  } catch {
    // 測れなければ控えが 1 つ減るだけ。エンコードするほうはそのまま進める
  }
  const total = expectedFrames(
    options.probed,
    inputSkip(seek, options.videoStart),
    options.smoothMotion === true,
  );
  const progress = encodeProgress(total, inputBytes);
  let inputFd: number | null = null;
  let inputPos = NaN;

  // 出力し終えた時点の位置。測れなかったときの出来上がりの長さ
  let outTimeUs = NaN;
  let percent = 0;
  let log = "";
  /** 落ちた理由を読むための末尾。CM 検出が読む行 (`Duration:`) は入れない */
  const tail: string[] = [];

  const onProgress = (block: Record<string, string>) => {
    const at = Number(block["out_time_us"]);
    if (Number.isFinite(at) && at > 0) outTimeUs = at;

    if (inputFd === null) inputFd = findInputFd(proc.pid, inputPath);
    if (inputFd !== null) {
      const pos = readInputPos(proc.pid, inputFd);
      // 読み終えると ffmpeg は fd を閉じる。最後に見えた位置 (≒末尾) を
      // 保ったまま、念のため次の刻みから探し直す
      if (Number.isFinite(pos)) inputPos = pos;
      else inputFd = null;
    }
    const p = progress(Date.now(), inputPos, block, percent);
    percent = p.percent;
    log = p.log;
    // 書き戻す間隔はジョブでまとめて空ける (`progressMeter`)
    report(p, false);
  };

  const readProgress = (async () => {
    let block: Record<string, string> = {};
    for await (const line of lines(progressPipe)) {
      const sep = line.indexOf("=");
      if (sep === -1) continue;
      block[line.slice(0, sep)] = line.slice(sep + 1).trim();
      if (block["progress"] === undefined) continue;
      onProgress(block);
      block = {};
    }
  })();

  const readStderr = (async () => {
    for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
      if (reader?.line(line) === true) continue;
      if (line === "") continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }
  })();

  const onStdout = reader?.onStdout;
  const readStdout = (async () => {
    if (onStdout === undefined) return;
    let broken = false;
    for await (const chunk of chunks(
      proc.stdout as ReadableStream<Uint8Array>,
    )) {
      if (broken) continue;
      try {
        onStdout(chunk);
      } catch (error) {
        /*
         * ロゴの点付けが壊れても**エンコードするほうは止めない**。読み捨てて続けると、届いた枠の数が
         * コマの数と合わなくなり、ロゴを使わずに決める (`cm.openCm`)
         */
        broken = true;
        console.error(`[cm] ロゴの枠を読めなくなりました: ${error}`);
      }
    }
  })();

  const [code] = await Promise.all([
    proc.exited,
    readStdout,
    readStderr,
    readProgress,
  ]);
  running.delete(proc);
  report({ percent: code === 0 ? 1 : percent, etaMs: null, log }, true);
  return { code, stderrTail: failureReason(tail.join("\n")), outTimeUs };
}

/** エンコードするときと同じ入力の前の引数 (先頭を捨てる `-ss` と、前の番組を越えて本編まで探る長さ `lead`)。CM 検出で読み直すときもコマの並びを揃える */
function inputArgs(skip: number, lead: number): string[] {
  return [...(skip > 0 ? ["-ss", String(skip)] : []), ...tsProbe(lead)];
}

/**
 * エンコードしながら読んだ材料から CM を決める。**入れ物の先頭からの秒で返す** (エンコードしたものの時刻に
 * `skip` を足す)。エンコードするたびに捨てる先頭の長さが変わっても、ここを物差しにして引き直す (`own`)。
 * 読めなかった・決められなかったときは CM 無しで、理由を覚え書きに残す (エンコードしたものは捨てない)。
 * `video` が偽なら音だけ読み直したもの
 */
async function decide(
  reading: CmReading,
  found: Scan | null,
  skip: number,
  video: boolean,
  lead: number,
): Promise<CmDetection> {
  const none = (note: string) => ({ cm: [], duration: Number.NaN, note });
  if (found === null) return none("CM 検出の読み込みが失敗しました");
  try {
    // ロゴを覚え直して枠だけ読み直すときも、エンコードしたときと同じだけ先頭を捨てる
    return shiftDetection(
      await reading.decide(found, {
        skip,
        before: inputArgs(skip, lead),
        video,
      }),
      skip,
    );
  } catch (error) {
    console.error(`[cm] 検出に失敗しました: ${error}`);
    return none(`CM 検出に失敗しました: ${error}`);
  }
}

/** 有料の番組の録画か (番組表の `is_free`)。番組が番組表から消えていれば分からないので false */
function paidRecording(recording: Recording): boolean {
  if (recording.program_id === null) return false;
  const program = orm()
    .select({ isFree: programs.is_free })
    .from(programs)
    .where(eq(programs.id, recording.program_id))
    .get();
  return program !== undefined && !program.isFree;
}

/**
 * ジョブの元の TS から派生する中間ファイルを消す。
 *
 * `descramble` の `.decoded.m2ts` は、正常終了や失敗なら finally / cleanup で消えるが、
 * **プロセスごと落ちたときは取り残される**。しかも TS の拡張子で終わるので、保存先の片付け (`files.reconcile`) は
 * 動画と見なして消さない (`files.ts` の VIDEO)。元の TS と同じ大きさのものが丸ごと残る。
 *
 * 動かし直せば作り直すものなので、ジョブを実行・再実行する直前と、failed にするときに
 * 消しておく。自分の入力に紐づくものだけ触るので、ほかの動いているエンコードには当たらない。
 * エンコードしたものの隣に作る作業ファイル (`.encoding` と、チャプターを書き足すときの `.post`・`.chapters.txt`) は動画の拡張子ではなく、名前にジョブの番号を持つので、
 * 取り残されても、ジョブが走っていなければ片付けで消える (同じ名前の動画があっても。`files.orphan`)
 */
function clearScratch(input: string): void {
  removeIfExists(`${input}.decoded.m2ts`);
  removeIfExists(remuxedPath(input));
}

/**
 * **4K の録画を詰め替えた作業ファイル** (`mmts.remuxMmts`)。ffmpeg と ffprobe は TLV を読めないので、エンコードと CM 検出の前に
 * 映像と音声を MP4 に写し、あとは TS の録画と同じく読む。映像と音声をそのまま写すので、元と同じくらいの大きさになる
 */
function remuxedPath(input: string): string {
  return `${input}.remux.mp4`;
}

/** 局の行の service_id (放送が名乗っている番号。MPT の MMT_package_id)。局が無ければ 0 */
export function broadcastServiceId(serviceId: number): number {
  return (
    orm()
      .select({ id: services.service_id })
      .from(services)
      .where(eq(services.id, serviceId))
      .get()?.id ?? 0
  );
}

/**
 * **エンコードする元の録画の扱い** (`runJob`・`recorder.ts` のエンコードしない録画のサムネイル)。
 *
 * - `tlv` … 4K の局の録画 (`.mmts`)。ffmpeg に渡す前に MP4 に詰め替え (`remuxForEncode`)、字幕は TTML から文字の配置にして隣に置く。
 *   データ放送は取り出さない
 * - `uhd` … 映像が 4K の HEVC (`.mmts` と、PMT の映像が HEVC の TS。`recorded-broadcast.recordedBroadcast`)。
 *   インタレ解除と引き伸ばしをせず (`videoArgs`)、AV1 は GPU を使わず、コマ数は入力のまま、サムネイルは SDR に直して取る
 *
 * TS で送る 4K の局の録画は `uhd` だけが立つ。入力は今までどおり元の TS (復号もする) で、字幕は TS の ARIB 字幕を写し (`captionArgs`)、
 * データ放送も取り出す。録り終えた録画には PMT が書かれている。PMT を読めない TS は MPEG-2 の局の録画として扱う
 * @param program その局の放送の番号 (`broadcastServiceId`)
 */
export function encodeInput(
  path: string,
  program: number,
): { tlv: boolean; uhd: boolean } {
  const tlv = recordedTransport(path) === "tlv";
  return { tlv, uhd: tlv || recordedBroadcast(path, program) === "hevc" };
}

/**
 * **4K の録画を、作業ファイルの MP4 に詰め替える** (`runJob`・`runCmJob`)。字幕の文字の配置も返す (MP4 の時刻。秒)。
 * 読めなければ理由を返す (スクランブルされたまま録れていれば ACAS の理由)。止めの合図が来たら null
 */
async function remuxForEncode(
  input: string,
  recording: Recording,
  signal: AbortSignal,
): Promise<
  | { ok: true; path: string; captions: CaptionPages["pages"] }
  | { ok: false; reason: string }
  | null
> {
  const target = remuxedPath(input);
  const result = await remuxMmts(
    input,
    broadcastServiceId(recording.service_id),
    target,
    signal,
  );
  if (signal.aborted) {
    removeIfExists(target);
    return null;
  }
  if (!result.wrote) {
    removeIfExists(target);
    return {
      ok: false,
      reason:
        result.scrambled > 0
          ? undecodableReason("CATV", "tlv")
          : "4K の録画から映像と音声を読めませんでした",
    };
  }
  return { ok: true, path: target, captions: result.captions };
}

/**
 * **4K の録画の字幕を、エンコードしたものの隣に置く** (`….captions.json`。`api/recordings/<id>/captions.json` が配る)。
 * 中身は観る画面に渡すものと同じ文字の配置 (`CaptionPages`)。Matroska には入れない。ffmpeg 7.1 の Matroska は TTML を書けない
 * (`Subtitle codec 94232 is not supported`。Debian の ffmpeg 7.1 で確かめた)。
 *
 * 時刻は詰め替えた MP4 の秒なので、エンコードしたものの物差しに直す。ffmpeg は入力の先頭 (`start_time`) と
 * 捨てた先頭 (`-ss`) のぶんを 0 に寄せるので、その和 (`shift`) を引く。0 より前に出ていた字幕は 0 に寄せて残す
 * (エンコードしたものの先頭で出ている字幕)。字幕が 1 つも無ければ置かない
 */
function writeCaptions(
  path: string,
  pages: CaptionPages["pages"],
  shift: number,
): void {
  const moved = pages.map((p) => ({ at: p.at - shift, page: p.page }));
  const first = moved.findLastIndex((p) => p.at <= 0);
  const kept = moved
    .slice(Math.max(0, first))
    .map((p) => ({ at: Math.max(0, p.at), page: p.page }));
  if (kept.length === 0) return;
  const body: CaptionPages = { v: CAPTION_TEXT_VERSION, pages: kept };
  writeFileSync(path, JSON.stringify(body));
}

/** ジョブを失敗にする (行を書くだけ。通知も画面の更新もしない) */
function markFailed(jobId: number, reason: string): void {
  orm()
    .update(encodeJobs)
    .set({ state: "failed", error: reason, finished_at: now() })
    .where(eq(encodeJobs.id, jobId))
    .run();
}

/**
 * エンコードの失敗を記録して知らせる。
 *
 * **録画の行には何も書かない。** 落ちたのは再エンコードのほうで、元の録画は無事なので、
 * 録画そのものを「失敗」にすると観られるはずのものが観られなくなる (実際にそうなっていた)。
 * 理由はジョブが持ち、一覧は最新のジョブを見て出す
 */
function fail(
  jobId: number,
  recording: Recording,
  reason: string,
  what = "エンコード",
): void {
  markFailed(jobId, reason);
  emit("recordings");
  notify({
    event: "encode.failed",
    text: `${what}に失敗しました: ${recording.name} (${recording.service_name})`,
    recording: recordingSummary(recording),
    error: reason,
  });
}

/**
 * 中止で終わったときの後始末。
 *
 * 出来かけの作業ファイルだけ捨てて、元の録画には触らない。
 * どの段階で止めても同じやり方で畳めるように 1 か所にまとめてある。
 */
function finishCanceled(jobId: number, working: string | null): void {
  removeIfExists(working);
  orm()
    .update(encodeJobs)
    .set({ state: "canceled", finished_at: now() })
    .where(eq(encodeJobs.id, jobId))
    .run();
  // 録画の行は触らない。ジョブが消えれば「録画済み」に戻って見える
  emit("recordings");
}

/** ジョブを走らせる支度。中止の合図 (`aborts`) を置いて、ジョブと録画の行を引く */
function startJob(jobId: number) {
  const controller = new AbortController();
  aborts.set(jobId, controller);
  const job = orm()
    .select()
    .from(encodeJobs)
    .where(eq(encodeJobs.id, jobId))
    .get()!;
  const recording = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.id, job.recording_id))
    .get();
  return { signal: controller.signal, job, recording };
}

/** 番組の長さと始まりを出すのに読む列 (`programSpan`) */
type SpanColumns = Pick<
  Recording,
  "start_at" | "end_at" | "ts_head" | "record_from"
>;

/**
 * 番組の長さと、録画の先頭から番組が始まるまで (秒)。録画の先頭と末尾に入った前後の番組を見分ける (cm-decide.withinProgram)。
 * 録画の先頭は測った放送時刻 (`ts_head`)、測れていなければ録り始める予定の時刻 (`recording.tsHeadOf`)
 */
export function programSpan(recording: SpanColumns): {
  programLength: number;
  programStart: number;
} {
  return {
    programLength: (recording.end_at - recording.start_at) / 1000,
    programStart: (recording.start_at - tsHeadOf(recording)) / 1000,
  };
}

/**
 * CM 検出をやり直すときの入力の前の引数。**元の TS から読むなら、エンコードしたときと同じ長さまで探る**
 * (`inputArgs` の `lead`。見える音声の並びを揃える。`ts-probe.ts`)。先頭は捨てない (`skip` 0。物差しは入れ物の先頭)。
 * エンコード済みの動画から読むなら何も足さない
 */
export function rereadArgs(recording: SpanColumns, fromTs: boolean): string[] {
  return fromTs ? inputArgs(0, programSpan(recording).programStart) : [];
}

/** ジョブを終わったことにする */
function markDone(jobId: number): void {
  orm()
    .update(encodeJobs)
    .set({ state: "done", percent: 1, finished_at: now() })
    .where(eq(encodeJobs.id, jobId))
    .run();
}

/** CM の境目と覚え書きを録画の行に書く */
function saveCm(recordingId: number, detection: CmDetection): void {
  orm()
    .update(recordings)
    .set({
      cm_ranges: detection.cm,
      cm_note: detection.note,
      updated_at: now(),
    })
    .where(eq(recordings.id, recordingId))
    .run();
}

/**
 * **1 本エンコードするときに ffmpeg を起こす順** (`runJob` の `encodeWays`)。GPU の方式 (`hwChain` の順) のあとにソフトウェア
 * (H.265 を除く。`SOFTWARE_CODECS`) で、**どの方式も「素のまま → 先頭を少し捨てて」の 2 回だけ**。
 * 1 回の実行の中の起こし直しはこの並びで尽きる (`encode_jobs.attempts` に数えない理由)
 */
export function encodeAttempts(
  codec: HwCodec,
  hardware: HwWay[],
): { seek: number | null; hardware: HwWay | undefined }[] {
  const ways: (HwWay | undefined)[] = [
    ...hardware,
    ...(SOFTWARE_CODECS.includes(codec) ? [undefined] : []),
  ];
  return ways.flatMap((way) => [
    { seek: null, hardware: way },
    { seek: config.encodeRetrySeek, hardware: way },
  ]);
}

async function runJob(jobId: number): Promise<void> {
  const { signal, recording } = startJob(jobId);
  if (recording === undefined) {
    markFailed(jobId, "録画が見つかりません");
    return;
  }
  const input = encodeSource(recording);
  if (input === null) {
    fail(jobId, recording, "元の TS がありません");
    return;
  }

  // 前の回が落ちて取り残した中間ファイルを片付けてから始める (この元の TS のぶんだけ)
  clearScratch(input);

  /*
   * 「エンコード中」は録画の行には書かない。動いているジョブがあることが
   * そのまま「エンコード中」なので、一覧はそれを見て出す (format.encodeLabel)。
   * 前の失敗の理由もジョブ側にあり、いちばん新しいジョブだけを見ているので消して回る必要もない
   */
  emit("recordings");

  /*
   * **エンコードするコーデックを先に決める。** H.265 は GPU でだけエンコードする (`SOFTWARE_CODECS`) ので、
   * いま H.265 をエンコードできる GPU が無ければ (抜いた・設定で外した) H.265 は飛ばし、
   * H.265 しか選んでいなければここで失敗にする。復号や前のものを消すより前に決めるのは、
   * 作れないと分かっている再エンコードで、いま観られる mkv を消さないため (元の TS は残るので、GPU を戻せば作り直せる)。
   *
   * **GPU を確かめ終わるのを待ってから決める** (`hwReady`)。起動した直後のジョブが、確かめる前の
   * 「GPU 無し」で H.265 を飛ばし、H.264 を CPU でエンコードしないように
   */
  await hwReady();
  /*
   * **「エンコードしない」(どれも選んでいない) ならエンコードしない。** 待っている間に設定を変えたジョブは、
   * ホームの再エンコードと同じ理由で失敗にする。元の TS は残るので、コーデックを選べばやり直せる
   */
  const chosen = settings().codecs;
  if (chosen.length === 0) {
    fail(jobId, recording, NO_CODEC);
    return;
  }
  const hevcReady = hwChain("hevc", settings().hwAllow).length > 0;
  if (chosen.includes("hevc") && !hevcReady && chosen.length > 1) {
    console.warn(
      `[encode] H.265 をエンコードできる GPU が無いため、H.265 は飛ばします (録画 ${recording.id})`,
    );
  }
  const codecs = encodeOrder(chosen, hevcReady);
  if (codecs.length === 0) {
    fail(
      jobId,
      recording,
      "H.265 をエンコードできる GPU がありません (H.265 はソフトウェアではエンコードしません)",
    );
    return;
  }

  /*
   * **置き場所は出来上がってから決める** (下の `renameSync` の直前)。
   * ここで決めた名前を最後まで使うと、**同じ番組を 2 本同時にエンコードしたときに
   * 両方が同じ名前を選ぶ**。どちらもまだ書き終えていないので、
   * `libraryPath` の「空いているか」がどちらにも空いて見える。
   * いま要るのは置き場所ではなく**フォルダ**だけ
   */
  mkdirSync(dirname(libraryPath(recording, ".mkv")), { recursive: true });

  // スクランブルが掛かったまま録れていたら、ここで復号する (scramble.ts)
  /** 後始末で消す作業ファイル。元の TS を置き換えたときは残す側になるので null のまま */
  let decoded: string | null = null;
  /** 後から復号させたエージェント (`agents.id`)。有料の番組を復号できたとき、契約中にするのはこのエージェントのカード */
  let decodedBy: number | null = null;
  let sourceTs = input;
  /** `tlv` は ffmpeg に渡す前に MP4 に詰め替える 4K の局の録画 (`.mmts`)、`uhd` は映像が 4K の HEVC の録画 (`encodeInput`) */
  const { tlv, uhd } = encodeInput(
    input,
    broadcastServiceId(recording.service_id),
  );
  /** 4K の局の録画 (`.mmts`) の字幕 (詰め替えた MP4 の時刻)。エンコードしたものの隣に置く (`writeCaptions`) */
  let uhdCaptions: CaptionPages["pages"] = [];
  if (tlv) {
    setPhase(jobId, "remux", "4K の映像と音声を MP4 に詰め替えています");
    const remuxed = await remuxForEncode(input, recording, signal);
    if (remuxed === null) return finishCanceled(jobId, null);
    if (!remuxed.ok) {
      fail(jobId, recording, remuxed.reason);
      return;
    }
    decoded = remuxed.path;
    sourceTs = remuxed.path;
    uhdCaptions = remuxed.captions;
  } else if (isScrambled(input)) {
    setPhase(jobId, "descramble", "スクランブルを復号しています");
    const target = `${input}.decoded.m2ts`;
    const result = await descramble(input, target, signal);
    if (!result.ok) {
      removeIfExists(target);
      // 中止で切ったときは失敗にしない。下の後始末で canceled として畳む
      if (canceled.has(jobId)) return finishCanceled(jobId, target);
      // 有料の番組が、カードは読めているのに掛かったまま。その局は次の回から録らない (`contracts.noteStillScrambled`)
      if (result.stillScrambled === true && paidRecording(recording))
        noteStillScrambled(recording.service_id, result.cardId ?? null);
      fail(
        jobId,
        recording,
        `スクランブルを復号できませんでした: ${result.error}`,
      );
      return;
    }
    // 元の TS を残すかは録画ごとではなく全体設定 (settings.keepOriginal)
    decodedBy = result.agent ?? null;
    if (settings().keepOriginal) {
      // 元の TS を残す設定なら、残すのは復号できたほうだけにする。
      // 掛かったままの TS を取っておいても、あとから復号できる保証は無い
      renameSync(target, input);
    } else {
      decoded = target;
      sourceTs = target;
    }
  }
  /*
   * 有料の番組を復号できて録れた。その局を契約中にする (`contracts.noteDecoded`。上の `noteStillScrambled` の反対)。
   * 番組表の行は 24 時間で消えるので (`paidRecording`)、古い録画を再エンコードしても契約の手がかりにはしない。
   *
   * 録画は、ふつうエージェントが受けながら復号した TS なので、録る前に掛かっていたかはここでは分からない。
   * 有料 (`is_free` が false) は番組表の free_CA_mode で、放送では掛かっている番組を指す。その番組が復号できていれば、
   * カードが鍵を貰えた (`testDecode` が、いま有料の番組を流している間だけ確かめるのと同じ考え)。
   * `cardStatus` は失敗を答えで返すので、カードが読めなくてもエンコードは止まらない (`noteDecoded` が何も書かないだけ)
   */
  if (!tlv && paidRecording(recording) && isDecoded(sourceTs))
    await noteDecoded(recording.service_id, decodedBy ?? recording.agent_id);

  // コマ数 (`smoothMotion`) は、局ロゴを開いたあとに本編映像から実測して入れる (measureSmoothMotion)
  const encodeOptions: EncodeOptions = {
    /*
     * **音声トラックに番組表と同じ名前を入れる。**
     *
     * 番組表の行は 24 時間で消えるので、写しておいたものから引く
     * (`recordings.audios`。ジャンルと同じ扱い)。古い録画には写しが無いので、
     * そのときは `audioTitles` の既定 (「音声」/「主音声」「副音声」) に落ちる
     * (壊れた行を空にするのは列の読み取り関数。`schema.ts`)
     */
    audioTitles: audioTitles(
      recording.audios ?? [],
      recording.audio_type === DUAL_MONO,
    ),
    audioChannels: (recording.audios ?? []).map((audio) =>
      audioChannels(audio.componentType),
    ),
    probeLead: programSpan(recording).programStart,
    mediaTitle: displayTitle(recording.name),
    uhd,
  };

  /*
   * **CM はエンコードしながら探す。** 1 本目のコーデックをエンコードする ffmpeg に CM 検出の出力を足して、
   * TS を 1 回だけデコードする (`cm-scan.scanReader`)。ここでは支度だけをする。尺を測り、局ロゴを開く
   * (覚えていなければキーフレームだけ読んで覚える)
   */
  let reading: CmReading | null = null;
  setPhase(jobId, "cm", "局ロゴを確かめています");
  try {
    reading = await openCm(sourceTs, {
      signal,
      serviceId: recording.service_id,
      ...programSpan(recording),
      onStep: (label) => setStep(jobId, label),
    });
  } catch (error) {
    console.error(
      `[cm] 検出の支度に失敗したため CM 処理をスキップします: ${error}`,
    );
  }
  if (canceled.has(jobId)) return finishCanceled(jobId, decoded);

  /*
   * コマ数を本編映像から実測する (measureSmoothMotion)。
   * CM はまだ分からないので、録画全体に窓を散らす。散らす範囲は TS の実際の尺
   * (先頭が欠けた・途中で切れた録画を番組の尺で散らすと、後ろの窓がファイルの外に出て測れない)
   */
  setStep(jobId, "フレームレートを確かめています");
  // 画面の大きさ・画素の縦横比・冒頭の音声だけの区間をエンコードする前に測っておく。
  // 尺と毎秒コマ数は進み具合の分母にもなる (encodeProgress。下で probed に渡す)
  const measured = await probeVideo(sourceTs);
  /*
   * 4K の局はプログレッシブなので、フィールドを数えずに入力のコマ数のまま出す (59.94 コマなら 60 コマ。`fps` の列も 60)。
   * 実測 (`measureSmoothMotion`) はインタレの放送の 24p 系・30p を見分けるためのもの
   */
  encodeOptions.smoothMotion = uhd
    ? measured.fps >= 50
    : await measureSmoothMotion(
        sourceTs,
        Number.isFinite(measured.duration)
          ? measured.duration
          : (recording.end_at - recording.start_at) / 1000,
        signal,
      );
  // ここから先の下調べ (ffprobe) は合図を受け取らない。測っている間に押されていたら、その前でやめる
  if (canceled.has(jobId)) return finishCanceled(jobId, decoded);

  setPhase(jobId, "encode", "");

  encodeOptions.probed = { duration: measured.duration, fps: measured.fps };
  encodeOptions.height = measured.height;
  encodeOptions.audioStreams = await probeLiveAudio(
    sourceTs,
    encodeOptions.probeLead ?? 0,
  );
  // 映像が出るまでの音声だけの区間。先頭から捨てて 0 秒から始める
  encodeOptions.videoStart = await probeLeadIn(
    sourceTs,
    measured.formatStart,
    measured.packetStart,
  );

  /*
   * 画素が横長なら、正方形に直した大きさでエンコードする (地上波の HD は 1440x1080 の SAR 4:3)。
   * **もともと正方形なら渡さない**。同じ大きさへの scale は仕事が増えるだけ
   */
  if (
    Number.isFinite(measured.width) &&
    Number.isFinite(measured.height) &&
    measured.sar !== 1
  ) {
    const width = Math.round((measured.width * measured.sar) / 2) * 2;
    if (width > 0 && width !== measured.width) {
      encodeOptions.displaySize = { width, height: measured.height };
    }
  }

  if (canceled.has(jobId)) return finishCanceled(jobId, decoded);

  /*
   * **再エンコードする前に、いま置いてあるものを消す。**
   *
   * 出来上がるまで別名 (`.encoding`) に書くので、消さないと同じ番組の mkv が
   * エンコードしている間ずっと 2 本ぶん場所を取る。**画面に出ている大きさより実際の
   * 使用量が多い**のは、外から見て分からない。
   *
   * **消しても再エンコードできる。** 元は元の TS (`encodeSource`) で、これとは別のファイル。
   * 引き換えに、失敗したり途中でやめたりするとその間は再生できるものが
   * 無くなるが、元の TS は残っているのでもう一度押せば戻る。
   *
   * **DB の `library_path` も一緒に空ける。** 残したままだと実体との照合が
   * 「保存先から消えていました」と読んで、**録画ごと削除済みにする**
   * (そのとき元の TS まで消える)。空けておけば照合の対象から外れ、
   * 画面でも「まだ保存先に無い」と正しく出る
   *
   * **DB が指すもの (最大 3 本) だけでなく、この録画が取りうる名前の取り残されたファイルも消す** (`libraryFamily`)。
   * 残っていると置き場所を「衝突」と読ませて `[録画ID]` が付く。
   * **ほかの録画が現に使っている置き場所は消さない** (DB で確認する)
   */
  const stalePaths = new Set<string>(encodedPaths(recording));
  for (const candidate of libraryFamily(recording)) {
    if (stalePaths.has(candidate) || !existsSync(candidate)) continue;
    if (!usedByOther(candidate, recording.id)) stalePaths.add(candidate);
  }
  if (stalePaths.size > 0) {
    for (const stalePath of stalePaths) {
      removeIfExists(stalePath);
      removeSidecars(stalePath);
    }
    orm()
      .update(recordings)
      .set({
        library_path: null,
        hevc_path: null,
        alt_path: null,
        updated_at: now(),
      })
      .where(eq(recordings.id, recording.id))
      .run();
    emit("recordings");
  }

  /*
   * **選ばれたコーデックを同時にエンコードする** (`settings().codecs`)。コーデックごとに ffmpeg を 1 本ずつ起動する
   * (1 本が落ちても、ほかは止めない)。同時に動く本数は枠で決まり (`encode-slots.ts`)、枠が足りなければ残りは空いてから動く。
   *
   * CM は 1 本目をエンコードする ffmpeg で一緒に探し、1 本目をエンコードし終えたら境目を決める。どのコーデックも
   * 境目が決まってから、チャプターを `-c copy` で書き足す。
   *
   * 1 本目は主 (`library_path`) と同じ AV1 → H.265 → H.264 の先頭 (`settings.parseCodecs` がこの順に並べる。下の `primary`)
   *
   * **どれかが失敗しても、出来たものは置く** (観られるものを捨てない)。ジョブは失敗にして理由を残し、元の TS は消さない
   * (再エンコードすれば全部作り直せる)。全部失敗したら、置きかけを消して失敗にする。
   * エンコードするコーデック (`codecs`) は、ジョブの最初に決めてある
   */
  /** CM 検出の結果 (入れ物の先頭からの秒)。1 本目をエンコードし終えたら決まる */
  let detection = null as CmDetection | null;
  const meter = progressMeter(jobId, recording.id, codecs.length);
  /** いまエンコードしている ffmpeg の数。0 でない間は段階を「エンコード中」のままにする */
  let encoding = 0;
  /** 落ちたコーデックと理由 */
  const failures: { codec: HwCodec; reason: string }[] = [];

  /**
   * 段階を進める。**ほかのコーデックをエンコードしている間は「エンコード中」と進み具合のまま**。
   * 1 本目の CM の境目を決めている (cm) 間も、ほかのコーデックはエンコードしている
   */
  const stage = (phase: EncodePhase, log: string): void => {
    if (encoding > 0) return;
    setPhase(jobId, phase, log);
  };

  /**
   * CM の区間を、先頭を `skip` 秒捨ててエンコードしたものの時刻に直す (`-ss` で映像・音声・字幕が詰まるのと同じ引き算)。
   * 再エンコード (`encodeRetrySeek`) で捨てる長さが変わるので、エンコードするたびに引き直す
   */
  const own = (skip: number) => {
    const found = detection ?? { cm: [], duration: Number.NaN };
    const duration = found.duration - skip;
    const cm = shiftRanges(found.cm, skip);
    return { cm, duration, keep: invertRanges(cm, duration) };
  };

  /**
   * コーデックごとの作業ファイル。別名に書いてから置き換える (入力と出力が同じ場所でも元を壊さない。失敗しても元が残る)。
   * 名前はジョブとコーデックで分ける。番組名だけだと同じ番組の 2 本が 1 つの作業ファイルに同時に書いて壊した (実機)。
   * 名前は最初に呼んだときに決めて覚える。`encodedPath` は同じ番組の別の録画が先に置き終えると `[録画ID]` を足すので、
   * 呼ぶたびに作ると、ffmpeg が書いたものと後で開くものの名前がずれる
   */
  const workingNames = new Map<HwCodec, string>();
  const workingOf = (codec: HwCodec): string => {
    let name = workingNames.get(codec);
    if (name === undefined) {
      name = `${encodedPath(recording, codec)}.${jobId}.${codec}.encoding`;
      workingNames.set(codec, name);
    }
    return name;
  };
  /** 作業ファイルと、その隣に作る書き直し・チャプターの一時ファイル */
  const removeWorking = (codec: HwCodec): void => {
    const working = workingOf(codec);
    for (const suffix of ["", ".post", ".chapters.txt"])
      removeIfExists(`${working}${suffix}`);
  };
  /** 途中でやめる/全部失敗するときに、置きかけを全部片付ける */
  const cleanup = (): void => {
    for (const codec of codecs) removeWorking(codec);
    removeIfExists(decoded);
  };

  /**
   * 1 本エンコードする。**試す順。** まず先頭からそのまま。落ちたら先頭を少し捨てて (`-ss`) もう一度。
   * 録画開始直後の数百 ms だけ壊れているケースをここで救う (buildArgs のコメント)。
   * 別の理由での失敗もここに来るが、もう一度同じ理由で落ちるだけなので無害。
   *
   * **GPU でエンコードするときは、その 2 回が駄目なら次の方式 (`hwChain` の順。最後はソフトウェア) で
   * 同じ 2 回をやり直す。** 起動時の試しのエンコードは通っても、素材しだいで落ちることは
   * ありうる (ドライバの対応していない大きさなど)。GPU が駄目なだけで録画が
   * 失敗になるのは避けたい。GPU の失敗は初期化で落ちるので、やり直しは速い
   *
   * `analysis` なら CM 検出を一緒にする。**全部落ちたら、探さずにもう 1 度だけエンコードする**。
   * 検出の出力がエンコードするほうまで落としたのかもしれない。エンコードできたら音だけ読み直して、CM の尺だけで決める
   */
  const encodeWays = async (
    codec: HwCodec,
    working: string,
    extra: {
      analysis: boolean;
    },
  ) => {
    const software = SOFTWARE_CODECS.includes(codec);
    /*
     * **4K の局の AV1 は GPU を使わない。** GPU の経路は 8 ビット (nv12) で組んであり、2160p・10 ビットのまま GPU に渡す組み方を
     * 確かめていない。H.264・H.265 は 1080p の 8 ビットに縮めてから渡すので、今までどおり GPU を使う
     */
    const attempts = encodeAttempts(
      codec,
      uhd && codec === "av1"
        ? []
        : hwChain(codec, settings().hwAllow, hwTurn++),
    );
    const report = meter.part(codec);
    let result = { code: -1, stderrTail: "", outTimeUs: 0 };
    let found: Scan | null = null;
    let skip = 0;
    for (const [i, attempt] of attempts.entries()) {
      if (i > 0) {
        if (canceled.has(jobId)) break;
        /*
         * ffmpeg の起こし直しは `encode_jobs.attempts` に数えない。あれはジョブを取り出した回数で、上限 (`encodeMaxAttempts`)
         * はジョブのやり直しにだけ当てる。1 回の実行の中の起こし直しは `encodeAttempts` の並び (方式ごとに 2 回) で尽きるので、上限は要らない。
         * 数えていた頃は、コーデックをいくつも選んで GPU からソフトウェアへ倒れた 1 回の実行だけで上限の 5 に届き、
         * その実行の途中でポッドが止まると、起動したときに 1 度もやり直さず失敗にしていた
         */
        const before = attempts[i - 1]!.hardware;
        if (attempt.hardware !== before) {
          setStep(
            jobId,
            `${wayName(before)} でエンコードできなかったため、${wayName(attempt.hardware)} でやり直します (${codec})`,
          );
        }
      }
      skip = inputSkip(attempt.seek, encodeOptions.videoStart);
      // ロゴの点は読むたびに一から数える (落ちた回の途中までを持ち越さない)
      const want = extra.analysis ? reading?.want() : undefined;
      const reader = want === undefined ? undefined : scanReader(want);
      // 起動できずに投げたときも、書き出しの一時フォルダは片付ける
      const pending = runFfmpeg(
        jobId,
        report,
        sourceTs,
        working,
        recording.audio_type,
        attempt.seek,
        codec,
        {
          ...encodeOptions,
          hardware: attempt.hardware,
          ...(want === undefined ? {} : { analysis: reader?.outputs ?? [] }),
        },
        reader,
      );
      result = await pending.catch((error) => {
        reader?.result(-1, "");
        throw error;
      });
      if (result.code === 0) {
        if (reader !== undefined)
          found = reader.result(0, "", measured.duration - skip);
        break;
      }
      // 落ちた回の書き出しは捨てる (一時ファイルを片付けるだけ)
      reader?.result(result.code, "");
    }
    /** 映像まで読めたか。探さずに再エンコードしたら音だけ読み直す */
    let video = true;
    // 探さずにエンコードし直すのはソフトウェアで。H.265 はソフトウェアが無いので、いちばん先の GPU で
    const plain = software ? undefined : attempts[0]?.hardware;
    if (
      result.code !== 0 &&
      extra.analysis &&
      reading !== null &&
      !canceled.has(jobId) &&
      (software || plain !== undefined)
    ) {
      setStep(jobId, `CM を探さずにエンコードし直します (${codec})`);
      skip = inputSkip(null, encodeOptions.videoStart);
      result = await runFfmpeg(
        jobId,
        report,
        sourceTs,
        working,
        recording.audio_type,
        null,
        codec,
        { ...encodeOptions, hardware: plain },
      );
      if (result.code === 0 && !canceled.has(jobId)) {
        // 音だけ読み直して、CM の尺だけで決める (音のデコードだけなので軽い)
        setStep(jobId, "無音を探しています");
        const audio = await scan(sourceTs, {
          video: false,
          audio: true,
          before: inputArgs(skip, encodeOptions.probeLead ?? 0),
          signal,
          timeoutMs: config.cmDetectTimeout,
        });
        found = audio.code === 0 ? audio : null;
        video = false;
      }
    }
    return { result, found, skip, video };
  };

  /**
   * 枠を取ってから 1 本エンコードする (`encodeWays`)。枠を待っている間に中止されたら null。
   * **呼んですぐ (await の前に) 枠を取る**。1 本目はジョブの持ち枠をその場で取れるので、CM を探す 1 本目が
   * 枠を待たされることはない
   */
  const encodeInSlot = async (
    codec: HwCodec,
    extra: Parameters<typeof encodeWays>[2],
  ) => {
    const release = await slots.acquire(jobId, signal);
    if (release === null) return null;
    if (canceled.has(jobId)) {
      release();
      return null;
    }
    /*
     * **段階をエンコードに戻す。** 枠を待っている間に 1 本目が「CM の境目を決めています」(cm) に
     * 進んでいると、エンコードしている間ずっと「CM 検出中」と出る
     */
    if (encoding === 0)
      setPhase(jobId, "encode", `${codec} でエンコードしています`);
    encoding++;
    try {
      return await encodeWays(codec, workingOf(codec), extra);
    } finally {
      encoding--;
      release();
    }
  };

  /**
   * エンコードしたものにチャプターを書き足す (再エンコードしない。中身はそのまま写すだけ)。チャプターは
   * エンコードしたものの 0 秒に合わせて書く。ファイルはコーデックごと (同時に書き足すので、1 つを取り合わない)。
   * 書き足せたら作業ファイルと差し替える
   */
  const addChapters = async (working: string, skip: number): Promise<void> => {
    const file = `${working}.chapters.txt`;
    const output = `${working}.post`;
    const { cm, duration } = own(skip);
    writeFileSync(file, chapterMetadata(cm, duration));
    const code = (await run(chapterArgs(working, file, output), { signal }))
      .code;
    removeIfExists(file);
    if (code === 0 && existsSync(output)) {
      renameSync(output, working);
      return;
    }
    removeIfExists(output);
    console.error(
      "[cm] チャプターを書き足せませんでした。チャプター無しで置きます",
    );
  };

  /** エンコードし終えた 1 本。`skip` はこの 1 本で先頭から捨てた長さ */
  interface Made {
    codec: HwCodec;
    working: string;
    skip: number;
    outTimeUs: number;
  }

  /** エンコードする。落ちたら理由を控えて null (ほかのコーデックは止めない) */
  const encodeCodec = async (codec: HwCodec, first: boolean) => {
    const done = await encodeInSlot(codec, {
      analysis: first && reading !== null,
    });
    if (done === null || canceled.has(jobId)) return null;
    if (done.result.code !== 0) {
      failures.push({ codec, reason: done.result.stderrTail });
      return null;
    }
    return done;
  };

  /** 仕上げる。CM があればチャプターを書き足す */
  const finish = async (made: Made): Promise<Made | null> => {
    if (detection === null || detection.cm.length === 0) return made;
    await addChapters(made.working, made.skip);
    return canceled.has(jobId) ? null : made;
  };

  /**
   * 1 本目。CM を一緒に探し、エンコードし終えたら境目を決め、仕上げる。ほかのコーデックはこれが終わるのを待ってから
   * 仕上げる (境目が要る)。1 本目が落ちたら CM は分からないまま (ほかは CM 無しで置く。
   * あとから「CM 検出をやり直す」でチャプターを入れられる)
   */
  const [lead, ...rest] = codecs as [HwCodec, ...HwCodec[]];
  const firstTask = (async (): Promise<Made | null> => {
    const done = await encodeCodec(lead, true);
    if (done === null) return null;
    if (reading !== null) {
      stage("cm", "CM の境目を決めています");
      detection = await decide(
        reading,
        done.found,
        done.skip,
        done.video,
        encodeOptions.probeLead ?? 0,
      );
      if (detection.material !== undefined)
        saveMaterial(recording.id, detection.material);
      saveVideoLoss(recording.id, detection.material);
      saveCm(recording.id, detection);
      setStep(jobId, `CM ${detection.cm.length} 箇所 (${detection.note})`);
    }
    if (canceled.has(jobId)) return null;
    return finish({
      codec: lead,
      working: workingOf(lead),
      skip: done.skip,
      outTimeUs: done.result.outTimeUs,
    });
  })();
  const otherTasks = rest.map(async (codec): Promise<Made | null> => {
    const done = await encodeCodec(codec, false);
    await firstTask;
    if (done === null || canceled.has(jobId)) return null;
    return finish({
      codec,
      working: workingOf(codec),
      skip: done.skip,
      outTimeUs: done.result.outTimeUs,
    });
  });
  // 1 本が投げても、ほかが終わるまで待ってから畳む (動いている ffmpeg と作業ファイルを残さない)
  const settledTasks = await Promise.allSettled([firstTask, ...otherTasks]);
  const thrown = settledTasks.find((task) => task.status === "rejected");
  if (thrown !== undefined) {
    cleanup();
    throw thrown.reason;
  }
  const made = settledTasks
    .map((task) => (task.status === "fulfilled" ? task.value : null))
    .filter((m): m is Made => m !== null);

  // 出来かけを捨てるだけ。元のファイルには触らない
  if (canceled.has(jobId)) {
    cleanup();
    return finishCanceled(jobId, null);
  }
  /** 失敗の理由。1 本だけ選んでいたらそのまま、いくつも選んでいたらコーデックの名前を添える */
  const failure =
    failures.length === 0
      ? null
      : codecs.length === 1
        ? failures[0]!.reason
        : failures
            .map(({ codec, reason }) => `${CODEC_LABEL[codec]}: ${reason}`)
            .join("\n");
  if (made.length === 0) {
    cleanup();
    fail(jobId, recording, failure ?? "エンコードできませんでした");
    return;
  }

  /*
   * **ここで初めて置き場所を決める。**
   *
   * 同じ番組の別の録画が先に置き終えていれば、`encodedPath` がそれを見て
   * `[録画ID]` を足した名前を返す。決めてから `renameSync` までの間に
   * `await` を挟まないので、2 本が同じ名前を使うことはない (同じプロセスの中)
   */
  const placed: (Made & { path: string })[] = [];
  for (const m of made) {
    const path = encodedPath(recording, m.codec);
    renameSync(m.working, path);
    placed.push({ ...m, path });
  }
  // 落ちたコーデックの作業ファイルは捨てる
  for (const { codec } of failures) removeWorking(codec);

  /*
   * 主は AV1 → H.265 → H.264 の先頭 (小さいので既定の再生に向く。エンコードした順とは別)。
   * もう一方は H.265 が `hevc_path`、H.264 が `alt_path` (主でないときだけ)
   */
  const ordered = HW_CODECS.flatMap((codec) =>
    placed.filter((p) => p.codec === codec),
  );
  const primary = ordered[0];
  // 1 本もエンコードできなければ上で return しているので、ここに来れば 1 本はある
  if (primary === undefined)
    throw new Error("エンコード済みのファイルがありません");
  const secondary = (codec: HwCodec) =>
    ordered.find((p) => p !== primary && p.codec === codec)?.path ?? null;
  const hevc = secondary("hevc");
  const alt = secondary("h264");
  const output = primary.path;

  /*
   * **4K の局の録画 (`.mmts`) の字幕は、エンコードしたものの隣に文字の配置で置く** (`writeCaptions`)。
   * MMT の 4K の局にはデータ放送 (BML) が無い (MMT のデータ放送は HTML5 で、まだ読まない) ので、下の取り出しはしない。
   * TS で送る 4K の局は、字幕を Matroska に写し (`captionArgs`)、データ放送も TS の局と同じく取り出す
   */
  if (tlv) {
    for (const p of placed)
      writeCaptions(
        sidecarPaths(p.path).captions,
        uhdCaptions,
        (Number.isFinite(measured.formatStart) ? measured.formatStart : 0) +
          p.skip,
      );
  }

  /*
   * **decoded を消す前に、元の TS からデータ放送を取り出してサイドカーに置く。**
   * 録画でも d ボタンで出せるように、再生位置つきの変化ログを残す
   * (server/recorded-bml.ts)。付け足しなので、失敗してもエンコードは失敗にしない
   */
  try {
    const changes = tlv
      ? 0
      : await saveRecordedBml(
          sourceTs,
          sidecarPaths(output).dataBroadcast,
          recording,
          // 録画の行に書くもの (`encode_skip`) と同じ。先頭から捨てたぶんを引く
          primary.skip,
        );
    if (changes > 0) {
      console.log(
        `[bml] 録画のデータ放送を保存しました: ${changes} 変化 (録画 ${recording.id})`,
      );
    }
  } catch (error) {
    console.error(
      `[bml] データ放送の取り出しに失敗しました (録画 ${recording.id}): ${error}`,
    );
  }

  /*
   * **サムネイルは元の TS から取る** (復号した TS を消す前に)。エンコードした AV1 をデコードし直すと
   * ソフトウェアデコードで数百コマぶん重い。元の TS の MPEG-2/H.264 なら軽い。
   * 位置は元の TS の時刻で決める (`thumbnailPlace`)。CM があれば本編の最初の区間から取る (CM の映像を避ける)
   */
  const duration = (recording.end_at - recording.start_at) / 1000;
  const content =
    detection !== null && detection.cm.length > 0
      ? own(primary.skip).keep[0]
      : undefined;
  await writeThumbnail(
    output,
    duration,
    {
      source: sourceTs,
      place: thumbnailPlace(duration, {
        skip: primary.skip,
        content:
          content === undefined
            ? null
            : {
                start: content.start + primary.skip,
                end: content.end + primary.skip,
              },
      }),
    },
    uhd,
  );
  /*
   * **もう一方 (H.265・H.264) の隣にも、ポスターとデータ放送の変化ログを複製しておく** (同じもの。ffmpeg を
   * もう一度は回さない)。主を消すと残ったほうが主に繰り上がるので (`files.reconcile`)、
   * そのときも画面のサムネイルとデータ放送が途切れない
   */
  const from = sidecarPaths(output);
  for (const other of [hevc, alt]) {
    if (other === null) continue;
    const to = sidecarPaths(other);
    if (existsSync(from.thumbnail)) copyFileSync(from.thumbnail, to.thumbnail);
    if (existsSync(from.dataBroadcast))
      copyFileSync(from.dataBroadcast, to.dataBroadcast);
  }

  // 復号した TS は作業用。元の TS は残したままなので、やり直せる
  removeIfExists(decoded);

  // 取れなくても致命的ではない
  const size = fileSize(output) ?? 0;

  /*
   * 出来上がりの長さで上書きする。先頭を捨てたぶん元の TS より短い。
   * **出来上がったものを測る** (`out_time` は当てにならない。`encodeProgress`)。測れなかったときだけ ffmpeg の値
   */
  const probed = (await probeVideo(output)).duration;
  const length = Number.isFinite(probed)
    ? probed * 1000
    : primary.outTimeUs / 1000;
  /*
   * **エンコードしている間に録画が消されていたら、置いたものを消して中止にする。** 削除 (`files.deleteRecordingFiles`。
   * 端末の削除の再送も来る) は走っているジョブを待たないので、ここで行に書き戻すと、消した行に置き場のパスが入り、
   * どの片付け (`reconcile` は消していない行だけを見る) も消さないファイルが残る。ここから行を書くまで await を挟まない
   */
  const current = orm()
    .select({ deleted: recordings.deleted_at })
    .from(recordings)
    .where(eq(recordings.id, recording.id))
    .get();
  if (current === undefined || current.deleted !== null) {
    for (const path of [output, hevc, alt]) {
      if (path === null || usedByOther(path, recording.id)) continue;
      removeIfExists(path);
      removeSidecars(path);
      pruneEmptyDirs(path);
    }
    finishCanceled(jobId, null);
    return;
  }
  if (Number.isFinite(length) && length > 0) {
    orm()
      .update(recordings)
      .set({ duration_ms: Math.round(length) })
      .where(eq(recordings.id, recording.id))
      .run();
  }

  // 一部のコーデックだけ落ちたなら、出来たものは置いたうえで失敗にする (理由は落ちたコーデックごと)
  if (failure !== null) fail(jobId, recording, failure);
  else {
    markDone(jobId);
    emit("recordings");
    notify({
      event: "encode.finished",
      text: `エンコードが終わりました: ${recording.name} (${recording.service_name})`,
      recording: recordingSummary(recording),
    });
  }

  // 保存先が入った時点で「視聴可能」になる (recordings.state は生成列)。
  // 主は `output` (AV1 → H.265 → H.264 の先頭)、もう一方は `hevc`・`alt` (主でないときだけ)。
  // 実測したコマ数も一緒に書く。番組詳細のラベルはここからしか出せない
  const fps = encodeOptions.smoothMotion === true ? 60 : 30;
  /*
   * 先頭から捨てた長さも書く。CM 検出をやり直すとき (`runCmJob`) に、元の TS の時刻をエンコードしたものの時刻へ
   * どう直すかを、これで決める。`cm_kept` は空にする (前のバージョンで CM を切ってエンコードした録画を、切らずに再エンコードしたとき)
   */
  const finished = {
    library_path: output,
    hevc_path: hevc,
    alt_path: alt,
    ts_size: size,
    fps,
    cm_kept: null,
    encode_skip: primary.skip,
    updated_at: now(),
  };
  // 落ちたコーデックがあれば元の TS は消さない (再エンコードすれば全部作り直せるように)
  const keep = settings().keepOriginal || failure !== null;
  if (!keep) removeIfExists(recording.ts_path);
  orm()
    .update(recordings)
    .set(keep ? finished : { ...finished, ts_path: null })
    .where(eq(recordings.id, recording.id))
    .run();
}

/**
 * **CM 検出だけやり直す** (録画の詳細の「その他…」→「CM 検出をやり直す」)。再エンコードしない。
 *
 * - 元の TS があれば元の TS から、無ければエンコードしたもの (mkv) から読む。どちらからでもロゴ・切れ目・無音は取れる
 *   (エンコードしたものは映像の大きさが違うので、ロゴは大きさごとに覚えたものを使う。`logo-own.modelFile`)
 * - 境目は入れ物の先頭からの秒で覚える (`cm_ranges`。エンコードするときと同じ物差し)。エンコードしたものから読んだなら
 *   エンコードしたときに捨てた先頭の長さ (`encode_skip`) を足して直す
 * - エンコードしたもののチャプターを差し替える (CM が見つからなければ外す)。`-c copy` で写すだけ
 * - **前のバージョンで CM を切ってエンコードしたもの (`cm_kept`) は戻せない**ので受けない (ボタンの側で断っている。ここは念のため)
 *
 * 待ち行列・中止・進み具合・失敗の通知はエンコードするジョブと同じ (`pump`)
 */
async function runCmJob(jobId: number): Promise<void> {
  const { signal, recording } = startJob(jobId);
  const what = "CM 検出";
  if (recording === undefined) {
    markFailed(jobId, "録画が見つかりません");
    return;
  }
  if (recording.cm_kept !== null) {
    fail(jobId, recording, CM_CUT_ALREADY, what);
    return;
  }
  // 掛かったままの元の TS は復号しない (エンコードするジョブの仕事)。エンコードしたものがあればそちらを読む
  // エンコードせずに置いた録画 (「エンコードしない」) は、置き場の TS が元の TS そのもの (`tsPathOf`)
  const raw = tsPathOf(recording);
  const files = encodedFiles(recording).map((entry) => entry.path);
  /*
   * **4K の録画 (`.mmts`) は、エンコードしたものがあればそちらから読む。** 無ければ MP4 に詰め替えてから読む
   * (`remuxForEncode`。ffmpeg は TLV を読めない)。詰め替えた MP4 の時刻は録画の物差し (`mmts.ts`) と同じなので、
   * 元の TS から読んだときと同じく境目をそのまま覚える
   */
  const tlv = raw !== null && recordedTransport(raw) === "tlv";
  let scratch: string | null = null;
  if (tlv && files.length === 0) {
    setPhase(jobId, "remux", "4K の映像と音声を MP4 に詰め替えています");
    const remuxed = await remuxForEncode(raw, recording, signal);
    if (remuxed === null) return finishCanceled(jobId, null);
    if (!remuxed.ok) {
      fail(jobId, recording, remuxed.reason, what);
      return;
    }
    scratch = remuxed.path;
  }
  const ts =
    scratch ?? (raw !== null && !tlv && !isScrambled(raw) ? raw : null);
  try {
    await detectCm(jobId, signal, recording, ts, files);
  } finally {
    removeIfExists(scratch);
  }
}

/**
 * CM 検出だけやり直す (`runCmJob`) の続き。`ts` は読む元の TS (4K の録画は詰め替えた MP4)。無ければエンコードしたもの (`files`) から読む
 */
async function detectCm(
  jobId: number,
  signal: AbortSignal,
  recording: Recording,
  ts: string | null,
  files: string[],
): Promise<void> {
  const what = "CM 検出";
  const input = ts ?? files[0];
  if (input === undefined) {
    fail(jobId, recording, "CM 検出に使えるファイルがありません", what);
    return;
  }
  emit("recordings");

  /*
   * エンコードしたものの時刻 = 入れ物の先頭からの秒 − エンコードしたときに捨てた長さ。覚えていない (この列を足す前にエンコードした)
   * なら、エンコードするときと同じく元の TS の冒頭の音声だけの区間から出す (再試行で足した分は分からない)
   */
  let skip = recording.encode_skip ?? 0;
  /** 元の TS を測るのは 1 回だけ (先頭を捨てる長さの見積もりと、切ってエンコードしたものかの見分けで使う) */
  let tsProbed: ReturnType<typeof probeVideo> | undefined;
  const probeTs = (path: string) => (tsProbed ??= probeVideo(path));
  if (recording.encode_skip === null && ts !== null) {
    const probed = await probeTs(ts);
    skip = headSkip(
      await probeLeadIn(ts, probed.formatStart, probed.packetStart),
    );
  }
  /*
   * **エンコードしたものが元の TS より明らかに短ければ、切ってエンコードしたもの**とみなして断る。元の TS の時刻で書いた
   * チャプターが合わなくなる。`cm_kept` を覚える前に切ってエンコードした録画もこれで止まる
   */
  if (ts !== null && files[0] !== undefined) {
    const [whole, made] = await Promise.all([
      probeTs(ts),
      probeVideo(files[0]),
    ]);
    if (whole.duration - skip - made.duration > CUT_SHORTER) {
      fail(jobId, recording, CM_CUT_ALREADY, what);
      return;
    }
  }
  /** 読んだものの時刻を入れ物の先頭からの秒に直すぶん。元の TS なら 0 */
  const shift = ts === null ? skip : 0;

  /*
   * **控えておいた材料があれば読み直さない** (`cm-material-store.ts`)。バージョンが合い、ロゴまで当たっていたものだけ。
   * ロゴが使えなかった回は、そのあと覚えたロゴで当たるかもしれないので読み直す
   */
  const stored = loadMaterial(recording.id);
  let detection: CmDetection;
  try {
    if (stored !== null && stored.logo !== null) {
      setPhase(jobId, "cm", "控えておいた材料から決め直しています");
      detection = shiftDetection(decideFromMaterial(stored), stored.offset);
      saveVideoLoss(recording.id, stored);
    } else {
      setPhase(jobId, "cm", "局ロゴを確かめています");
      const span = programSpan(recording);
      const reading = await openCm(input, {
        signal,
        serviceId: recording.service_id,
        programLength: span.programLength,
        programStart: span.programStart - shift,
        onStep: (label) => setStep(jobId, label),
      });
      if (canceled.has(jobId)) return finishCanceled(jobId, null);
      setStep(
        jobId,
        `${ts === null ? "エンコード済みの動画から" : "元の TS から"}無音・場面の切れ目・ロゴを読み取っています`,
      );
      const report = progressReporter(jobId, recording.id, reading.duration);
      // 元の TS はエンコードしたときと同じ長さまで探る (`rereadArgs`)
      const before = rereadArgs(recording, ts !== null);
      const found = await scan(input, {
        ...reading.want(),
        before,
        signal,
        timeoutMs: config.cmDetectTimeout,
        onTime: report,
      });
      if (canceled.has(jobId)) return finishCanceled(jobId, null);
      if (found.code !== 0) {
        fail(
          jobId,
          recording,
          `読み込みに失敗しました (code ${found.code}): ${found.stderr}`,
          what,
        );
        return;
      }
      detection = shiftDetection(
        await reading.decide(found, { skip: 0, before }),
        shift,
      );
      if (detection.material !== undefined)
        saveMaterial(recording.id, detection.material);
      saveVideoLoss(recording.id, detection.material);
    }
  } catch (error) {
    if (canceled.has(jobId)) return finishCanceled(jobId, null);
    fail(jobId, recording, String(error), what);
    return;
  }
  setStep(jobId, `CM ${detection.cm.length} 箇所 (${detection.note})`);

  /*
   * エンコードしたものにチャプターを書き直す。CM が見つからなければ外す。
   * **全部書き終えてから差し替える**。何本か (AV1・H.265・H.264) のうち一部だけ新しくなる状態を残さない。
   * 覚え書き (`cm_ranges`) も差し替えたあとに書く
   */
  const cm = shiftRanges(detection.cm, skip);
  const chapters = cm.length > 0 ? `${input}.${jobId}.chapters.txt` : null;
  if (chapters !== null)
    writeFileSync(chapters, chapterMetadata(cm, detection.duration - skip));
  const outputs = files.map((file) => `${file}.${jobId}.post`);
  const discard = () => {
    for (const output of outputs) removeIfExists(output);
  };
  try {
    for (const [i, file] of files.entries()) {
      const output = outputs[i]!;
      const code = (await run(chapterArgs(file, chapters, output), { signal }))
        .code;
      if (canceled.has(jobId)) {
        discard();
        return finishCanceled(jobId, null);
      }
      if (code !== 0 || !existsSync(output)) {
        discard();
        fail(
          jobId,
          recording,
          `チャプターを書き直せませんでした (code ${code})`,
          what,
        );
        return;
      }
    }
    for (const [i, file] of files.entries()) renameSync(outputs[i]!, file);
  } finally {
    // 投げたときも書きかけ (`.post`) を残さない。片付け (`files.orphan`) も消すが、消すのは書いてから 1 時間経ったあと (`files.SETTLE`)
    discard();
    removeIfExists(chapters);
  }
  saveCm(recording.id, detection);
  markDone(jobId);
  emit("recordings");
  emit("chapters", { recordingId: recording.id } satisfies ChaptersChanged);
}

/** エンコードしたものが元の TS よりこれ以上短ければ、CM を切ってエンコードしたものとみなす (秒。CM は 15 秒から) */
const CUT_SHORTER = 5;

/** CM を切ってエンコードした録画は、エンコードしたものから CM を戻せない。やり直すなら元の TS から再エンコードする */
export const CM_CUT_ALREADY =
  "CM をカットした録画です。CM を検出し直すには再エンコードしてください";

/** 映像コーデックをどれも選んでいない (「エンコードしない」)。エンコードするジョブも、ホームの再エンコードも断る */
export const NO_CODEC =
  "映像コーデックが選ばれていません。設定で選んでください";

/**
 * 段階の中の進み具合 (CM 検出だけやり直すとき)。読んだコマの時刻 ÷ 尺。
 * 書き戻しはエンコード中と同じ間隔まで (細かく書くと WAL が膨らむだけ)
 */
function progressReporter(
  jobId: number,
  recordingId: number,
  duration: number,
): (seconds: number) => void {
  let lastWrite = 0;
  return (seconds) => {
    if (!(Number.isFinite(duration) && duration > 0)) return;
    const at = Date.now();
    if (at - lastWrite < PROGRESS_INTERVAL) return;
    lastWrite = at;
    const percent = Math.min(0.99, Math.max(0, seconds / duration));
    const row = orm()
      .update(encodeJobs)
      .set({ percent })
      .where(eq(encodeJobs.id, jobId))
      .returning({ log: encodeJobs.log })
      .get();
    // エンコードと同じく中身ごと流す (`encode` イベント)。一覧を丸ごと読み直させない
    emit("encode", {
      recordingId,
      percent,
      etaMs: null,
      log: row?.log ?? "",
    } satisfies EncodeProgress);
  };
}

/**
 * 枠の空きぶんだけキューを消化する。録画完了時と定期 tick の両方から呼ばれる。
 * 空きは ffmpeg の本数で数え、動き出したジョブの 2 本目以降のコーデックが枠を待っていれば新しいジョブは始めない (`encode-slots.ts`)
 */
export function pump(): void {
  while (slots.free()) {
    const next = orm()
      .select({
        id: encodeJobs.id,
        kind: encodeJobs.kind,
        attempts: encodeJobs.attempts,
      })
      .from(encodeJobs)
      .where(eq(encodeJobs.state, "queued"))
      .orderBy(encodeJobs.id)
      .limit(1)
      .get();
    if (next === undefined) return;

    // **試し過ぎたジョブは失敗にする。** プロセスごと落とす毒ジョブは running→queued
    // へ戻り続け、id 順なので毎回ここで先頭に来る。上限を超えたら failed に
    // して後ろを進める。failed の確定は runJob を呼ぶ前なので、直後にまた落ちても
    // 同じジョブを取り直すことはない
    if (next.attempts >= config.encodeMaxAttempts) {
      const recording = orm()
        .select(getTableColumns(recordings))
        .from(recordings)
        .innerJoin(encodeJobs, eq(encodeJobs.recording_id, recordings.id))
        .where(eq(encodeJobs.id, next.id))
        .get();
      const what = next.kind === "cm" ? "CM 検出" : "エンコード";
      const reason = `${what}を ${next.attempts} 回試しましたが、完了しませんでした`;
      if (recording === undefined) {
        markFailed(next.id, reason);
        emit("recordings");
      } else {
        // もう動かさないので、この元の TS の中間ファイルもここで片付ける
        const input = encodeSource(recording);
        if (input !== null) clearScratch(input);
        fail(next.id, recording, reason, what);
      }
      continue;
    }

    // 実際に動き出す前に状態を進めておく。次のループが同じジョブを取らないため
    const claimed = orm()
      .update(encodeJobs)
      .set({
        state: "running",
        started_at: now(),
        attempts: sql`${encodeJobs.attempts} + 1`,
      })
      .where(and(eq(encodeJobs.id, next.id), eq(encodeJobs.state, "queued")))
      .returning({ id: encodeJobs.id })
      .get();
    if (claimed === undefined) return;

    const jobId = next.id;
    // ジョブの持ち枠。上の `free` で空きを確かめてから同期で取るので、取り損ねることはない
    slots.open(jobId);
    runningJobs.add(jobId);
    // 待機中が動き出したことも伝える。押した直後に何も変わらないと止まって見える
    emit("recordings");
    void (next.kind === "cm" ? runCmJob(jobId) : runJob(jobId))
      // 中止したあとに投げたものは失敗にしない (中止として畳む)
      .catch((error) =>
        canceled.has(jobId)
          ? finishCanceled(jobId, null)
          : markFailed(jobId, String(error)),
      )
      .finally(() => {
        runningJobs.delete(jobId);
        procs.delete(jobId);
        aborts.delete(jobId);
        canceled.delete(jobId);
        // 中止を押して待っている人に、畳み終わったことを伝える
        wakeStopping(jobId);
        emit("recordings");
        // 持ち枠を返す。空いた枠に次のジョブが入る (`slots` の `onFree` が pump を呼ぶ)
        slots.close(jobId);
      });
  }
}

/**
 * 落ちた時点で running だったジョブを queued に戻す。
 * ffmpeg は親と一緒に終了しているので、出力を捨てて最初からやり直す。
 */
export function requeueOrphanedJobs(): number {
  return affected(
    orm()
      .update(encodeJobs)
      .set({
        state: "queued",
        phase: "encode",
        percent: 0,
        eta_ms: null,
        started_at: null,
      })
      .where(eq(encodeJobs.state, "running")),
  );
}
