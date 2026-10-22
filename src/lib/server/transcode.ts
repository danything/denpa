/**
 * **その場で変換する本数の枠。** 録画を観る人が増えても、サーバの CPU (GPU) を食い潰さないため。
 *
 * | | 数える |
 * | --- | --- |
 * | 録画をエンコード済みと違う形式で流す (`/api/recordings/<id>/stream` のエンコードし直し) | 数える |
 * | 追っかけ再生 (画面・アプリ。H.264 / AV1) | 数える |
 * | ライブ | **数えない** (いつも優先。断らない) |
 * | 詰め替えるだけ (映像を写す)・元の TS をそのまま・音声だけ | 数えない (軽い) |
 *
 * 埋まっていたら断る (503「サーバが混んでいます」)。画面はエンコード済みのファイルか MPEG-2 を勧める。
 *
 * ## 上限は GPU の有無で決め、設定で変えられる
 *
 * 既定は **GPU が無ければ 2、あれば 4** (設定の `transcodeLimit` が null のとき)。GPU の API から
 * 「同時に何本エンコードできるか」を聞く手は無い — denpa が使う Intel QSV / VA-API のドライバはセッション数の
 * 上限を言わない (NVENC の消費者向けの上限もドライバは公開しない)。機材ごとに違うので設定で変えられる。
 * GPU があるかは録画・ライブと同じ印で見る (`hwenc.liveHw`。印を外していれば無いのと同じ)
 */

import { liveHw } from "./hwenc";
import { settings } from "./settings";

/** 既定の本数。GPU が無いとき / あるとき */
export const TRANSCODE_DEFAULT = { cpu: 2, gpu: 4 } as const;

let used = 0;

/** GPU でエンコードできるか (H.264 か AV1 のどちらかに印が付いた使える方式がある) */
function gpuReady(): boolean {
  const allow = settings().hwAllow;
  return liveHw("h264", allow) !== null || liveHw("av1", allow) !== null;
}

/** 自動のときの本数 */
export function transcodeAuto(): number {
  return gpuReady() ? TRANSCODE_DEFAULT.gpu : TRANSCODE_DEFAULT.cpu;
}

/** いまの上限 */
export function transcodeLimit(): number {
  return settings().transcodeLimit ?? transcodeAuto();
}

/** いま変換している本数 */
export function transcodesInUse(): number {
  return used;
}

/**
 * 1 本ぶん枠を取る。**取れたら返す関数を返す** (何度呼んでも 1 回だけ返す)。埋まっていれば null
 */
export function holdTranscode(): (() => void) | null {
  if (used >= transcodeLimit()) return null;
  used++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    used--;
  };
}
