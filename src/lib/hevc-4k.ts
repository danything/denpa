/**
 * **4K の局の放送の HEVC を、この端末で再生できるか** (ライブの「放送のまま」。`#lib/live-choice.ts` の `BroadcastCodec`)。
 *
 * MSE が受け取れるか (`isTypeSupported`) に加えて、`mediaCapabilities.decodingInfo` に放送の値 (3840x2160・59.94 コマ・
 * 10 ビット・HLG・BT.2020) を渡して決める。HEVC を受け取れると答えても、4K の 10 ビットをデコードできない端末があるため (推定)。
 * `mediaCapabilities` が無い端末は、受け取れるかだけで決める。画面は 1 回だけ調べて覚える (`live-player.svelte.ts`)。
 * テレビのアプリの `?playable=` の `hevc` も、4K の局では同じ値で確かめたものを送る (docs/api.md「形式をサーバに選ばせる」)
 */

import { BROADCAST_HEVC } from "./live";

/** 放送の 4K の映像 (実機のケーブルの BS4K の MPT。docs/stream.md「4K の局のライブ」) */
export const BROADCAST_HEVC_VIDEO = {
  contentType: BROADCAST_HEVC,
  width: 3840,
  height: 2160,
  framerate: 60000 / 1001,
  // 1 局で約 33Mbit/s (推定)
  bitrate: 33_000_000,
  transferFunction: "hlg",
  colorGamut: "rec2020",
} as const;

/** 調べるのに使うもの。ブラウザでは `MediaSource.isTypeSupported` と `navigator.mediaCapabilities.decodingInfo` */
export interface HevcProbe {
  isTypeSupported: (type: string) => boolean;
  decodingInfo?: (config: {
    type: "media-source";
    video: typeof BROADCAST_HEVC_VIDEO;
  }) => Promise<{ supported: boolean }>;
}

/** 4K の局の放送の HEVC を再生できるか。聞いて失敗したら再生できないとみる */
export async function broadcastHevcPlayable(
  probe: HevcProbe,
): Promise<boolean> {
  if (!probe.isTypeSupported(BROADCAST_HEVC)) return false;
  if (probe.decodingInfo === undefined) return true;
  try {
    const info = await probe.decodingInfo({
      type: "media-source",
      video: BROADCAST_HEVC_VIDEO,
    });
    return info.supported;
  } catch {
    return false;
  }
}
