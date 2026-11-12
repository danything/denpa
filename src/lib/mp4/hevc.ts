/**
 * HEVC の SPS を読み、MP4 の `hvcC` (HEVCDecoderConfigurationRecord、ISO/IEC 14496-15) を組む。
 * 4K の放送の映像を、エンコードせずに fragmented MP4 へ詰め替えるところ (`mmt.ts`) で使う。
 *
 * SPS から読むのは、`hvcC` に書く値 (プロファイル・レベル・色の形式・ビット深度) と、映像の大きさ (表示の窓を引いたもの) だけ
 */

import { BitReader } from "@danything/arib/bits";

export const NAL_VPS = 32;
export const NAL_SPS = 33;
export const NAL_PPS = 34;

/** NAL ユニットの種類 (先頭 2 バイトのヘッダーの、2〜7 ビット目) */
export function nalType(nal: Uint8Array): number {
  return ((nal[0] ?? 0) >> 1) & 0x3f;
}

/** SPS から読んだもの */
interface HevcSps {
  /** general_profile_space・general_tier_flag・general_profile_idc を詰めた 1 バイト (`hvcC` の 2 バイト目) */
  profileByte: number;
  /** general_profile_compatibility_flags (4 バイト) と constraint の 48 ビット (6 バイト) と general_level_idc (1 バイト) */
  compatibility: Uint8Array;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  /** sps_max_sub_layers_minus1 + 1 */
  subLayers: number;
  temporalIdNesting: boolean;
  /** 表示の窓 (conformance window) を引いた大きさ */
  width: number;
  height: number;
}

/** NAL ユニットの中身から、エミュレーション防止の 0x03 (00 00 03 の 03) を外す */
function rbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

/** SPS の NAL ユニット (2 バイトのヘッダーから) を読む。壊れていれば null */
export function parseSps(nal: Uint8Array): HevcSps | null {
  if (nalType(nal) !== NAL_SPS) return null;
  const data = rbsp(nal.subarray(2));
  const bits = new BitReader(data);
  bits.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = bits.bits(3);
  const temporalIdNesting = bits.bit() === 1;
  // profile_tier_level の general の部分 (12 バイト) は、そのまま hvcC に写す
  const general = bits.slice(bits.at, 96);
  bits.skip(96);
  const profilePresent: number[] = [];
  const levelPresent: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(bits.bit());
    levelPresent.push(bits.bit());
  }
  if (maxSubLayersMinus1 > 0) bits.skip(2 * (8 - maxSubLayersMinus1));
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) bits.skip(88);
    if (levelPresent[i]) bits.skip(8);
  }
  bits.ue(); // sps_seq_parameter_set_id
  const chromaFormat = bits.ue();
  if (chromaFormat === 3) bits.skip(1); // separate_colour_plane_flag
  let width = bits.ue();
  let height = bits.ue();
  if (bits.bit()) {
    // conformance_window。単位は色差の間引きの幅・高さ
    const unitX = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const unitY = chromaFormat === 1 ? 2 : 1;
    const left = bits.ue();
    const right = bits.ue();
    const top = bits.ue();
    const bottom = bits.ue();
    width -= unitX * (left + right);
    height -= unitY * (top + bottom);
  }
  const bitDepthLuma = bits.ue() + 8;
  const bitDepthChroma = bits.ue() + 8;
  if (bits.overrun || width <= 0 || height <= 0) return null;
  return {
    profileByte: general[0]!,
    compatibility: general.subarray(1),
    chromaFormat,
    bitDepthLuma,
    bitDepthChroma,
    subLayers: maxSubLayersMinus1 + 1,
    temporalIdNesting,
    width,
    height,
  };
}

/**
 * `hvcC` の中身 (ボックスのヘッダーを除く)。VPS・SPS・PPS を 1 つずつ入れる。
 * サンプルの中にも VPS・SPS・PPS が来るので (放送は頭出しできる所ごとに送る)、array_completeness は 0 にする (`hev1`)
 */
export function hvcC(
  sps: HevcSps,
  parameterSets: { vps: Uint8Array; sps: Uint8Array; pps: Uint8Array },
): Uint8Array {
  const arrays = [
    [NAL_VPS, parameterSets.vps],
    [NAL_SPS, parameterSets.sps],
    [NAL_PPS, parameterSets.pps],
  ] as const;
  return Uint8Array.from([
    1, // configurationVersion
    sps.profileByte,
    ...sps.compatibility,
    0xf0, // min_spatial_segmentation_idc 0
    0x00,
    0xfc, // parallelismType 0
    0xfc | sps.chromaFormat,
    0xf8 | (sps.bitDepthLuma - 8),
    0xf8 | (sps.bitDepthChroma - 8),
    0x00, // avgFrameRate 0 (書かない)
    0x00,
    // constantFrameRate 0、numTemporalLayers、temporalIdNested、lengthSizeMinusOne 3
    ((sps.subLayers & 0x07) << 3) | (sps.temporalIdNesting ? 0x04 : 0) | 0x03,
    arrays.length,
    ...arrays.flatMap(([type, nal]) => [
      type & 0x3f,
      0x00,
      0x01,
      (nal.length >> 8) & 0xff,
      nal.length & 0xff,
      ...nal,
    ]),
  ]);
}
