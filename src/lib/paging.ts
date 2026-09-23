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

/** 比べる前に揃える。NFKC で全角英数を半角に、小文字に */
export function normalize(text: string): string {
    return text.normalize('NFKC').toLowerCase();
}
