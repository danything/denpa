/**
 * 同じ `key` の前の仕事が終わってから `task` を始める。前の仕事が失敗しても始める。
 *
 * ページで受け取る保存をやり直すとき、前の試みは abort しても、書きかけの塊が書き終わるまで
 * 続く。待たずに塊を捨てて始めると、捨てたあとに古い塊が書かれて残る (`offline.svelte.ts`)。
 * `task` の失敗は `onError` に渡す (未処理の reject にしない)。
 *
 * @param pending `key` ごとの最後の仕事。呼び出し側が持つ
 */
export function afterPrevious<K>(
  pending: Map<K, Promise<void>>,
  key: K,
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const previous = pending.get(key) ?? Promise.resolve();
  const run: Promise<void> = previous
    .then(task)
    .catch(onError)
    .finally(() => {
      if (pending.get(key) === run) pending.delete(key);
    });
  pending.set(key, run);
  return run;
}
