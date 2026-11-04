/**
 * **その場で変換する本数の枠。** 録画を観る人が増えても、サーバの CPU (GPU) を食い潰さないため。
 *
 * | | 数える |
 * | --- | --- |
 * | 録画をその場で変換して流す (`/api/recordings/<id>/stream`。エンコード済みと違うコーデック・元の TS から) | 数える |
 * | 追っかけ再生 (画面・アプリ。H.264 / AV1) | 数える |
 * | ライブ (段 0) | **数えない** (いつも優先。断らない) |
 * | 回線に合わせて段を下げたライブを新しくエンコードする (`live.rungSlot`。同じ段を共有するなら数えない) | 数える (埋まっていれば段を下げない) |
 * | 詰め替えるだけ (映像を写す)・元の TS をそのまま・音声だけ | 数えない (軽い) |
 *
 * 埋まっていたら断る (503「サーバが混んでいます」)。画面はエンコード済みのファイルか MPEG-2 を勧める。
 *
 * ## 上限は GPU の有無で決め、設定で変えられる
 *
 * 既定は **GPU が無ければ 2、あれば 4** (設定の `transcodeLimit` が null のとき)。GPU の API から
 * 「同時に何本エンコードできるか」を聞く方法は無い。denpa が使う VA-API のドライバはセッション数の
 * 上限を言わず、NVENC の消費者向けの上限 (いまは 12) もドライバには聞けない。機材ごとに違うので設定で変えられる。
 * GPU があるかはライブと同じ印で見る (`liveHwAllow` と `hwenc.liveHw`。印を外していれば無いのと同じ)
 */

import { type HwDevice, hwEncode, liveHw } from "./hwenc";
import { settings } from "./settings";

/** 既定の本数。GPU が無いとき / あるとき */
export const TRANSCODE_DEFAULT = { cpu: 2, gpu: 4 } as const;

let used = 0;

/**
 * GPU でエンコードできるか (H.264 か AV1 のどちらかに、ライブの印が付いた使える方式がある)。
 * 数えるその場の変換と追っかけは、ライブと同じ印 (`liveHwAllow`) で GPU に載る。`devices` はテストで差し替えるときだけ渡す
 */
export function gpuReady(devices: HwDevice[] = hwEncode().devices): boolean {
  const allow = settings().liveHwAllow;
  return (
    liveHw("h264", allow, 0, devices) !== null ||
    liveHw("av1", allow, 0, devices) !== null
  );
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

/** いま空いている本数。上限を下げた直後は負になりうる */
export function transcodeRoom(): number {
  return transcodeLimit() - used;
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
