import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// アクセシビリティの検査 (.github/workflows/pages.yml)。axe で WCAG 2.1 A/AA の規則を調べ、
// 影響が serious・critical の違反があると失敗する。ライト・ダーク × デスクトップ・スマホの各プロジェクトで走る
const pages = [
  "/denpa/",
  "/denpa/install/",
  "/denpa/screens/",
  "/denpa/agent/",
  "/denpa/api/",
  "/denpa/404.html",
];

test.beforeEach(async ({ context }) => {
  // テーマは既定の「自動」のまま。プロジェクトの colorScheme (OS の設定) でライト・ダークが決まる
  // 外 (GitHub など) には出ない
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) =>
    r.abort(),
  );
});

for (const path of pages) {
  test(path, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished)),
    );
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const failures = violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    // 失敗したときに、どの規則がどの要素で引っかかったかを読める形で出す
    const summary = failures
      .map((v) => {
        const nodes = v.nodes
          .map(
            (n) =>
              `    - ${n.target.join(" ")}\n      ${n.failureSummary?.replaceAll("\n", "\n      ")}`,
          )
          .join("\n");
        return `[${v.impact}] ${v.id}: ${v.help}\n  ${v.helpUrl}\n${nodes}`;
      })
      .join("\n\n");
    // 差分には規則の名前だけを出す (中身をそのまま比べると長すぎて読めない)
    expect(
      failures.map((v) => v.id),
      `アクセシビリティの違反:\n\n${summary}`,
    ).toEqual([]);
  });
}
