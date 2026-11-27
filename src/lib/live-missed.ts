/**
 * **手元の中身を読んでから通知が繋がるまでの間に、読み直す通知が送られていたか** (`live-updates` の `hello`)。
 *
 * `ages` はサーバが繋がったときに送る、名前ごとに最後に送ってから経ったミリ秒 (`events.sinceSent`)。
 * `age` は手元の中身を読み始めてから経ったミリ秒。それより新しい通知が 1 つでもあれば、取りこぼしている。
 * 読めない中身 (古いサーバ) は取りこぼしていないとみなす
 */
export function missedBeforeOpen(
  ages: unknown,
  events: readonly string[],
  age: number,
): boolean {
  if (typeof ages !== "object" || ages === null) return false;
  const sent = ages as Record<string, unknown>;
  return events.some((event) => {
    const ago = sent[event];
    return typeof ago === "number" && ago <= age;
  });
}
