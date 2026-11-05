/** 探りの基本の長さ (秒)。`-probesize` はこの長さで 30MB (地上波・BS の 1 局ぶんより多め) */
const PROBE_SECONDS = 15;

/**
 * 延ばす長さの上限 (秒)。早めに始めた録画で本編の開始が先にあっても、先頭を読むのはここまで
 * (`-probesize` で約 270MB)。エンコード・CM 検出の読み直し・音声の探りのたびに読むので、際限なく延ばさない
 */
const LEAD_MOST = 120;

/**
 * 元の TS を開くときの探り (probe) の長さ。
 *
 * チャンネル切り替え直後は前番組の PAT/PMT の残骸が先頭に混ざるため、長めに
 * 探ってから構成を確定させる。元の TS を読む ffmpeg・ffprobe (エンコード、CM 検出の読み直し、音声の探り、
 * サムネイル) で同じ値を使う。1 か所にまとめてあるのは、どれか 1 つだけ変えて挙動が割れないようにするため
 */
export const TS_PROBE = tsProbe(0);

/**
 * 先頭の `lead` 秒を足した探り。**録画の先頭に入った前の番組を越えて、本編まで探る** (#2189)。
 *
 * 開始マージンや早めに始めた録画では、先頭に前の番組が入る。前の番組に字幕が無いと、本編の字幕は
 * 番組が変わって PMT が更新されてから現れるので、探りが本編に届かないと字幕のストリームが見つからない
 */
export function tsProbe(lead: number): readonly string[] {
  const extra = Number.isFinite(lead)
    ? Math.min(Math.max(0, lead), LEAD_MOST)
    : 0;
  const seconds = PROBE_SECONDS + extra;
  return [
    "-analyzeduration",
    String(Math.round(seconds * 1_000_000)),
    "-probesize",
    String(Math.round((seconds * 30_000_000) / PROBE_SECONDS)),
  ];
}
