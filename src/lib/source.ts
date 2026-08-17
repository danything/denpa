/**
 * 「この録画は録り直せるか」の判定。画面とサーバの両方で使う。
 *
 * 元にできるのは**生TSだけ**。エンコード済みを元に録り直しても画質は戻らないので、
 * 元が無いものには再エンコードを出さない。
 *
 * 生TSは必ず作業領域にあり、`ts_path` が指している。引き継いだ録画も同じで、
 * EPGStation 側でエンコードが済んでいなかったものは移行のときに作業領域へ入る。
 */

/** エンコードの元にできるファイル。無ければ null */
export function encodeSource(recording: { ts_path: string | null }): string | null {
    return recording.ts_path;
}

/**
 * 配るファイルの名指し (`?source=`)。`ts` = 生TS、`encoded` = 主のエンコード済み
 * (両方焼いたときは AV1)、`alt` = もう一方 (H.264)。名指しが無ければ「今いいほう」。
 * 画面 (ダウンロードの口)・再生リンク作り・配る口で同じ語彙を使う
 */
export type FileSource = 'ts' | 'encoded' | 'alt';

/** クエリの文字を語彙に直す。知らない値は null (= 名指しなし) */
export function parseFileSource(raw: string | null): FileSource | null {
    return raw === 'ts' || raw === 'encoded' || raw === 'alt' ? raw : null;
}
