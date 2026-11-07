import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  CODEC_LABEL,
  HW_CODECS,
  HW_KIND_LABEL,
  HW_KINDS,
  type HwAllow,
  hwAllowed,
  type HwCodec,
  type HwKind,
} from "../hw";
import { config } from "./config";
import { run } from "./stream";

/**
 * **GPU でエンコードできるか、起動時に ffmpeg に確かめさせる。**
 *
 * `ffmpeg -encoders` に載っているかでは「動くか」は分からないので、`HW_DEVICES`
 * (既定 `/dev/dri/renderD*`) に当たるデバイスを全部探し、**デバイスごとに** VA-API で
 * 3 つのコーデックを `nullsrc` で実際に 1 コマエンコードして確かめる。結果は
 * 設定の「エンコード」に出て、使えるものは自動で使う (コーデックごとのエンコーダ。`settings().hwAllow` (録画)・`liveHwAllow` (ライブ) と
 * 突き合わせるのは `hwChain`)。**Linux では Intel も VA-API だけで、QSV は使わない。** QSV は VA-API の上に
 * かぶさる層で速さは同じ。QSV にしか無い先読みなどは使っておらず、Tiger Lake より前の世代では
 * QSV のランタイムが動かない (docs/encode.md「QSV を使わない理由」)。
 *
 * **Rockchip (RK3588 / RK3588S) は別のデバイス** (`/dev/mpp_service`。`config.rkmppDevice`)。あれば
 * そのデバイスで h264_rkmpp / hevc_rkmpp を同じく 1 コマ試す (RK3588 は AV1 をエンコードできないので H.264 と H.265 だけ)。
 * 画質の決め方は `hwBitrate`。
 *
 * **NVIDIA の GPU も別のデバイス** (`/dev/nvidia0`・`/dev/nvidia1` …。`config.nvidiaDir`)。あれば
 * 1 枚ごとに h264_nvenc / hevc_nvenc / av1_nvenc を同じく 1 コマ試す (AV1 は RTX 40 以降だけで、通るかは試しのエンコードで決まる)。
 * ffmpeg は GPU を番号 (`-gpu N`) で受けるので、番号はデバイスファイルの並びから決める (`findNvidia`)。
 * 消費者向けの GPU は同時に開けるエンコードの数に上限がある (`nvencBusy`)。
 *
 * **Windows は OS が別なので、探し方も方式も別** (`probeWindows`)。VA-API も `/dev` のデバイスファイルも無く、
 * GPU の作り手ごとのエンコーダを番号 (`-gpu`・Direct3D 11 のアダプタ) で試す。NVIDIA は NVENC (Linux と同じ引数)、
 * Intel は QSV (libvpl)、AMD は AMF。**Linux の Intel で QSV を使わない理由は、Windows には当てはまらない**
 * (Windows の Intel の GPU で使えるエンコーダは QSV だけ。docs/encode.md「Windows でエンコードする」)。
 *
 * **Mac は VideoToolbox だけ** (`probeMac`)。Apple Silicon のメディアエンジンは 1 つの方式 (`videotoolbox`) で、
 * 番号もデバイスファイルも無い。H.264 と H.265 を 1 コマずつ試す (VideoToolbox に AV1 のエンコーダは無い。
 * docs/encode.md「Mac でエンコードする」)。
 *
 * **H.265 (`hevc`) は GPU でだけエンコードする。** 試しのエンコードは AV1・H.264 と同じく方式ごとに 1 コマ試す。
 * ソフトウェアのエンコーダは無いので、ライブはライブのエンコーダが GPU のときだけ H.265 を出す (`live.liveHevc`)。
 * 追っかけ・その場の変換は H.265 を出さない (回線に合わせて段を下げるときは、GPU があれば出す。`live.rungCodec`)。
 *
 * **ライブ・追っかけ・その場の変換は、録画と別の設定で GPU に載る** (`liveHw`。設定 `liveHwAllow`)。
 * 録画とライブで使う GPU を分けられ、エンコーダをソフトウェアにすれば CPU に戻る。
 * 全体の話は docs/encode.md「GPU でエンコードする」
 */

/** 1 つのデバイス (GPU) で何がエンコードできるか */
export interface HwDevice {
  /** `/dev/dri/renderD128` や `/dev/mpp_service` のようなデバイス */
  path: string;
  /** 画面に出す名前。`renderD128 (Intel)` のように、デバイスの名前と作り手 */
  label: string;
  /** VA-API でエンコードできたコーデック */
  vaapi: HwCodec[];
  /** Rockchip MPP でエンコードできたコーデック (`/dev/mpp_service` のときだけ。H.264 と H.265 だけ試す) */
  rkmpp: HwCodec[];
  /** NVENC でエンコードできたコーデック (`/dev/nvidia0` などのときだけ。Windows では `nvidia0`) */
  nvenc: HwCodec[];
  /** QSV でエンコードできたコーデック (Windows の `qsv0` などのときだけ) */
  qsv: HwCodec[];
  /** AMF でエンコードできたコーデック (Windows の `amf0` などのときだけ) */
  amf: HwCodec[];
  /** VideoToolbox でエンコードできたコーデック (Mac の `videotoolbox` のときだけ。H.264 と H.265 だけ試す) */
  videotoolbox: HwCodec[];
  /**
   * GPU の番号。NVENC は ffmpeg の `-gpu` (Linux は `findNvidia` の並び、Windows は番号を順に試したもの)、
   * QSV・AMF は Direct3D 11 のアダプタの番号 (Windows。`probeWindows`)。それぞれのデバイスにだけある
   */
  gpu?: number;
  /**
   * VA-API の AV1 が **ICQ で通らず CQP でだけエンコードできた**とき `["av1"]`。
   * i965・Mesa は ICQ を持たない (`hwArgs`)。H.264・H.265 はいつも CQP なので入らない
   */
  cqp: HwCodec[];
  /**
   * VA-API のうち、**放送の MPEG-2 を GPU でデコードして、GPU でインタレ解除してエンコードできる**と
   * 確かめられたコーデック (`probeFull`)。ライブはこれなら CPU にフレームを降ろさない (`liveHwArgs`)
   */
  full: HwCodec[];
}

export interface HwEncode {
  /** 一度でも確かめ終わったか。false のうちは画面が `probe()` を待つ (settings/recording/+page.server.ts) */
  probed: boolean;
  /** 見つかったデバイス、`HW_DEVICES` に当たった順 (そのあとに NVIDIA の GPU、Rockchip MPP は最後)。空なら GPU が見えていない */
  devices: HwDevice[];
  /** 画面に出す一言。何が使えて、使えないなら何が理由か */
  message: string;
}

/** エンコードする 1 回ぶんの方式。どのデバイスを、どちらの方式で */
export interface HwWay {
  device: string;
  kind: HwKind;
  /** VA-API の AV1 を ICQ ではなく CQP で指定する (`HwDevice.cqp`)。試しのエンコードの結果から `hwChain` が付ける */
  cqp?: true;
  /** GPU の番号 (`HwDevice.gpu`)。NVENC・QSV・AMF のときだけ */
  gpu?: number;
}

let state: HwEncode = { probed: false, devices: [], message: "" };
let running: Promise<HwEncode> | null = null;

/** いまの見立て。`probe()` が終わるまでは `probed: false` */
export function hwEncode(): HwEncode {
  return state;
}

