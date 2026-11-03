/**
 * 録画を先へ読んでよいか (`canvas-player.ts` の `room`)。
 *
 * 手元の尺 (`lead`) が `ahead` 秒を超えたら待つ。デコードし始める前は手元の尺が 0 のままなので、
 * 渡したバイト数が `early` を超えたら待つ。
 *
 * `bytesPerSecond` を渡されたときは、バイト数でも抑える。手元の尺は worker がデコードして返してから伸びるので、
 * ネットワークより速く読める元 (端末に保存した録画の Blob) は、その前に尻まで読めてしまう。
 * 観た長さに `ahead` 秒を足したぶんの 1.5 倍までを上限にする。ただし `floor` までは必ず読む
 * (頭と最初のキーフレームが入る量)
 */
export interface ReadAhead {
  /** 手元の尺 (秒。デコードして返ってきたぶん) */
  lead: number;
  /** 手元の尺の上限 (秒) */
  ahead: number;
  /** リクエストし直してから渡したバイト数 */
  fed: number;
  /** デコードし始める前に渡しておく上限 (バイト) */
  early: number;
  /** リクエストし直した位置から観た長さ (秒) */
  played: number;
  /** 読み込み元の平均の速さ (バイト/秒)。渡さなければバイト数では抑えない */
  bytesPerSecond: number | undefined;
  /** `bytesPerSecond` で抑えるときも、ここまでは読む (バイト) */
  floor: number;
}

export function mayRead(state: ReadAhead): boolean {
  const { lead, ahead, fed, early, played, bytesPerSecond, floor } = state;
  if (
    bytesPerSecond !== undefined &&
    fed > Math.max(floor, (played + ahead) * bytesPerSecond * 1.5)
  )
    return false;
  return lead < ahead && (lead > 0 || fed < early);
}
