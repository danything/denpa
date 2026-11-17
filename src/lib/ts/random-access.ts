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
/** H.264 の I と SI (slice_type を 5 で割った余り) */
const AVC_INTRA = [2, 4];
/** H.265 の IRAP (BLA 16〜18・IDR 19〜20・CRA 21) */
const HEVC_IRAP_FIRST = 16;
const HEVC_IRAP_LAST = 21;

/**
 * H.264 のスライスの slice_type。NAL の先頭の 1 バイトの後ろの first_mb_in_slice・slice_type (どちらも ue(v)) を読む。
 * 読めなければ null。エミュレーション防止の 0x03 は飛ばす
 */
export function avcSliceType(nal: Uint8Array): number | null {
  const bytes: number[] = [];
  let zeros = 0;
  for (let i = 1; i < nal.length && bytes.length < 8; i++) {
    const byte = nal[i]!;
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    bytes.push(byte);
  }
  let bit = 0;
  const readBit = (): number | null => {
    if (bit >= bytes.length * 8) return null;
    const value = (bytes[bit >> 3]! >> (7 - (bit & 7))) & 1;
    bit++;
    return value;
  };
  const ue = (): number | null => {
    let lead = 0;
    for (;;) {
      const b = readBit();
      if (b === null || lead > 31) return null;
      if (b === 1) break;
      lead++;
    }
    let value = 0;
    for (let i = 0; i < lead; i++) {
      const b = readBit();
      if (b === null) return null;
      value = value * 2 + b;
    }
    return 2 ** lead - 1 + value;
  };
  if (ue() === null) return null;
  return ue();
}

/** コマの中のスライスの NAL を順に返す。長さが壊れていれば、そこまで */
function slices(
  codec: NalCodec,
  frame: Uint8Array,
  lengthSize: number,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at + lengthSize < frame.length) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + frame[at + i]!;
    const start = at + lengthSize;
    if (size === 0 || start + size > frame.length) break;
    const nal = frame.subarray(start, start + size);
    const type = codec === "h264" ? nal[0]! & 0x1f : (nal[0]! >> 1) & 0x3f;
    if (codec === "h264" ? type >= 1 && type <= 5 : type <= 31) out.push(nal);
    at = start + size;
  }
  return out;
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
  const nals = slices(codec, frame, lengthSize);
  if (nals.length === 0) return false;
  if (codec === "hevc") {
    const type = (nals[0]![0]! >> 1) & 0x3f;
    return type >= HEVC_IRAP_FIRST && type <= HEVC_IRAP_LAST;
  }
  if (nals.some((nal) => (nal[0]! & 0x1f) === AVC_IDR)) return true;
  return nals.every((nal) => {
    const type = avcSliceType(nal);
    return type !== null && AVC_INTRA.includes(type % 5);
  });
}