/**
 * **このコーデックを GPU でエンコードするときに試す方式、順に。** 使える (試しのエンコードが通った)
 * かつ設定で外していない (`allow`) もの。空ならソフトウェアだけ。
 *
 * **デバイスは `turn` で回す。** GPU が 2 枚あって両方が同じコーデックをエンコードできるなら、
 * 1 本エンコードするごとに先頭を入れ替えて、2 本並べてエンコードするとき片方に寄らないようにする。
 * 同じデバイスの中では VA-API → MPP → NVENC (`HW_KINDS` の順)
 */
export function hwChain(
  codec: HwCodec,
  allow: HwAllow,
  turn = 0,
  devices = state.devices,
): HwWay[] {
  const perDevice = devices
    .map((device) =>
      HW_KINDS.filter(
        (kind) =>
          device[kind].includes(codec) &&
          hwAllowed(allow, device.path, kind, codec),
      ).map((kind) => wayOf(device, kind, codec)),
    )
    .filter((ways) => ways.length > 0);
  if (perDevice.length === 0) return [];
  const start = turn % perDevice.length;
  return [...perDevice.slice(start), ...perDevice.slice(0, start)].flat();
}

/**
 * そのデバイスでの方式。AV1 の ICQ が通らなかった VA-API には CQP の印を付ける (`HwDevice.cqp`)。
 * NVENC・QSV・AMF には GPU の番号を添える
 */
function wayOf(device: HwDevice, kind: HwKind, codec: HwCodec): HwWay {
  if (
    (kind === "nvenc" || kind === "qsv" || kind === "amf") &&
    device.gpu !== undefined
  )
    return { device: device.path, kind, gpu: device.gpu };
  return kind === "vaapi" && device.cqp.includes(codec)
    ? { device: device.path, kind, cqp: true }
    : { device: device.path, kind };
}

/**
 * **ffmpeg に渡す、方式ごとの引数** (hwenc と encoder.buildArgs で同じものを使う)。
 *
 * - `device` … 入力より前に置く。GPU のデバイスを開ける
 * - `filter` … 映像フィルタの最後に足す。CPU で作ったフレームを渡すので nv12 に
 *   そろえる。VA-API は GPU へ転送しないので `hwupload` まで付ける
 * - `encoder` … `-c:v` に続くもの
 *
 * **VA-API の画質は、H.264・H.265 は CQP (`-qp`)、AV1 は ICQ (`-global_quality`)。** どちらも
 * ビットレートを決めずに画質で指定する。CQP は量子化の幅を固定し (0〜51)、ICQ は x264 の crf に当たる
 * 「この画質で」の指定 (1〜51)。**値はコーデックごとに、ソフトウェアのエンコードと同じ画質になる所**
 * (`VAAPI_QP`・`AV1_ICQ`)。H.264・H.265 は **qp 24**、AV1 は **ICQ 26** で、どれも下の `VAAPI_SLOW` を足して
 * Arc A310 (iHD) の XPSNR で決めた。H.264・H.265 は同じ XPSNR で CQP のほうが小さく、AV1 は ICQ のほうが良い。
 * 測った値と測り方は docs/encode.md「GPU でエンコードする (VA-API)」
 *
 * **`-global_quality` は `:v` を付けて映像にだけ効かせる。** 付けないとどのストリームにも効き、音のエンコーダが
 * 画質での指定として受け取る。libopus は「画質での指定はできない」で開けずに失敗し、aac は VBR に切り替わる
 * (GPU を挿してエンコードし始めたら、AV1 + Opus の録画とライブが通らなかった)
 *
 * ## 録画は遅くても小さく (`VAAPI_SLOW`)
 *
 * 録画は急がないので、同じ画質で小さくなる指定を足す。**ライブには足さない** (`liveHwArgs`)。
 *
 * - `-compression_level:v 1` … ドライバの品質と速さの段 (iHD は 1〜7 で、渡さないときは 4 と同じ出力)。
 *   1 がいちばん小さい。**これも `:v` を付ける。** 付けないと音のエンコーダにも効き、
 *   libopus はこれを計算の手間 (complexity) として読み、10 から 1 に落とす
 * - `-bf 3 -b_depth 2 -b_qfactor` (H.264・H.265 だけ) … B フレームを 3 枚にして、真ん中の B を
 *   残りの B の参照にするピラミッドにし、B の qp を P の 1.3 倍 (H.265 は 1.4 倍。どちらも +1.25) にする。同じ qp では XPSNR が
 *   少し下がるので、qp を 25 から 24 に上げてある。**`-bf 7 -b_depth 3` は映像が壊れる** (A310 で XPSNR が
 *   14〜35 dB に落ちた) ので使わない。AV1 は B フレームの数や GOP の長さを変えると、大きくなるか
 *   場所によって良し悪しが割れたので既定のまま
 *
 * **どれもドライバが持たなくても落ちない指定なので、試しのエンコード (`probeOnce`) はこのまま試す。**
 * FFmpeg は `-compression_level` を、ドライバが段を持たなければ警告して無視し、段より大きければ丸める
 * (vaapi_encode.c の `vaapi_encode_init_quality`)。B フレームを持たないドライバでは `-bf` を捨てて I と P だけにし、
 * `-b_depth` は B の枚数から決まる深さで頭打ちにする (hw_base_encode.c の `ff_hw_base_init_gop_structure`)。
 * 落ちうるのは段の問い合わせ (`vaGetConfigAttributes`) そのものが失敗したときだけで、同じ問い合わせは
 * レート制御を決めるときにも行うので、それが通るドライバなら通る。
 *
 * **CM を切るときのキーフレーム (`encoder.ts` の `keyframeArgs`) もピラミッドのまま IDR になる。** FFmpeg は
 * 印の付いたコマ (`pict_type = I`) を IDR にすると決め、その 1 つ前のコマを P にして B の並びをそこで閉じる
 * (hw_base_encode.c)。ピラミッドは閉じた並びの中を分けるだけなので、IDR の位置は変わらない
 *
 * ## ICQ を持たないドライバの AV1 は CQP で指定する
 *
 * **i965 (Gemini Lake などの古い Intel)・Mesa (AMD) は ICQ を持たない。** ICQ で試すと落ちて
 * 「エンコードできない」に見えていた (issue #417)。AV1 は ICQ が落ちたら CQP でも試し (`probeOnce`)、
 * 通ればそちらでエンコードする (`HwWay.cqp`)。H.264・H.265 は初めから CQP なので落ちない。
 * **av1_vaapi は `-qp` を受けず、`-global_quality` で量子化の値 (0〜255) を受ける。** `-qp` は黙って無視され、
 * 既定の値で 9〜12 Mbps も出ていた (前の `-qp 120` がそれ。HuC の無い A310 の録画が 2.5GB になった)。
 * 値は **75** (`AV1_CQP`)。
 *
 * **AV1 の CQP は、同じ画質で ICQ より 5 割ほど大きい。** FFmpeg の av1_vaapi は CQP のとき CDEF を使わず
 * (vaapi_encode_av1.c が `enable_cdef` を立てるのは CQP でないときだけ)、ループフィルタの強さも渡さない
 * (ICQ ではドライバのレート制御が決める)。A310 で CQP にすると、CDEF もループフィルタも全部のコマで 0 だった。
 * 75 は ICQ 26 とほぼ同じ XPSNR になる値 (測った値は docs/encode.md)。それでも Mesa (AMD) で AV1 を
 * エンコードできるように残す。**直すには FFmpeg の側を変える必要がある** (CQP でもフィルタを使うように)。
 * CQP は場面に応じて量を変えないので、動きの多い場面で ICQ より大きく、静かな場面で小さくなる
 *
 * ## Rockchip MPP はビットレートで指定する
 *
 * 本家 FFmpeg の h264_rkmpp / hevc_rkmpp は画質での指定 (CQP・qp) を持たず、レート制御は `-rc` の
 * vbr / cbr / avbr だけ。**AVBR** (動きの少ない場面では量を下げる VBR) で、出す映像の大きさと
 * コマ数ごとに決めたビットレートを渡す (`hwBitrate`)。デバイスは開かない (MPP が自分で
 * `/dev/mpp_service` を開く)。CPU で作ったフレームを nv12 で渡す。`-g 250` は x264 の既定の
 * キーフレームの間隔 (keyint 250) に合わせたもの。渡さないと libavcodec の既定の 12 コマになる
 *
 * ## NVENC もビットレートで指定する
 *
 * NVENC は `-global_quality` (ICQ) を受けない (FFmpeg の nvenc.c が断る)。Rockchip MPP と同じ表のビットレートを
 * **VBR** で渡す (`nvencRate`)。GPU は番号 (`-gpu`) で選び、デバイスは開かない。CPU で作ったフレームを nv12 で
 * 渡すのも、`-g 250` も MPP と同じ。`-preset p4` は 7 段 (p1〜p7) の真ん中。遅い段は録画の時間が延びるので、
 * p7 などへ変えるなら実機で測ってから別の変更で行う。**実機では測っていない** (手元に NVIDIA の GPU が無い)
 *
 * ## Windows の Intel (QSV) は ICQ で指定する
 *
 * QSV は `-global_quality` を ICQ (画質で指定。x264 の crf に当たる 1〜51) として受ける。**`-preset veryslow`** (QSV の
 * target usage でいちばん画質が良い段。7 段のうち 1) を付け、値は H.264・H.265 が **23** (ソフトウェアの H.264 の crf 23 と同じ数)、
 * AV1 が **26** (VA-API の AV1 の ICQ と同じ数。`QSV_ICQ`)。**どれも実機では測っていない。**
 * GPU はアダプタの番号で選び (`-init_hw_device qsv=…,child_device=<番号>,child_device_type=d3d11va`)、CPU で作ったフレームを
 * `hwupload` で GPU に渡す (`format=qsv`)。`-global_quality` は `:v` を付けて映像にだけ効かせる (VA-API と同じ理由)。
 * 先読み (`look_ahead`) は H.264 だけで、Arc A310 で足しても変わらなかったので使わない
 * (docs/encode.md「QSV を使わない理由」。Linux の話で、Windows の Intel のドライバでは測っていない)
 *
 * ## Windows の AMD (AMF) はビットレートで指定する
 *
 * h264_amf・hevc_amf・av1_amf にも CQP と QVBR (画質で指定) はあるが、値と画質の対応を実機で測れていないので、
 * NVENC と同じ表のビットレートを渡す。**`-usage high_quality`** (高画質の変換向け)・**`-quality high_quality`** (画質のプリセット)・
 * **`-rc vbr_peak`** (ピークを抑えた VBR。目標は平均、上限は目標の 2 倍)。GPU の世代で落ちうる指定 (`hqvbr`・先読み) は渡さない。
 * GPU は Direct3D 11 のアダプタの番号 (`-init_hw_device d3d11va=…:<番号>`。AMF のエンコーダが、その場にあるデバイスを使う)。
 * CPU で作ったフレームは nv12 で渡す。`-g 250` は同じ。**実機では測っていない** (手元に AMD の GPU が無い)
 *
 * ## Mac (VideoToolbox) もビットレートで指定する
 *
 * VideoToolbox にも画質での指定 (`-q:v`。Apple Silicon の constant quality) はあるが、値と画質の対応を測れていないので、
 * AMF と同じく NVENC と同じ表のビットレートを渡す (`vtRate`。平均を表の値に、上限を 2 倍に)。
 * **`-prio_speed 0`** (速さより画質を取る。macOS 13 から) を付ける。H.264 は **`-profile:v high`**
 * (B フレームと CABAC を使える段。渡さないと何を選ぶかはエンコーダ任せ)。**`-bf 2`** で B フレームを使わせる
 * (同じビットレートで画質が上がる。FFmpeg は枚数を渡さず、使うかどうかだけを VideoToolbox に渡す。既定の 0 では使わない)。
 * **ハードウェアでだけエンコードする。** FFmpeg の videotoolboxenc.c は `-allow_sw` を渡さなければ
 * ハードウェアのエンコーダを求め (`RequireHardwareAcceleratedVideoEncoder`)、無ければ開けずに落ちる。
 * Apple のソフトウェアのエンコーダに黙って倒れず、試しのエンコードが落ちて x264 に戻る。
 * デバイスは開かない (VideoToolbox が自分でメディアエンジンを選ぶ)。CPU で作ったフレームを nv12 で渡す。
 * `-g 250` は同じ。**画質と大きさは測っていない** (CI の Mac のランナーで試しのエンコードが通り、放送に似せた素材をエンコードできるところまで見ている)
 */
