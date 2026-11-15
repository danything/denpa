/**
 * **メモリに覚える Map の大きさを抑える。** Map は入れた順に並ぶので、先頭にあるものを古いものとして捨てる
 */

/**
 * **期限の切れたものを捨て、`most` 未満になるまで古いものから捨てる。** 新しいものを 1 つ足す前に呼ぶ
 * (`hc-relay.grant`・`niconico.startLink`・`live.keepLight`・`live.rememberResume`・`tickets.issue`)。
 *
 * `until` は期限の時刻で、`at` がその時刻を過ぎていれば切れている。`most` を渡さなければ、数では捨てない
 */
export function pruneExpired<K, V>(
  map: Map<K, V>,
  until: (value: V) => number,
  at: number,
  most = Number.POSITIVE_INFINITY,
): void {
  for (const [key, value] of map) if (until(value) <= at) map.delete(key);
  dropOldest(map, most - 1);
}

/**
 * **`key` に `value` を覚えて新しい側 (後ろ) へ置き、`most` を超えたら古いもの (先頭) から捨てる。**
 * 同じ `key` を覚え直したときも後ろへ移すので、使ったものを残して長く使っていないものから捨てる
 */
export function keepNewest<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  most: number,
): void {
  map.delete(key);
  map.set(key, value);
  dropOldest(map, most);
}

/** `most` 個になるまで古いものから捨てる */
function dropOldest<K, V>(map: Map<K, V>, most: number): void {
  while (map.size > most) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
