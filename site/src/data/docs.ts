/*
 * docs のファイルとサイトの URL の対応。scripts/import-docs.ts (書き出し) と
 * astro.config.ts (サイドバー) の両方が使う。中身ではなく、どのファイルがあるかだけを見る
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { overrides, sidebarGroups } from "./pages.ts";

export const siteDir = fileURLToPath(new URL("../..", import.meta.url));
export const repoDir = join(siteDir, "..");
export const docsDir = join(repoDir, "docs");

/** docs/ にある .md の名前 (拡張子を外したもの)。名前順 */
export function docNames(): string[] {
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** その文書の URL (base の下、前後の / 無し)。README はトップなので空 */
export function slugOf(name: string): string {
  return overrides[name]?.slug ?? (name === "README" ? "" : name);
}

/** サイドバー。pages.ts の組から無いファイルを飛ばし、載っていない docs を最後の組に足す */
export function sidebar(): { label: string; items: { slug: string }[] }[] {
  const names = docNames();
  const listed = new Set(sidebarGroups.flatMap((g) => g.items));
  const rest = names.filter((n) => !listed.has(n));
  return sidebarGroups
    .map((g, i) => ({
      label: g.label,
      items: [
        ...g.items.filter((n) => names.includes(n)),
        ...(i === sidebarGroups.length - 1 ? rest : []),
      ].map((n) => ({ slug: slugOf(n) })),
    }))
    .filter((g) => g.items.length > 0);
}