export function hwArgs(
  way: HwWay,
  codec: HwCodec,
  picture: Picture = LARGEST,
): { device: string[]; filter: string[]; encoder: string[] } {
  if (way.kind === "rkmpp") {
    return {
      device: [],
      filter: ["format=nv12"],
      encoder: [
        `${codec}_rkmpp`,
        ...rkmppRate(hwBitrate(codec, picture)),
        "-g",
        "250",
      ],
    };
  }
  if (way.kind === "nvenc") {
    return {
      device: [],
      filter: ["format=nv12"],
      encoder: [
        `${codec}_nvenc`,
        ...nvencGpu(way),
        "-preset",
        "p4",
        ...nvencRate(hwBitrate(codec, picture)),
        "-g",
        "250",
      ],
    };
  }
  if (way.kind === "qsv") {
    return {
      device: qsvDevice(way),
      filter: QSV_FILTER,
      encoder: [
        `${codec}_qsv`,
        "-preset:v",
        "veryslow",
        "-global_quality:v",
        String(QSV_ICQ[codec]),
        "-g",
        "250",
      ],
    };
  }
  if (way.kind === "amf") {
    return {
      device: amfDevice(way),
      filter: ["format=nv12"],
      encoder: [
        `${codec}_amf`,
        "-usage",
        "high_quality",
        "-quality",
        "high_quality",
        ...amfRate(hwBitrate(codec, picture)),
        "-g",
        "250",
      ],
    };
  }
  if (way.kind === "videotoolbox") {
    return {
      device: [],
      filter: ["format=nv12"],
      encoder: [
        `${codec}_videotoolbox`,
        ...vtProfile(codec),
        "-prio_speed",
        "0",
        "-bf",
        "2",
        ...vtRate(hwBitrate(codec, picture)),
        "-g",
        "250",
      ],
    };
  }
  return {
    device: [
      "-init_hw_device",
      `vaapi=va:${way.device}`,
      "-filter_hw_device",
      "va",
    ],
    filter: ["format=nv12", "hwupload"],
    encoder: [
      `${codec}_vaapi`,
      ...vaapiQuality(way, codec, VAAPI_QP),
      ...VAAPI_SLOW[codec],
    ],
  };
}

