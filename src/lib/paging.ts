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

/**
 * 頭から `head` 件、尻から `tail` 件を切り出す (`Paged`)。重なれば間は無く、全部を `head` に。
 * `rest` は間に残った件数
 */
export function ends<T>(items: T[], head: number, tail: number): { head: T[]; tail: T[]; rest: number } {
    const rest = Math.max(0, items.length - head - tail);
    if (rest === 0) return { head: items, tail: [], rest };
    return { head: items.slice(0, head), tail: tail > 0 ? items.slice(items.length - tail) : [], rest };
}
