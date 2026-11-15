/**
 * **期限の切れたものを捨て、`most` 未満になるまで古いものから捨てる。** 新しいものを 1 つ足す前に呼ぶ
 * (`hc-relay.grant`・`niconico.startLink`・`live.keepLight`)。
 *
 * 古いものは先に入れたもの (Map は入れた順に並ぶ)。`until` は期限の時刻で、`at` がその時刻を過ぎていれば切れている。
 * `most` を渡さなければ、数では捨てない
 */
export function pruneExpired<K, V>(
  map: Map<K, V>,
  until: (value: V) => number,
  at: number,
  most = Number.POSITIVE_INFINITY,
): void {
  for (const [key, value] of map) if (until(value) <= at) map.delete(key);
  while (map.size >= most) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