/** VA-API の H.264・H.265 の録画の CQP の qp (0〜51)。決め方は `hwArgs` の説明 */
const VAAPI_QP: Record<Exclude<HwCodec, "av1">, number> = {
  h264: 24,
  hevc: 24,
};

/**
 * ライブの qp。H.265 も H.264 と同じ値 (H.265 では測っていない)。**25 のまま**。25 は B フレームを
 * 2 枚作る FFmpeg の既定で、目標の XPSNR にそろっていた値 (前の録画の値)。ライブは B フレームを作らず
 * (`liveHwArgs`)、どのコマも P の qp で出るので、それより画質が落ちることはない
 */
const LIVE_QP: Record<Exclude<HwCodec, "av1">, number> = {
  h264: 25,
  hevc: 25,
};

/**
 * 録画だけに足す、遅くても小さくなる指定 (`hwArgs` の説明)。`-compression_level` は音のエンコーダも
 * 読むので `:v` を付ける。`-bf`・`-b_depth`・`-b_qfactor` は音のエンコーダが読まない。
 *
 * `-b_qfactor` はコーデックごとに、qp 24 で目標の内でいちばん小さくなる値 (H.264 は 1.3、H.265 は 1.4。
 * 比べた値は docs/encode.md「GPU でエンコードする (VA-API)」)
 */
const VAAPI_SLOW: Record<HwCodec, readonly string[]> = {
  h264: [
    "-compression_level:v",
    "1",
    "-bf",
    "3",
    "-b_depth",
    "2",
    "-b_qfactor",
    "1.3",
  ],
  hevc: [
    "-compression_level:v",
    "1",
    "-bf",
    "3",
    "-b_depth",
    "2",
    "-b_qfactor",
    "1.4",
  ],
  av1: ["-compression_level:v", "1"],
};

/** VA-API の AV1 の ICQ の値。AV1 は CQP より ICQ のほうがはっきり良い (`hwArgs` の説明) */
const AV1_ICQ = 26;

/**
 * ICQ を持たないドライバ (i965・Mesa) で AV1 に渡す CQP の量子化の値 (0〜255)。A310 では ICQ 26 と
 * ほぼ同じ XPSNR (b_qfactor 1.1 で測った) で、FFmpeg が CQP で CDEF とループフィルタを使わないぶん 1.5 倍大きい (`hwArgs` の説明)
 */
const AV1_CQP = 75;

/**
 * VA-API の画質の指定方法。H.264・H.265 は CQP (qp は録画とライブで別。`qp`)、AV1 は ICQ
 * (持たないドライバには CQP)
 */
function vaapiQuality(
  way: HwWay,
  codec: HwCodec,
  qp: Record<Exclude<HwCodec, "av1">, number>,
): string[] {
  if (codec !== "av1") return ["-rc_mode", "CQP", "-qp", String(qp[codec])];
  // AV1 は `-qp` を受けない (黙って無視される)。量子化の値は `-global_quality` で渡す
  return way.cqp === true
    ? ["-rc_mode", "CQP", "-global_quality:v", String(AV1_CQP)]
    : ["-rc_mode", "ICQ", "-global_quality:v", String(AV1_ICQ)];
}

/**
 * 出す映像の大きさとコマ数。Rockchip MPP・NVENC・AMF・VideoToolbox のビットレートを決める (`hwBitrate`)。
 * VA-API・QSV は画質で指定するので見ない
 */
interface Picture {
  /** 出す映像の高さ (画素を正方形に直したあと) */
  height: number;
  /** 60 コマで出す (`encoder.measureSmoothMotion`)。false なら 30 コマ */
  smooth: boolean;
}

/**
 * 大きさが分からないとき。**放送でいちばん重い 1080 の 60 コマ**。小さい映像に多めに渡しても
 * AVBR が静かな場面で量を下げるだけで、足りないよりよい。ライブとその場の変換もこれ
 * (映像が来る前に引数を決めるので大きさを知らない)
 */
const LARGEST: Picture = { height: 1080, smooth: true };

/**
 * **Rockchip MPP・NVENC・AMF・VideoToolbox に渡すビットレート (bit/s)。** H.264 は、今の CPU の H.264 (libx264 medium crf 23) と
 * 同じくらいの画質になる値を、放送を使わずに公開のテスト映像で測って決めた。測り方と測った値は
 * docs/encode.md「画質はビットレートで決める」。**実機の h264_rkmpp・h264_nvenc では測っていない。**
 *
 * AV1 (av1_nvenc) は `AV1_KBPS`、H.265 (hevc_nvenc・hevc_rkmpp) は `HEVC_KBPS`
 */
export function hwBitrate(codec: HwCodec, picture: Picture): number {
  const table =
    codec === "av1" ? AV1_KBPS : codec === "hevc" ? HEVC_KBPS : H264_KBPS;
  // 高さが測れていない (NaN) ときはどの行にも当たらないので、いちばん上 (`LARGEST` と同じ考え)
  const row = table.find((r) => picture.height >= r.height) ?? table[0];
  return (picture.smooth ? row.smooth : row.frame) * 1000;
}

/** H.264 の高さごとの kbit/s (`hwBitrate`)。上から順に、高さがこれ以上なら使う */
const H264_KBPS = [
  { height: 1080, frame: 9000, smooth: 10500 },
  { height: 720, frame: 5500, smooth: 6500 },
  { height: 0, frame: 2500, smooth: 3000 },
] as const;

/**
 * **AV1 と H.265 の高さごとの kbit/s。いまは H.264 と同じ値で、どちらも何も測っていない。**
 * 表はいちばん重い素材で決めていて、下げる根拠が無いため (docs/encode.md「NVIDIA でエンコードする」)。
 * ファイルは H.264 とほぼ同じ大きさになり、浮くぶんは画質に回る。小さくしたいなら、実機で測ってからここを下げる
 */
const AV1_KBPS = H264_KBPS;
const HEVC_KBPS = H264_KBPS;

/**
 * h264_rkmpp / hevc_rkmpp のレート制御の引数。**上限と下限も渡す。** MPP の VBR / AVBR が実際に目指すのは
 * 上限 (`rc:bps_max`) で、渡さないと MPP の既定 (2 Mbit/s の ±25%) のまま残る。
 * 上限は目標の 17/16、下限は 1/16 (MPP のテスト用のコード `mpi_enc_utils.c` が VBR / AVBR に置く値)。
 * AVBR は動きの無い場面で上限に対する下限の割合まで量を下げる
 */
function rkmppRate(bps: number): string[] {
  return [
    "-rc",
    "avbr",
    "-b:v",
    String(bps),
    "-maxrate",
    String(Math.round((bps * 17) / 16)),
    "-minrate",
    String(Math.round(bps / 16)),
  ];
}

/**
 * NVENC のレート制御の引数。**VBR で、平均を表の値に寄せる** (MPP の VBR と違い、NVENC は平均を目指す)。
 * 上限は目標の 2 倍。動きの多い場面に量を寄せられる幅として置いたもので、測っていない。
 * バッファは上限と同じ (FFmpeg の nvenc.c が何も渡さないときに置く値は平均の 2 倍で、それと同じ)
 */
function nvencRate(bps: number): string[] {
  return [
    "-rc",
    "vbr",
    "-b:v",
    String(bps),
    "-maxrate",
    String(bps * 2),
    "-bufsize",
    String(bps * 2),
  ];
}

/** NVENC で使う GPU (`HwWay.gpu`)。番号が無ければ 0 (1 枚目) */
function nvencGpu(way: HwWay): string[] {
  return ["-gpu", String(way.gpu ?? 0)];
}

