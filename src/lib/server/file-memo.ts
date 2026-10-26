import { statSync } from "node:fs";

/**
 * **ファイルから作ったものを覚えておく。** 同じファイル (パス・大きさ・更新時刻) なら作り直さない。
 * 作っている最中に同じファイルを頼まれたら、同じ結果を待たせる (2本目の ffmpeg を起こさない)。
 *
 * 録画の字幕 (`api/recordings/<id>/captions.json`) が使う。字幕を抜くには ffmpeg が動画を
 * 頭から尻まで読むので、1時間の録画で1秒ほどかかり、その間は再生のための読み込みとディスクを取り合う
 */
export interface FileMemo<T> {
  /** 覚えていればそれを、無ければ `make` で作って返す。ファイルが無ければ覚えずに作る */
  get(path: string, make: () => Promise<T>): Promise<T>;
}

/** @param limit 覚えておく数。超えたら古いものから捨てる */
export function fileMemo<T>(limit: number): FileMemo<T> {
  const held = new Map<string, { key: string; value: T }>();
  const making = new Map<string, Promise<T>>();
  return {
    async get(path, make) {
      let key: string;
      try {
        const stat = statSync(path);
        key = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return make();
      }
      const kept = held.get(path);
      if (kept?.key === key) {
        // 使ったものを後ろへ (古いものから捨てる)
        held.delete(path);
        held.set(path, kept);
        return kept.value;
      }
      const id = `${path}\n${key}`;
      const pending = making.get(id);
      if (pending !== undefined) return pending;
      const run = make().then((value) => {
        held.delete(path);
        held.set(path, { key, value });
        if (held.size > limit) held.delete(held.keys().next().value as string);
        return value;
      });
      making.set(id, run);
      try {
        return await run;
      } finally {
        making.delete(id);
      }
    },
  };
}
