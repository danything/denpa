/**
 * ブラウザの枠の色 (`<meta name="theme-color">`)。**いつもはテーマの地 (`--dp-bg`)、アンビエントモードで
 * 色を敷いている間はその色** (`AmbientGlow.svelte`)。
 *
 * 効くのは Android の Chrome・Edge の上のツールバー、iOS 15 以降の Safari のステータスバーとタブバー、
 * ホーム画面から開いたアプリ (PWA) のタイトルバー。PC のブラウザはほとんど見ない。
 *
 * 最初の色は `app.html` が描く前に当てる (テーマと同じ。CSS がまだ無いので、そこだけ色を直に書いてある)。
 * テーマを選び直したら `theme.svelte.ts` がここを呼ぶ
 */

/** アンビエントモードの色 (`#rrggbb`)。null ならテーマの地 */
let ambient: string | null = null;

/** `#rgb`・`#rrggbb` を `#rrggbb` にそろえる。読めなければ null */
export function normalizeHex(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text))
    return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  return null;
}

/** いまのテーマの地 (`--dp-bg`)。読めなければ暗いほうの地 */
export function themeBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    "--dp-bg",
  );
  return normalizeHex(value) ?? "#0b0c0f";
}

/** 枠の色を、いまの持ち主 (アンビエントの色かテーマの地) に合わせる */
export function syncThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta === null) return;
  const next = ambient ?? themeBackground();
  if (meta.content !== next) meta.content = next;
}

/** アンビエントモードの色を当てる。null でテーマの地に戻す */
export function setAmbientThemeColor(color: string | null): void {
  ambient = color;
  syncThemeColor();
}
