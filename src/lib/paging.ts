import { foldForSearch } from './fold';

/**
 * 絞り込み。**空白で区切ったすべての語を含む**行だけ残す (ルールのキーワードと
 * 同じ読み方)。大文字小文字と全角半角の英数は揃えて比べる。
 *
 * @param query 入力欄の文字列
 * @param text 行を1本の文字列にしたもの (名前・チャンネル・ジャンル…)
 */
export function matches(query: string, text: string): boolean {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = normalize(text);
    return words.every((word) => hay.includes(word));
}

/** 比べる前に揃える。外字を昔の書き方に (`fold.ts`)、NFKC で全角英数を半角に、小文字に */
export function normalize(text: string): string {
    return foldForSearch(text).normalize('NFKC').toLowerCase();
}

/*
 * ---- 少しずつ出す一覧の行数 (`Paged`) ----
 * 数えるだけの所はここに置いて単体テストで見る (`Paged` は `$state` を持つので bun のテストでは動かない)
 */

/** 続きを足したあとの行数。全体を越えない */
export function revealed(shown: number, step: number, length: number): number {
    return Math.min(length, shown + step);
}

/**
 * 頭から `count` 行目までは出すときの行数。開いたときに映したい行が、まだ描いていない所にあるとき。
 * 足す単位 (`step`) に切り上げ (下端の印が、すぐまた鳴らないように)、全体を越えず、いま出している数より減らさない
 */
export function shownUpTo(shown: number, count: number, step: number, length: number): number {
    return Math.min(length, Math.max(shown, Math.ceil(count / step) * step));
}
