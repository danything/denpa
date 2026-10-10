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

/**
 * 「CM検出をやり直す」が使えるか (詳細の「その他…」)。読む元は生TS、無ければ焼いたもの。
 *
 * - `hidden` … 読む元が無い (生TSも焼いたものも無い)。項目を出さない
 * - `disabled` + 理由 … CM を切って焼いたうえに生TSも無い。焼いたものから CM は戻せないので押せない
 * - `prompt` … CM を切って焼いたが生TSはある。押したら再エンコードを促す (サーバが断る)
 * - `ok`
 */
export function cmRedo(recording: {
    ts_path: string | null;
    library_path: string | null;
    cm_kept: unknown[] | null;
}): { state: 'hidden' | 'ok' | 'prompt' } | { state: 'disabled'; reason: string } {
    const ts = encodeSource(recording) !== null;
    if (!ts && recording.library_path === null) return { state: 'hidden' };
    if (recording.cm_kept === null) return { state: 'ok' };
    if (ts) return { state: 'prompt' };
    return { state: 'disabled', reason: 'CMを切って焼いた録画で、生TSも残っていないため検出し直せません' };
}