/** QSV の ICQ の値 (1〜51)。決め方は `hwArgs` の説明。測っていない */
const QSV_ICQ: Record<HwCodec, number> = { h264: 23, hevc: 23, av1: 26 };

/**
 * QSV に CPU のフレームを渡す映像フィルタ。`hwupload` が `-filter_hw_device` の QSV のデバイスへ転送する。
 * `extra_hw_frames` は QSV のエンコーダが先に抱えておくフレームの数 (FFmpeg の QSV の例が 64 を置く値)
 */
const QSV_FILTER = ["format=nv12", "hwupload=extra_hw_frames=64", "format=qsv"];

/**
 * QSV のデバイスを開ける引数。GPU は Direct3D 11 のアダプタの番号 (`HwWay.gpu`。無ければ 0) で選ぶ。
 * libvpl は渡したアダプタに合うランタイムだけを選ぶので、Intel でないアダプタの番号では開けずに落ちる
 */
function qsvDevice(way: HwWay): string[] {
  return [
    "-init_hw_device",
    `qsv=qs,child_device=${way.gpu ?? 0},child_device_type=d3d11va`,
    "-filter_hw_device",
    "qs",
  ];
}

/**
 * AMF のデバイスを開ける引数。AMF のエンコーダは、開いてある Direct3D 11 のデバイスを使う
 * (ffmpeg が `-init_hw_device` で開いたデバイスを、エンコーダが対応する型から選ぶ)。アダプタの番号は `HwWay.gpu`
 */
function amfDevice(way: HwWay): string[] {
  return ["-init_hw_device", `d3d11va=d3d:${way.gpu ?? 0}`];
}

/**
 * AMF のレート制御の引数。**ピークを抑えた VBR (`vbr_peak`) で、平均を表の値に寄せる。**
 * 上限は NVENC と同じく目標の 2 倍で、測っていない。バッファは上限と同じ
 */
function amfRate(bps: number): string[] {
  return [
    "-rc",
    "vbr_peak",
    "-b:v",
    String(bps),
    "-maxrate",
    String(bps * 2),
    "-bufsize",
    String(bps * 2),
  ];
}

/** VideoToolbox の H.264 は High にする (`hwArgs` の説明)。H.265 はエンコーダの既定の Main のまま */
function vtProfile(codec: HwCodec): string[] {
  return codec === "h264" ? ["-profile:v", "high"] : [];
}

/**
 * VideoToolbox のレート制御の引数。**平均を表の値に寄せ、上限を 2 倍に** (NVENC と同じ幅で、測っていない)。
 * `-maxrate` は FFmpeg が VideoToolbox の `DataRateLimits` (1 秒あたりのバイト数) に渡す。
 * FFmpeg の videotoolboxenc.c は `-bufsize` を読まないので渡さない
 */
function vtRate(bps: number): string[] {
  return ["-b:v", String(bps), "-maxrate", String(bps * 2)];
}

/**
 * **NVENC が同時に開けるエンコードの数を超えて降りたか** (ffmpeg の標準エラーの全文か 1 行)。
 *
 * 消費者向けの GeForce は、システム全体で同時に開けるエンコードの数に上限がある (いまの NVIDIA の
 * 一覧では 12)。超えるとドライバはエンコードを開くところ (`nvEncOpenEncodeSessionEx`) で断り、FFmpeg の
 * nvenc.c は `OpenEncodeSessionEx failed: <理由> (<番号>): …` と出す。理由はドライバで違い、新しいものは
 * `out of memory` (NV_ENC_ERR_OUT_OF_MEMORY)、古いものは `incompatible client key`
 * (NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY) を返す。本当に GPU のメモリが尽きたときも前者になるが、
 * どちらも「空けば通る」ので同じに扱ってよい。
 *
 * **これで降りたものは GPU の故障ではない。** その 1 本だけソフトウェアでエンコードし、
 * 方式を覚えて外すことはしない (`live.ts` の `blameLiveHw`)。録画は今までどおり次の方式へ倒れるだけ
 * (`encoder.ts` は落ちた方式を覚えない)。**実機の上限で確かめてはいない** (手元に NVIDIA の GPU が無い)
 */
export function nvencBusy(stderr: string): boolean {
  return NVENC_BUSY.test(stderr);
}

const NVENC_BUSY =
  /OpenEncodeSessionEx failed: (out of memory|incompatible client key)/;

/** ライブで GPU を使うときの方式。`full` ならデコードとインタレ解除まで GPU (`liveHwArgs`) */
export interface LiveHw {
  way: HwWay;
  full: boolean;
}

/**
 * **ライブをどの GPU でエンコードするか。** 無ければ null (ソフトウェア)。
 *
 * 録画と同じ `hwChain` で、印はライブの印 (`liveHwAllow`。呼ぶ側の `live.pickLiveHw` が渡す) を使う。そのうえで
 * **デコードから GPU で通せる方式 (`HwDevice.full`) があれば先に採る。** エンコードするところだけ GPU に
 * 移しても、CPU に残るデコード・bwdif・nv12 への変換で非力な機材は 3 本目が間に合わない
 * (issue #417 の実測: Celeron J4125 で 3 本同時、エンコードするだけ GPU 0.76x / 全部 GPU 1.2x)
 */
export function liveHw(
  codec: HwCodec,
  allow: HwAllow,
  turn = 0,
  devices = state.devices,
): LiveHw | null {
  const chain = hwChain(codec, allow, turn, devices);
  const full = chain.find(
    (way) =>
      way.kind === "vaapi" &&
      devices.some((d) => d.path === way.device && d.full.includes(codec)),
  );
  if (full !== undefined) return { way: full, full: true };
  const first = chain[0];
  return first === undefined ? null : { way: first, full: false };
}

