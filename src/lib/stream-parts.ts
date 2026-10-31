/**
 * 届いた中身を、決まった大きさの塊に分けて渡す。**全部をメモリに抱えない**ための口。
 *
 * 端末に保存するとき (iPhone の Safari のようにページで受け取る道。`offline.svelte.ts`)、
 * 900MB の録画を全部メモリに溜めてから1つの Blob にしていた頃は、Safari のタブが
 * だんだん重くなり、最後は落とされて読み込み直しになっていた。塊ごとに置き場
 * (IndexedDB) へ書いて手放せば、抱えるのは書き込み待ちの1塊ぶんだけになる。
 *
 * 進み具合は**割合が 1% 変わったときだけ**知らせる。届くたびに知らせていた頃は、
 * 数十KB ごとに一覧を描き直していた (900MB で1万回を超える)
 *
 * @param body 届く中身
 * @param partBytes 1塊の大きさ。最後の塊だけはこれより小さい
 * @param onPart 塊が1つ溜まったら呼ぶ。**書き終わるまで次を読まない** (await する)
 * @param total 全体の大きさ (分からなければ null。割合は知らせない)
 * @param onProgress 0〜1 の割合
 * @returns 渡した塊の数と、届いた合計
 */
export async function streamParts(
  body: ReadableStream<Uint8Array>,
  partBytes: number,
  onPart: (part: Blob, index: number) => Promise<void>,
  total: number | null,
  onProgress: (progress: number) => void,
): Promise<{ parts: number; bytes: number }> {
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let parts = 0;
  let bytes = 0;
  let told = -1;

  const flush = async () => {
    if (pendingBytes === 0) return;
    const part = new Blob(pending as BlobPart[]);
    pending = [];
    pendingBytes = 0;
    await onPart(part, parts);
    parts += 1;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending.push(value);
    pendingBytes += value.length;
    bytes += value.length;
    if (pendingBytes >= partBytes) await flush();
    if (total !== null && total > 0) {
      const percent = Math.min(100, Math.floor((bytes / total) * 100));
      if (percent !== told) {
        told = percent;
        onProgress(percent / 100);
      }
    }
  }
  await flush();
  return { parts, bytes };
}
