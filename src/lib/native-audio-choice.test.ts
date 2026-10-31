import { expect, test } from "bun:test";

import { isWebKit } from "./native-audio-choice";

const WEBKIT = "AppleWebKit/605.1.15 (KHTML, like Gecko)";
const BLINK = "AppleWebKit/537.36 (KHTML, like Gecko)";

test.each([
  [
    "macOS の Safari",
    `(Macintosh) ${WEBKIT} Version/27.0 Safari/605.1.15`,
    true,
  ],
  [
    "iPhone の Safari",
    `(iPhone) ${WEBKIT} Version/27.2 Mobile/15E148 Safari/604.1`,
    true,
  ],
  [
    "iPhone の Chrome (中身は WebKit)",
    `(iPhone) ${WEBKIT} CriOS/140.0 Mobile/15E148 Safari/604.1`,
    true,
  ],
  ["Chrome", `(Windows NT 10.0) ${BLINK} Chrome/140.0 Safari/537.36`, false],
  [
    "Edge",
    `(Windows NT 10.0) ${BLINK} Chrome/140.0 Safari/537.36 Edg/140.0`,
    false,
  ],
  [
    "テスラ",
    `(X11; Linux x86_64) ${BLINK} Chrome/136.0 Safari/537.36 Tesla/2026.32.1`,
    false,
  ],
  [
    "ヘッドレスの Chromium (E2E)",
    `(X11; Linux x86_64) ${BLINK} HeadlessChrome/140.0 Safari/537.36`,
    false,
  ],
  [
    "Firefox",
    "(Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0",
    false,
  ],
])("音を別に鳴らすのは WebKit だけ: %s", (_, ua, webkit) => {
  expect(isWebKit(`Mozilla/5.0 ${ua}`)).toBe(webkit);
});
