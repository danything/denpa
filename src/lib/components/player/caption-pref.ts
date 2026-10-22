import type { CaptionLanguage } from "#lib/caption-text.js";

/**
 * 字幕の出し入れと言語の覚え方 (`caption-pref.test.ts`)。**3画面 (ライブ・追っかけ・観る画面) で同じ。端末ごとに覚える** (`keep.ts`)。
 *
 * - 出し入れ … 既定は出す。消したことのある端末だけ消して始まる
 * - 言語 … ISO 639 の3文字 (`eng`) で覚える。第何言語かは番組ごとに違う (英語が第2言語とは限らない) ので、
 *   番号ではなく言葉で覚えて、載っている言語から選び直す。載っていなければ第1言語
 */

/** 出し入れの鍵。`1` / `0` */
export const CAPTION_ON_KEY = "caption-on";
/** 言語の鍵。ISO 639 の3文字 */
export const CAPTION_LANGUAGE_KEY = "caption-language";

/** 覚えていた出し入れ。**既定は出す** */
export function storedCaptionsOn(saved: string | null): boolean {
  return saved !== "0";
}

/**
 * 覚えている言語 (`code`) が載っていればそれ、無ければ第1言語 (載っている中のいちばん若い番号) の番号。
 * 何も分かっていなければ 1
 */
export function pickLanguage(
  languages: CaptionLanguage[],
  code: string | null,
): number {
  const found =
    code === null || code === ""
      ? undefined
      : languages.find((l) => l.code === code);
  if (found !== undefined) return found.index;
  return languages.reduce(
    (least, l) => Math.min(least, l.index),
    languages[0]?.index ?? 1,
  );
}
