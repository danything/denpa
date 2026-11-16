/**
 * **そのキーフレームから再生を始めてよいか** (詰め替えの始まりを選ぶ。`server/clean-start.ts`)。
 *
 * Matroska のキーフレームの印は、エンコーダが付けたものを写しているだけで、IDR とは限らない。
 * FFmpeg の MediaCodec のエンコーダ (mediacodecenc.c) は、端末のエンコーダが「同期フレーム」と返したコマに
 * そのまま印を付ける。VA-API など (hw_base_encode.c) と x264 (open-gop を使わないとき) は IDR にだけ付ける。
 * 印の付いた IDR でないコマ (H.264 の IDR でない I、H.265 の後ろに RASL が続く CRA) から詰め替えると、
 * 手前のコマを参照するコマが混ざる。
 *
 * 中身は長さ付きの NAL の並び (avcC・hvcC の書き方。Matroska と mp4 はこの形で持つ)
 */

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
  let at = 0;
  while (at + lengthSize < frame.length) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + frame[at + i]!;
    const start = at + lengthSize;
    if (size === 0 || start + size > frame.length) return null;
    const head = frame[start]!;
    if (codec === "h264") {
      const type = head & 0x1f;
      if (type >= 1 && type <= 5) return type;
    } else {
      const type = (head >> 1) & 0x3f;
      if (type <= 31) return type;
    }
    at = start + size;
  }
  return null;
}

/** H.264 の IDR */
const AVC_IDR = 5;
/** H.265 の IDR_W_RADL・IDR_N_LP */
const HEVC_IDR = [19, 20];
/** H.265 の BLA (16〜18) と CRA (21)。後ろに RASL が続かなければ、ここから始めてよい */
const HEVC_IRAP = [16, 17, 18, 21];
/** H.265 の RASL (手前の GOP を参照する先行のコマ) */
const HEVC_RASL = [8, 9];

/**
 * **`key` (キーフレームの印の付いたコマ) から始めてよいか。** `next` はデコードの順で次の映像のコマ (無ければ null)。
 *
 * - H.264 は IDR だけ
 * - H.265 は IDR と、すぐ後ろが RASL でない CRA・BLA。RASL は CRA の直後にデコードの順で並ぶので、次の 1 コマだけ見る
 *
 * 中身を読めなければ false (始めてよいと言える根拠が無い)
 */
export function cleanStart(
  codec: NalCodec,
  lengthSize: number,
  key: Uint8Array,
  next: Uint8Array | null,
): boolean {
  const type = sliceType(codec, key, lengthSize);
  if (type === null) return false;
  if (codec === "h264") return type === AVC_IDR;
  if (HEVC_IDR.includes(type)) return true;
  if (!HEVC_IRAP.includes(type)) return false;
  const after = next === null ? null : sliceType(codec, next, lengthSize);
  return after === null || !HEVC_RASL.includes(after);
}