/**
 * **ライブで GPU にエンコードさせる引数。** 録画の `hwArgs` との違いは遅れを作らないこと。
 *
 * - `-bf 0` … B フレームを作らない。作ると必ず 1 枚以上待つ (x264 の `zerolatency` と同じ狙い)
 * - `-async_depth 1` … GPU に先積みしない。既定 (2) のぶんだけ映像が遅れて出る
 * - 録画の遅くても小さくする指定 (`VAAPI_SLOW`。`-compression_level 1` と B フレームのピラミッド) は足さない。
 *   B フレームを作らないので qp は録画の 24 ではなく前のままの 25 (`LIVE_QP`)。AV1 は録画と同じ (`AV1_ICQ`・`AV1_CQP`)。
 *   ライブのソフトウェア (x264 ultrafast・crf 23) とは画質を見比べていない
 *
 * `-g` はライブの側 (`live.ts` の `videoArgs`) が足す。
 *
 * **Rockchip MPP は録画と同じ AVBR を、いちばん重い映像の値で** (`LARGEST`。ライブはコマ数と
 * 大きさが映像の来る前に決まらない)。`-async_depth` は持たない (渡すと使われない引数として
 * ffmpeg が降りる)。MPP の H.264 は B フレームを作らないので `-bf` も要らない。
 *
 * **NVENC も同じ表の、いちばん重い映像の値を VBR で。** 遅れを作らない引数は NVENC の引数で渡す。
 * `-async_depth` は持たず (渡すと降りる)、代わりに `-delay 0` (出来たコマを溜めずにすぐ出す。既定は
 * 作業用の面の数 − 1 コマぶん溜める)。`-tune ll` (低遅延向けの調整)、`-zerolatency 1` (並べ替えの待ちを作らない)、
 * `-bf 0`。preset は `p2` (7 段の速いほうから 2 つ目)。**どれも実機では見ていない**。
 * デコードとインタレ解除を GPU に寄せる (`full`) のは VA-API だけで、NVENC は実機で確かめてから
 *
 * **QSV・AMF (Windows) は低遅延の速い段で、CPU のデコードのまま。** QSV は `-preset veryfast -bf 0 -async_depth 1` (ICQ は録画と同じ値、
 * 段を下げたときは VBR)、AMF は `-usage ultralowlatency -quality speed -rc vbr_latency -async_depth 1`。**どちらも実機では見ていない。**
 * 落ちればソフトウェアでエンコードし直し、その方式を 15 分外す (`live.ts` の `blameLiveHw`)
 *
 * **VideoToolbox (Mac) も低遅延の指定で、CPU のデコードのまま。** `-realtime 1` (実時間でエンコードする)・
 * `-prio_speed 1` (画質より速さ)・`-bf 0`。ビットレートは録画と同じ表の、いちばん重い映像の値。段を下げたときは平均も上限も段の値にする。
 * **実機では見ていない**
 *
 * ## `full`: デコードとインタレ解除も GPU (VA-API だけ)
 *
 * `-hwaccel vaapi -hwaccel_output_format vaapi` で放送の MPEG-2 を GPU でデコードし、フレームを GPU に
 * 置いたまま `deinterlace_vaapi=rate=field` (フィールドごとに 1 コマ。bwdif の既定と同じ
 * 59.94p) に通して、そのままエンコードする。**CPU のフィルタは 1 つも挟めない。** 挟むなら
 * `hwdownload` が要り、降ろしたぶんだけ遅くなる。ライブの映像のフィルタはインタレ解除だけ
 * なので挟むものは無い (`-fpsmax` はコマを間引くだけでフィルタではなく、字幕と音声は
 * 別のストリーム)。インタレ解除の映像は bwdif と変わる (**まだ見比べていない**)。
 *
 * `filter` は「デコードのあとに通すもの全部」。`full` でなければインタレ解除は含まないので、
 * 呼ぶ側が CPU の bwdif を前に足す
 *
 * ## 段を下げた変換 (`cap`)
 *
 * 回線に合わせて下げた段 (`#lib/rungs.ts`) では、`cap` に段の高さとビットレートの上限を渡す。
 *
 * - Rockchip MPP・NVENC は、表の値 (`hwBitrate`) の代わりに段の上限を同じレート制御 (`rkmppRate`・`nvencRate`) に渡す
 * - VA-API は CQP をやめて **VBR で上限を決める** (`-b:v` と `-maxrate:v` に同じ値)。CQP は量を場面に任せるので、回線に収まる保証が無い
 * - `full` なら GPU の上でインタレ解除して 30 コマにし (`rate=frame`)、そのまま `scale_vaapi` で縮める。フレームを CPU に降ろさない。
 *   `full` でなければ、縮めるのは呼ぶ側の CPU の `scale` (`live.ts` の `rungVideo`)
 *
 * `half` はエンコードが遅れたときの 30 コマ (`live.ts` の `videoArgs`)。`full` なら GPU のインタレ解除を `rate=frame` にする
 */
export function liveHwArgs(
  hw: LiveHw,
  codec: HwCodec,
  cap: RungCap | null = null,
  half = false,
): { input: string[]; filter: string[]; encoder: string[] } {
  const { way } = hw;
  const base = hwArgs(way, codec);
  const bps = cap?.bps ?? hwBitrate(codec, LARGEST);
  if (way.kind === "rkmpp") {
    return {
      input: base.device,
      filter: base.filter,
      encoder: [`${codec}_rkmpp`, ...rkmppRate(bps)],
    };
  }
  if (way.kind === "qsv") {
    // 録画の遅くても画質を取る指定 (`-preset veryslow`) はやめ、速い段にして先積みを止める。ICQ は録画と同じ値
    return {
      input: base.device,
      filter: base.filter,
      encoder: [
        `${codec}_qsv`,
        "-preset:v",
        "veryfast",
        ...(cap === null
          ? ["-global_quality:v", String(QSV_ICQ[codec])]
          : ["-b:v", String(bps), "-maxrate", String(bps)]),
        "-bf",
        "0",
        "-async_depth",
        "1",
      ],
    };
  }
  if (way.kind === "amf") {
    return {
      input: base.device,
      filter: base.filter,
      encoder: [
        `${codec}_amf`,
        "-usage",
        "ultralowlatency",
        "-quality",
        "speed",
        "-rc",
        "vbr_latency",
        "-b:v",
        String(bps),
        "-maxrate",
        String(bps * 2),
        "-async_depth",
        "1",
      ],
    };
  }
  if (way.kind === "videotoolbox") {
    return {
      input: base.device,
      filter: base.filter,
      encoder: [
        `${codec}_videotoolbox`,
        ...vtProfile(codec),
        "-realtime",
        "1",
        "-prio_speed",
        "1",
        // 段を下げたときは回線に収まるよう、上限も段の値にする (VA-API・QSV と同じ)
        ...(cap === null
          ? vtRate(bps)
          : ["-b:v", String(bps), "-maxrate", String(bps)]),
        "-bf",
        "0",
      ],
    };
  }
  if (way.kind === "nvenc") {
    return {
      input: base.device,
      filter: base.filter,
      encoder: [
        `${codec}_nvenc`,
        ...nvencGpu(way),
        "-preset",
        "p2",
        "-tune",
        "ll",
        ...nvencRate(bps),
        "-bf",
        "0",
        "-zerolatency",
        "1",
        "-delay",
        "0",
      ],
    };
  }
  // 録画の遅くても小さくする指定 (`VAAPI_SLOW`) は足さない
  const encoder = [
    `${codec}_vaapi`,
    ...(cap === null
      ? vaapiQuality(way, codec, LIVE_QP)
      : ["-rc_mode", "VBR", "-b:v", String(bps), "-maxrate:v", String(bps)]),
    "-bf",
    "0",
    "-async_depth",
    "1",
  ];
  if (!hw.full) return { input: base.device, filter: base.filter, encoder };
  return {
    input: [
      "-init_hw_device",
      `vaapi=va:${way.device}`,
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-hwaccel_device",
      "va",
    ],
    filter:
      cap === null
        ? [`deinterlace_vaapi=rate=${half ? "frame" : "field"}`]
        : ["deinterlace_vaapi=rate=frame", `scale_vaapi=w=-2:h=${cap.height}`],
    encoder,
  };
}

/** 段を下げた変換で GPU に渡すもの (`liveHwArgs`)。映像の高さと、ビットレートの上限 (bit/s) */
interface RungCap {
  height: number;
  bps: number;
}

/**
 * 1 本だけ試しにエンコードする。**時間で切る。** ドライバが固まって返ってこないとき
 * (実機で見たことはないが) に起動が止まらないように
 */
async function tryEncode(args: string[]): Promise<boolean> {
  const result = await run(
    [config.ffmpeg, "-v", "error", "-nostdin", ...args, "-f", "null", "-"],
    {
      timeoutMs: config.hwProbeTimeout,
    },
  );
  return result.code === 0;
}

/** 試しのエンコードの素材。小さく短くする (何が使えるかを見るだけで、速さは測らない) */
const SOURCE = ["-f", "lavfi", "-i", "nullsrc=s=256x256:r=30:d=0.2"];

