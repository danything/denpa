import { describe, expect, test } from "bun:test";

import { FONT_IMMUTABLE, fontCacheControl, fontCss } from "./font.js";

describe("fontCacheControl", () => {
  test("バージョンが入っている字と合えば1年持たせる", () => {
    expect(fontCacheControl("v2.1", "v2.1")).toBe(FONT_IMMUTABLE);
    expect(FONT_IMMUTABLE).toBe("public, max-age=31536000, immutable");
  });

  test("バージョンの付かない URL は毎回確かめさせる (古い字が残らないように)", () => {
    expect(fontCacheControl(null, "v2.1")).toBe("no-cache");
    expect(fontCacheControl("", "v2.1")).toBe("no-cache");
  });

  test("バージョンが食い違えば毎回確かめさせる", () => {
    expect(fontCacheControl("v2.0", "v2.1")).toBe("no-cache");
  });

  test("入っているバージョンが分からなければ毎回確かめさせる", () => {
    expect(fontCacheControl("v2.1", null)).toBe("no-cache");
    expect(fontCacheControl("", "")).toBe("no-cache");
  });
});

describe("fontCss", () => {
  test("2 つの woff2 を同じファミリ名で名乗らせ、後のほうに範囲を付ける", () => {
    const css = fontCss("v3.6", "U+A1,U+3013-3015,U+20089\n");
    expect(css).toBe(
      '@font-face{font-family:"Denpa Font";src:url("denpa-font.woff2?v=v3.6") format("woff2");font-display:swap}\n' +
        '@font-face{font-family:"Denpa Font";src:url("denpa-font-jisx0213.woff2?v=v3.6") format("woff2");font-display:swap;unicode-range:U+A1,U+3013-3015,U+20089}\n',
    );
  });

  test("範囲が無い・読めないときは基本のファイルだけ。バージョンが無ければ付けない", () => {
    const base =
      '@font-face{font-family:"Denpa Font";src:url("denpa-font.woff2") format("woff2");font-display:swap}\n';
    expect(fontCss("", null)).toBe(base);
    expect(fontCss("", "U+41;}body{color:red")).toBe(base);
  });
});
