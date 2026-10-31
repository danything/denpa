/** worker へ渡してまだデコードしていない fMP4 の上限 (バイト)。超えたら追いつかないものとして諦める */
export const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** ライブ音声の worker と画面の取り決め。時刻は映像と同じ秒。 */
export interface PcmChunk {
  pts: number;
  sampleRate: number;
  planes: Float32Array<ArrayBuffer>[];
}
export type AudioInput =
  | { type: "load"; base: string }
  | { type: "segment"; init: boolean; epoch: number; bytes: Uint8Array };
export type AudioOutput =
  | { type: "pcm"; epoch: number; chunk: PcmChunk }
  | { type: "ack"; bytes: number }
  | { type: "error"; message: string };

/** PCM の1コマを映像の時計の上に置く。間に合わなかった頭は鳴らし直さず切る。全部過ぎていれば null */
export function audioPlan(
  pts: number,
  duration: number,
  position: number,
  rate: number,
  now: number,
  latency: number,
): { when: number; offset: number; duration: number } | null {
  if (
    ![pts, duration, position, rate, now, latency].every(Number.isFinite) ||
    duration <= 0 ||
    rate <= 0
  )
    return null;
  const intended = now + (pts - position) / rate - Math.max(0, latency);
  const when = Math.max(now + 0.005, intended);
  const offset = (when - intended) * rate;
  if (offset >= duration) return null;
  return { when, offset, duration: duration - offset };
}
