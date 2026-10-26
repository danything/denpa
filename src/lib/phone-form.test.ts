import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PHONE_FORM, TABLETOP } from "./phone-form";

/**
 * テーブルトップの条件は CSS の `@media` にも同じ文字で書いてある (CSS には変数で渡せない)。
 * 片方だけ変えるとずれても気付きにくいので、`@media` の行がこの文字を含むことを見る
 */
describe("テーブルトップの条件", () => {
  const FILES = [
    "./components/player/PlayerLayout.svelte",
    "./components/player/PlayerStage.svelte",
    "../routes/live/+page.svelte",
  ];

  test.each(FILES)("%s の @media は TABLETOP と同じ", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    // 整形で改行されることがあるので、空白をつないで見る
    const joined = source.replace(/\s+/g, " ");
    const medias = joined.match(/@media [^{]*posture[^{]*\{/g) ?? [];
    expect(medias.length).toBeGreaterThan(0);
    for (const media of medias) expect(media).toContain(TABLETOP);
  });

  test("スマホの形はテーブルトップを含む", () => {
    expect(PHONE_FORM.split(", ")).toContain(TABLETOP);
  });
});
