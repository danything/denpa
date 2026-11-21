/**
 * **そのコマから再生を始めてよいか** (詰め替えの始まりを選ぶ `server/clean-start.ts` と、詰め替えた fMP4 の sync の印を直す `ts/fmp4-marks.ts`)。
 *
 * Matroska のキーフレームの印は、エンコーダが付けたものを写しているだけで、IDR とは限らない。
 * FFmpeg の MediaCodec のエンコーダ (mediacodecenc.c) は、端末のエンコーダが「同期フレーム」と返したコマに
 * そのまま印を付ける。VA-API など (hw_base_encode.c) と x264 (open-gop を使わないとき) は IDR にだけ付ける。
 *
 * **始めてよいのは、デコーダがそのコマだけでデコードできるもの。** macOS の WebKit (VideoToolbox) で確かめた結果
 * (#2884。`.github/workflows/webkit-remux.yml`) に合わせてある。
 *
 * - 印の付いた P のコマ (intra-refresh の回復点) から始めると、MEDIA_ERR_DECODE になる
 * - H.264 の IDR でない I (open GOP の回復点) と、H.265 の後ろに RASL が続く CRA から始めても、エラーにならない。
 *   手前の GOP を参照する先行のコマはデコーダが捨てる
 *
 * 中身は長さ付きの NAL の並び (avcC・hvcC の書き方。Matroska と mp4 はこの形で持つ)
 */

import { BitReader } from "@danything/arib/bits";

import { rbsp } from "#lib/mp4/hevc.js";
export type NalCodec = "h264" | "hevc";

/** NAL の長さを書くバイト数 (avcC の 5 バイト目、hvcC の 22 バイト目の下 2 ビット + 1)。読めなければ null */
export function nalLengthSize(
  codec: NalCodec,
  config: Uint8Array,
): number | null {
  const at = codec === "h264" ? 4 : 21;
  return config.length > at ? (config[at]! & 3) + 1 : null;
}

/** コマの中で最初のスライスの NAL の種類 (H.264 は 1〜5、H.265 は 0〜31)。無い・読めなければ null */
export function sliceType(
  codec: NalCodec,
  frame: Uint8Array,
  lengthSize: number,
): number | null {
  const first = slices(codec, frame, lengthSize).next();
  return first.done === true ? null : nalType(codec, first.value);
}

/** H.264 の IDR */
const AVC_IDR = 5;
/** H.264 の I と SI (slice_type を 5 で割った余り) */
const AVC_INTRA = [2, 4];
/** H.265 の IRAP (BLA 16〜18・IDR 19〜20・CRA 21) */
const HEVC_IRAP_FIRST = 16;
const HEVC_IRAP_LAST = 21;

/**
 * H.264 のスライスの slice_type。NAL の先頭の 1 バイトの後ろの first_mb_in_slice・slice_type (どちらも ue(v)) を読む。
 * 読めなければ null。エミュレーション防止の 0x03 は外す (`rbsp`)。先頭の 16 バイトあれば足りる
 */
export function avcSliceType(nal: Uint8Array): number | null {
  const reader = new BitReader(rbsp(nal.subarray(1, 17)));
  reader.ue();
  const type = reader.ue();
  return reader.overrun ? null : type;
}

/** NAL の種類 (nal_unit_type) */
function nalType(codec: NalCodec, nal: Uint8Array): number {
  return codec === "h264" ? nal[0]! & 0x1f : (nal[0]! >> 1) & 0x3f;
}

/** コマの中のスライスの NAL を順に返す。長さが壊れていれば、そこまで */
function* slices(
  codec: NalCodec,
  frame: Uint8Array,
  lengthSize: number,
): Generator<Uint8Array> {
  let at = 0;
  while (at + lengthSize < frame.length) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + frame[at + i]!;
    const start = at + lengthSize;
    if (size === 0 || start + size > frame.length) return;
    const nal = frame.subarray(start, start + size);
    const type = nalType(codec, nal);
    if (codec === "h264" ? type >= 1 && type <= 5 : type <= 31) yield nal;
    at = start + size;
  }
}

/**
 * **そのコマから再生を始めてよいか** (冒頭の説明)。中身を読めなければ false (始めてよいと言える根拠が無い)。
 *
 * - H.264 は IDR か、スライスが全部 I (SI) のコマ
 * - H.265 は IRAP (IDR・CRA・BLA)。H.265 は IRAP でない I のスライスを読むのに PPS が要るので、IRAP だけにする
 */
export function startable(
  codec: NalCodec,
  lengthSize: number,
  frame: Uint8Array,
): boolean {
  const nals = [...slices(codec, frame, lengthSize)];
  if (nals.length === 0) return false;
  if (codec === "hevc") {
    const type = nalType(codec, nals[0]!);
    return type >= HEVC_IRAP_FIRST && type <= HEVC_IRAP_LAST;
  }
  if (nals.some((nal) => nalType(codec, nal) === AVC_IDR)) return true;
  return nals.every((nal) => {
    const type = avcSliceType(nal);
    return type !== null && AVC_INTRA.includes(type % 5);
  });
}