/** PCI の作り手の番号 → 名前。sysfs から読めたときだけ添える */
const VENDOR: Record<string, string> = {
  "0x8086": "Intel",
  "0x1002": "AMD",
  "0x10de": "NVIDIA",
};

/** デバイスの名前。`renderD128 (Intel)`。作り手は `/sys/class/drm/<デバイス>/device/vendor` から */
function labelOf(path: string): string {
  const name = basename(path);
  try {
    const vendor = readFileSync(
      `/sys/class/drm/${name}/device/vendor`,
      "utf8",
    ).trim();
    return `${name} (${VENDOR[vendor] ?? vendor})`;
  } catch {
    return name;
  }
}

/**
 * `HW_DEVICES` に当たるデバイス。名前順 (renderD128, renderD129, …)。
 * 印は最後の段の `*` だけ (デバイスの名前は決まっている)。**readdir で探す。**
 * デバイスは普通のファイルでもフォルダでもないので、glob の関数は使わない
 */
export function findDevices(pattern = config.hwDevices): string[] {
  const dir = dirname(pattern);
  const name = new RegExp(
    `^${basename(pattern).split("*").map(escapeRegExp).join(".*")}$`,
  );
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => name.test(entry))
    .sort()
    .map((entry) => `${dir}/${entry}`);
}

/**
 * **NVIDIA の GPU のデバイスファイル** (`nvidia0`・`nvidia1` …。`nvidiactl` や `nvidia-uvm` は GPU ではないので外す)。
 * 番号の小さい順に並べ、**並びの位置をそのまま ffmpeg に渡す GPU の番号にする** (`HwDevice.gpu`)。
 *
 * ファイル名の数字は渡さない。コンテナに一部の GPU だけ渡すと (`nvidia1` だけ、など)、CUDA はコンテナから
 * 見える GPU だけを 0 から数え直す。並びが CUDA の数え方とそろうのは、イメージが `CUDA_DEVICE_ORDER=PCI_BUS_ID`
 * (Dockerfile) で CUDA を PCI のバスの順にしていて、ドライバがデバイスファイルの番号もバスの順に振るため
 * (ふつうはそうなるが、2 枚挿しの実機では確かめていない)
 */
