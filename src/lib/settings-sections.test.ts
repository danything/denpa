import { describe, expect, test } from "bun:test";
import { MOVED_SECTIONS, SETTINGS_GROUPS } from "./settings-sections";

describe("設定の節", () => {
  test("節の名前はグループをまたいでも重ならない (`#<節>` で飛ぶので)", () => {
    const slugs = SETTINGS_GROUPS.flatMap((group) =>
      group.sections.map((section) => section.slug),
    );
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("前の URL の行き先は、どれもあるグループのある節", () => {
    for (const to of Object.values(MOVED_SECTIONS)) {
      const [group, section] = to.split("#");
      const found = SETTINGS_GROUPS.find((g) => g.slug === group);
      expect(found?.sections.some((s) => s.slug === section)).toBe(true);
    }
  });

  test("グループの URL と前の URL は重ならない", () => {
    for (const group of SETTINGS_GROUPS)
      expect(MOVED_SECTIONS[group.slug]).toBeUndefined();
  });
});
