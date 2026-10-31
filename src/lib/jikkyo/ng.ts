/**
 * **NG ワード** (世帯で 1 つの一覧。設定の「連携」の「実況」)。含むコメントは流さない。
 *
 * - 部分一致だけ (正規表現は使わない)。全角・半角、半角カナ、英字の大小、ひらがな・カタカナの違いは同じとみなす
 * - 1 行に 1 語。空の行は無視する。`NG_MAX` 語まで、1 語 `NG_LENGTH` 文字まで (絵文字も 1 文字)
 */

/** 語の数の上限 */
export const NG_MAX = 100;
/** 1 語の長さの上限 (文字) */
export const NG_LENGTH = 40;

/** 比べられるようにそろえる。NFKC (全角・半角・半角カナ) → 小文字 → カタカナをひらがなに */
export function foldText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶヽヾ]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60),
    );
}

/**
 * 欄に書かれたものを語の一覧にする。前後の空白を落とし、空の行と同じ語は外す。
 * 多すぎる・長すぎるものがあれば、その理由 (画面に出す) を返す
 */
export function parseNg(text: string): { words: string[] } | { error: string } {
  const words: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const word = line.trim();
    if (word === "" || words.includes(word)) continue;
    if ([...word].length > NG_LENGTH)
      return { error: `1 語は ${NG_LENGTH} 文字までです` };
    words.push(word);
  }
  if (words.length > NG_MAX)
    return { error: `NG ワードは ${NG_MAX} 語までです` };
  return { words };
}

/** 保存してある値 (JSON の配列) を読む。壊れていれば空。上限を超えたぶんは捨てる */
export function readNg(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  try {
    const raw: unknown = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.trim())
      .filter((word) => word !== "" && [...word].length <= NG_LENGTH)
      .slice(0, NG_MAX);
  } catch {
    return [];
  }
}

/** 語の一覧から、コメントの本文が NG ワードを含むかを返すものを作る */
export function compileNg(words: readonly string[]): (text: string) => boolean {
  const folded = words.map(foldText).filter((word) => word !== "");
  if (folded.length === 0) return () => false;
  return (text) => {
    const target = foldText(text);
    return folded.some((word) => target.includes(word));
  };
}
