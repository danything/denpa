/**
 * 「この録画を再エンコードできるか」の判定。画面とサーバの両方で使う。
 *
 * 元にできるのは**元の TS だけ**。エンコード済みを元にエンコードし直しても画質は戻らないので、
 * 元が無いものには再エンコードを出さない。
 *
 * 元の TS は必ず作業領域にあり、`ts_path` が指している。引き継いだ録画も同じで、
 * EPGStation 側でエンコードが済んでいなかったものは移行のときに作業領域へ入る。
 */

/** エンコードの元にできるファイル。無ければ null */
export function encodeSource(recording: {
  ts_path: string | null;
}): string | null {
  return recording.ts_path;
}

/**
 * 元の TS。エンコードせずに置いた録画 (「エンコードしない」) は置き場の TS がそれ。無ければ null。
 * 録っている最中のものも返す (伸びている)
 */
export function tsPathOf(recording: {
  ts_path: string | null;
  library_path: string | null;
}): string | null {
  return (
    encodeSource(recording) ??
    (recording.library_path?.endsWith(".mkv") === false
      ? recording.library_path
      : null)
  );
}

/**
 * 配るファイルの名指し (`?source=`)。`ts` = 元の TS、`encoded` = 主のエンコード済み
 * (AV1 → H.265 → H.264 の先頭)、`hevc` = H.265 (主でないとき)、`alt` = H.264 (主でないとき)。
 * 名指しが無ければ「今いいほう」。
 * 配るエンドポイント・アプリ向けの録画一覧・端末に保存で同じ語彙を使う
 */
export type FileSource = "ts" | "encoded" | "hevc" | "alt";

/** クエリの文字を語彙に直す。知らない値は null (= 名指しなし) */
export function parseFileSource(raw: string | null): FileSource | null {
  return raw === "ts" || raw === "encoded" || raw === "hevc" || raw === "alt"
    ? raw
    : null;
}

/**
 * 「CM 検出をやり直す」が使えるか (詳細の「その他…」)。読む元は元の TS、無ければエンコードしたもの。
 *
 * - `hidden` … 読む元が無い (元の TS もエンコードしたものも無い)。項目を出さない
 * - `disabled` + 理由 … 前のバージョンで CM を切ってエンコードしたうえに元の TS も無い。エンコードしたものから CM は戻せないので押せない
 * - `prompt` … 前のバージョンで CM を切ってエンコードしたが元の TS はある。押したら再エンコードを促す (サーバが断る)
 * - `ok`
 */
export function cmRedo(recording: {
  ts_path: string | null;
  library_path: string | null;
  cm_kept: unknown[] | null;
}):
  | { state: "hidden" | "ok" | "prompt" }
  | { state: "disabled"; reason: string } {
  const ts = encodeSource(recording) !== null;
  if (!ts && recording.library_path === null) return { state: "hidden" };
  if (recording.cm_kept === null) return { state: "ok" };
  if (ts) return { state: "prompt" };
  return {
    state: "disabled",
    reason: "CM をカットした録画で、元の TS も無いため検出し直せません",
  };
}
