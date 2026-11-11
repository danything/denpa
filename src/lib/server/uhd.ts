/**
 * **4K の放送 (MMT/TLV。HEVC 2160p・10 ビット・HLG) の映像の扱い。** ライブ (`live.ts` の `uhdVideoArgs`)、
 * 録画のエンコード (`encoder.ts`)、観る画面の変換 (`playback.ts`)、サムネイル (`metadata.ts`) で同じものを使う。
 * 4K の放送は HLG (BT.2020) で送っていると見ている (推定。映像の VUI はスクランブルの中で、実際の放送では読めていない)
 */

/** 4K の映像を縮める高さ。ライブの段 0 と、録画を H.264・H.265 にエンコードするとき */
export const UHD_HEIGHT = 1080;

/**
 * **コマに 4K の放送の色 (HLG・BT.2020) を書き込むフィルタ。** 映像の VUI に頼らない (VUI を持たない素材がある)。
 * SDR に直すとき (`HLG_TO_SDR`) と、録画を HLG のまま AV1 にエンコードするとき (`encoder.ts`) に通す。
 * 書き込んだコマをエンコーダに渡すと、出したものにも同じ色の印が付く (ffmpeg の出力のオプション `-color_trc` などでは付かなかった。
 * Debian の ffmpeg 7.1 と SVT-AV1 で確かめた)
 */
export const HLG_PARAMS =
  "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv";

/**
 * **HLG (BT.2020・10 ビット) を SDR (BT.709・8 ビット) に直すフィルタ。**
 * 光の量に戻して (`npl=100`)、BT.709 の色域に移し、明るいところを hable で丸めてから BT.709 のガンマに戻す。
 * **入力の色の扱いはコマに書き込む** (`setparams`)。映像の VUI に頼ると、色の印の無い映像で zscale が止まる
 * (`no path between colorspaces`)。zscale の `tin`・`pin`・`min` で名指ししても、同じところで止まった (Debian の ffmpeg 7 で確かめた)。
 * 縮めてから通す (画素が 1/4 で済む)
 */
export const HLG_TO_SDR = [
  HLG_PARAMS,
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
  "format=yuv420p",
];