export function findNvidia(dir = config.nvidiaDir): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^nvidia\d+$/.test(entry))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map((entry) => `${dir}/${entry}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 探し直す。同時に 2 回押されても ffmpeg は 1 組しか動かさない
 */
export function probe(): Promise<HwEncode> {
  if (running !== null) return running;
  // 終わったら null に戻す。**probeOnce の中で null にしない**。待たずに終わる場合 (デバイスが無い) では
  // 代入より先に終わってしまい、済んだ promise を持ったままになる
  running = probeOnce().finally(() => {
    running = null;
  });
  return running;
}

/**
 * **一度は確かめ終わった見立て。** まだなら (起動した直後) 確かめ終わるのを待つ。確かめ終わっていれば探し直さない。
 * 録画のエンコードはこれを待ってからコーデックと方式を決める (`encoder.ts`)。待たずに決めていた頃は、
 * 起動した直後に溜まっていたジョブが確かめの終わる前に始まり、GPU が無いものとして H.265 を黙って飛ばし、
 * H.264 を CPU でエンコードしていた (起動は確かめを待たずに進む。`runtime.ts`)
 */
export function hwReady(): Promise<HwEncode> {
  return state.probed ? Promise.resolve(state) : probe();
}

/** 何も試していないデバイス */
function emptyDevice(path: string, label: string): HwDevice {
  return {
    path,
    label,
    vaapi: [],
    rkmpp: [],
    nvenc: [],
    qsv: [],
    amf: [],
    videotoolbox: [],
    cqp: [],
    full: [],
  };
}

/** Rockchip MPP で試すコーデック。RK3588 は AV1 をエンコードできない (並びは HW_CODECS と同じ) */
const RKMPP_CODECS = ["hevc", "h264"] as const;

/** VideoToolbox で試すコーデック。VideoToolbox に AV1 のエンコーダは無い (並びは HW_CODECS と同じ) */
const VIDEOTOOLBOX_CODECS = ["hevc", "h264"] as const;

async function probeOnce(): Promise<HwEncode> {
  const devices =
    process.platform === "win32"
      ? await probeWindows()
      : process.platform === "darwin"
        ? await probeMac()
        : await probeLinux();
  await probeFull(devices);
  const next: HwEncode = { probed: true, devices, message: describe(devices) };
  state = next;
  console.log(`[hwenc] ${next.message}`);
  return next;
}

/**
 * **Mac は VideoToolbox で H.264 と H.265 を 1 コマずつ試す。** 行は `videotoolbox` の 1 つだけ
 * (Apple Silicon のメディアエンジンは VideoToolbox が選ぶので、番号もデバイスファイルも無い)。
 * どちらも落ちれば (ハードウェアのエンコーダが見えない) 行は 0 になり、ソフトウェアでエンコードする (Windows と同じ)
 */
async function probeMac(): Promise<HwDevice[]> {
  const path = "videotoolbox";
  const device = emptyDevice(path, `${path} (Apple)`);
  for (const codec of VIDEOTOOLBOX_CODECS) {
    if (await tryWay({ device: path, kind: "videotoolbox" }, codec))
      device.videotoolbox.push(codec);
  }
  return device.videotoolbox.length > 0 ? [device] : [];
}

/** Windows で試す GPU の番号の数。NVENC は ffmpeg の `-gpu`、QSV・AMF は Direct3D 11 のアダプタの番号 */
const WINDOWS_GPUS = 4;

/**
 * **Windows は NVENC・QSV・AMF を、番号ごとに試す。** Windows には `/dev` のデバイスファイルが無く、GPU の一覧を
 * ffmpeg に問い合わせる方法も無いので、番号 0 から順に 1 コマエンコードして、通った番号だけを行にする
 * (`nvidia0`・`qsv0`・`amf0`。Linux の NVIDIA の行 `nvidia0` と同じ名前)。
 *
 * - 番号ごとに **まず H.264 を試し**、落ちたらその番号に GPU は無いとして、AV1・H.265 は試さない。
 *   どのエンコーダも H.264 は持つので、無駄な起動を減らすため。通ったら AV1・H.265 を試す
 * - NVENC は番号がつながっている (0 のあとは 1) ので、落ちた番号で止める。
 *   QSV・AMF は Direct3D 11 のアダプタの番号で、Intel でも AMD でもないアダプタ (NVIDIA・ソフトウェア) が先頭にあることがあるので、
 *   落ちても `WINDOWS_GPUS` 番まで試す
 * - どの番号も落ちた (ドライバが無い・GPU が無い・ffmpeg にエンコーダが無い) ときは行が 0 になり、ソフトウェアでエンコードする
 */
async function probeWindows(): Promise<HwDevice[]> {
  const devices: HwDevice[] = [];
  const makers = [
    { kind: "nvenc", prefix: "nvidia", label: "NVIDIA" },
    { kind: "qsv", prefix: "qsv", label: "Intel" },
    { kind: "amf", prefix: "amf", label: "AMD" },
  ] as const;
  for (const { kind, prefix, label } of makers) {
    for (let gpu = 0; gpu < WINDOWS_GPUS; gpu++) {
      const path = `${prefix}${gpu}`;
      const way: HwWay = { device: path, kind, gpu };
      if (!(await tryWay(way, "h264"))) {
        if (kind === "nvenc") break;
        continue;
      }
      const ok = new Set<HwCodec>(["h264"]);
      for (const codec of HW_CODECS) {
        if (codec !== "h264" && (await tryWay(way, codec))) ok.add(codec);
      }
      const device = { ...emptyDevice(path, `${path} (${label})`), gpu };
      device[kind] = HW_CODECS.filter((codec) => ok.has(codec));
      devices.push(device);
    }
  }
  return devices;
}

async function probeLinux(): Promise<HwDevice[]> {
  const devices: HwDevice[] = [];
  for (const path of findDevices()) {
    const device = emptyDevice(path, labelOf(path));
    for (const codec of HW_CODECS) {
      // H.264・H.265 は初めから CQP で、AV1 は ICQ で試す (`hwArgs` の説明)
      if (await tryWay({ device: path, kind: "vaapi" }, codec)) {
        device.vaapi.push(codec);
      } else if (
        codec === "av1" &&
        (await tryWay({ device: path, kind: "vaapi", cqp: true }, codec))
      ) {
        // ICQ を持たないドライバ (i965・Mesa)。AV1 を CQP でエンコードする
        device.vaapi.push(codec);
        device.cqp.push(codec);
      }
    }
    devices.push(device);
  }
  /*
   * **NVIDIA の GPU は 1 枚ずつ、NVENC だけ試す。** renderD* の行とは別にする。NVIDIA のドライバが
   * renderD* も作っていても、イメージに NVIDIA の VA-API ドライバは無く、そちらの行は使えないと出るだけ。
   * AV1 は RTX 40 以降だけで、それより前の GPU は AV1 の試しのエンコードが落ちて H.264・H.265 だけになる
   */
  for (const [gpu, path] of findNvidia().entries()) {
    const device: HwDevice = {
      ...emptyDevice(path, `${basename(path)} (NVIDIA)`),
      gpu,
    };
    for (const codec of HW_CODECS) {
      if (await tryWay({ device: path, kind: "nvenc", gpu }, codec))
        device.nvenc.push(codec);
    }
    devices.push(device);
  }
  /*
   * **Rockchip MPP は `/dev/mpp_service` があるときだけ、H.264 と H.265 だけ試す** (RK3588 は AV1 をエンコードできない)。
   * renderD* の行とは別の 1 行にする (同じエンコーダが GPU の行にも並ばないように)。
   * あっても MPP が開けなければ (BSP でないカーネル・権限) 試しのエンコードが落ちて、使わないだけ
   */
  if (existsSync(config.rkmppDevice)) {
    const path = config.rkmppDevice;
    const device = emptyDevice(path, `${basename(path)} (Rockchip)`);
    for (const codec of RKMPP_CODECS) {
      if (await tryWay({ device: path, kind: "rkmpp" }, codec))
        device.rkmpp.push(codec);
    }
    devices.push(device);
  }
  return devices;
}

/** 録画と同じ引数で 1 コマエンコードしてみる */
function tryWay(way: HwWay, codec: HwCodec): Promise<boolean> {
  const hw = hwArgs(way, codec);
  return tryEncode([
    ...hw.device,
    ...SOURCE,
    "-vf",
    hw.filter.join(","),
    "-c:v",
    ...hw.encoder,
  ]);
}

/**
 * **デコードから GPU で通せるか** (`HwDevice.full`)。VA-API でエンコードできたコーデックだけ確かめる。
 *
 * 素材は放送と同じ **インタレの MPEG-2** を、その場で CPU で作る (`nullsrc` を
 * `mpeg2video` で。一時ファイルに置くのは、`run` が標準入力を渡さないため)。
 * それをライブと同じ引数 (`liveHwArgs` の `full`) でデコードして、インタレ解除して、エンコードする。
 *
 * **GPU でデコードできなかったら必ず落ちる。** ffmpeg は `-hwaccel` が使えないと黙って CPU で
 * デコードするが、そのフレームは GPU に無いので `deinterlace_vaapi` が受け取れずに降りる。
 * 「通った = GPU でデコードできた」と読んでよい
 */
async function probeFull(devices: HwDevice[]): Promise<void> {
  if (!devices.some((d) => d.vaapi.length > 0)) return;
  const dir = mkdtempSync(join(tmpdir(), "denpa-hw-"));
  try {
    const sample = join(dir, "mpeg2.ts");
    const made = await run(
      [
        config.ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=320x240:r=30000/1001:d=0.3",
        "-c:v",
        "mpeg2video",
        "-flags",
        "+ilme+ildct",
        "-f",
        "mpegts",
        sample,
      ],
      { timeoutMs: config.hwProbeTimeout },
    );
    if (made.code !== 0) {
      console.warn(
        "[hwenc] MPEG-2 の試し素材を作れなかったので、デコードから GPU は使いません",
      );
      return;
    }
    for (const device of devices) {
      for (const codec of device.vaapi) {
        const way = wayOf(device, "vaapi", codec);
        const hw = liveHwArgs({ way, full: true }, codec);
        const ok = await tryEncode([
          ...hw.input,
          "-i",
          sample,
          "-vf",
          hw.filter.join(","),
          "-c:v",
          ...hw.encoder,
        ]);
        if (ok) device.full.push(codec);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * デバイスごとの一言。「VA-API: AV1 (CQP) / H.264」か「GPU でエンコードできません」。
 * ICQ を持たないドライバで AV1 を CQP に落としたときだけ (CQP) を添え (H.264・H.265 はいつも CQP)、デコードから GPU で
 * 通せるもの (ライブで使う) は最後に分けて書く
 */
export function describeDevice(device: HwDevice): string {
  const parts = HW_KINDS.filter((kind) => device[kind].length > 0).map(
    (kind) =>
      `${HW_KIND_LABEL[kind]}: ${device[kind]
        .map((c) =>
          kind === "vaapi" && device.cqp.includes(c)
            ? `${CODEC_LABEL[c]} (CQP)`
            : CODEC_LABEL[c],
        )
        .join(" / ")}`,
  );
  if (device.full.length > 0) {
    parts.push(
      `ライブはデコードから GPU: ${device.full.map((c) => CODEC_LABEL[c]).join(" / ")}`,
    );
  }
  return parts.length > 0
    ? parts.join("、")
    : "GPU でエンコードできません (ドライバが合っていないか、権限がありません)";
}

function describe(devices: HwDevice[]): string {
  if (devices.length === 0) {
    if (process.platform === "win32")
      return "GPU (NVENC・QSV・AMF) でエンコードできるものが見つかりません (ドライバが入っていないか、GPU がありません)。ソフトウェアでエンコードします";
    if (process.platform === "darwin")
      return "VideoToolbox のハードウェアのエンコーダでエンコードできません。ソフトウェアでエンコードします";
    return `GPU が見つかりません (${config.hwDevices} に該当するデバイスも、NVIDIA の GPU (${config.nvidiaDir}/nvidia0 など) も、${config.rkmppDevice} もありません)。ソフトウェアでエンコードします`;
  }
  const usable = devices.filter((d) =>
    HW_KINDS.some((kind) => d[kind].length > 0),
  ).length;
  if (usable === 0)
    return `デバイスが ${devices.length} 個見つかりましたが、どれも GPU でエンコードできません。ソフトウェアでエンコードします`;
  return `デバイスが ${devices.length} 個見つかり、${usable} 個で GPU エンコードできます`;
}
