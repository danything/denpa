import type { Page } from "@playwright/test";
import {
  captureSockets,
  dataElement,
  expect,
  fakeDataBroadcast,
  feedData,
  goto,
  test,
  wakeControls,
} from "./helpers";

/**
 * **画面で動いてよいスクリプトは、自分の束と SvelteKit の起動だけ**
 * (Content-Security-Policy。docs/architecture.md の「画面で動いてよいもの」、設定は vite.config.ts の `csp`)。
 *
 * 狙いは放送の BML。データ放送のエンジン (`src/lib/bml/`) は `onclick` などを DOM に写さず
 * 自前の VM で動かす。写していないこと、外枠の `pointer-events: none` を外して押しても
 * 放送の文字列が denpa の origin で本物の JS として動かないことを見る (CSP は写し漏れへの備え)。
 */

interface Seen {
  /** 出た CSP 違反 (`effectiveDirective blockedURI`) */
  __csp: string[];
}

/** 違反を控える。**ページのスクリプトより先に**付けたいので init script で */
async function watchViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = window as unknown as Seen;
    seen.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.__csp.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as Seen).__csp);

test.describe("CSP", () => {
  test("画面に CSP が付き、ふだんの画面では何も止められない", async ({
    page,
  }) => {
    await watchViolations(page);
    /*
     * **設定 (録画のしかた・チューナー) は load から Promise を返して後から流す** (ストリーミング)。
     * 流れてくる `<script>` にも nonce が要る (hash にしていたら、ここで止まる)。
     * `goto` は読み込みの終わり (= 流し終わり) まで待つ
     */
    for (const path of [
      "/",
      "/guide",
      "/live",
      "/rules",
      "/settings/recording",
      "/settings/reception",
    ]) {
      const response = await page.goto(path);
      const policy = response?.headers()["content-security-policy"] ?? "";
      expect(policy, path).toContain("script-src-attr 'none'");
      expect(policy, path).toMatch(/script-src 'self' 'nonce-[^']+'/);
      expect(policy, path).not.toContain("unsafe-eval");
      await page.locator('[data-hydrated="true"]').waitFor();
      // app.html の色当て (インラインの1つ) も nonce で通っている
      expect(
        await page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"),
        ),
        path,
      ).toBe("dark");
      expect(await violations(page), path).toEqual([]);
    }
  });

  test("放送の BML の on* は、ページに出ず、押しても動かない", async ({
    page,
  }) => {
    await watchViolations(page);
    await captureSockets(page);

    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    const overlay = page.getByTestId("live-data");
    await wakeControls(page, "live-frame");
    await page.getByTestId("live-data-button").click();
    await expect(overlay).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    await expect
      .poll(async () => Number(await overlay.getAttribute("data-handed")))
      .toBeGreaterThan(0);

    // 放送が書いたことにする罠。動いたら本物の window に印を立てる
    const trap = [
      '<div id="trap" style="left:0px;top:0px;width:320px;height:180px;background-color:#ff0000;" onclick="window.__bmlPwned=1" onfocus="window.__bmlPwned=2">',
      '<p style="left:0px;top:0px;width:320px;height:40px;" onkeydown="window.__bmlPwned=3">trap</p>',
      "</div>",
    ].join("");
    await feedData(page, fakeDataBroadcast(trap));
    await expect
      .poll(async () => (await dataElement(page, "span"))?.text)
      .toBe("trap");

    /*
     * **描いた要素に属性は写さない** (見た目の `style` と、画像の `src`・`alt` だけ)。
     * エンジンは on* を自前の VM で動かす (`f();` の形だけ) ので、ページの JS にはならない
     */
    const attributes = await page.evaluate(() => {
      const names = new Set<string>();
      for (const host of document.querySelectorAll(
        '[data-testid="live-data"] div',
      )) {
        for (const element of host.shadowRoot?.querySelectorAll("*") ?? []) {
          for (const attribute of element.attributes) names.add(attribute.name);
        }
      }
      return [...names];
    });
    expect(
      attributes.filter(
        (name) => name !== "style" && name !== "src" && name !== "alt",
      ),
    ).toEqual([]);

    // 押せるようにして (外枠の pointer-events を外す)、罠の真ん中を本当に押す。キーも打つ
    const box = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(
        '[data-testid="live-data"]',
      );
      if (host !== null) host.style.pointerEvents = "auto";
      for (const mount of host?.querySelectorAll("div") ?? []) {
        for (const span of mount.shadowRoot?.querySelectorAll("span") ?? []) {
          if (span.textContent !== "trap") continue;
          const rect = span.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }
      }
      return null;
    });
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x, box!.y);
    await page.keyboard.press("Enter");

    expect(
      await page.evaluate(
        () => (window as unknown as { __bmlPwned?: number }).__bmlPwned,
      ),
    ).toBeUndefined();
    // そもそも写していないので、CSP が止める出番も無い
    expect(await violations(page)).toEqual([]);
  });
});
