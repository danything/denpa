import { expect, test } from "bun:test";

import { isWebKit, tapSilent, volumeFixed } from "./native-audio-choice";

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

test("観る画面で Web Audio に通さないのは WebKit の MSE だけ", () => {
  const safari = `Mozilla/5.0 (iPhone) ${WEBKIT} Version/27.2 Mobile/15E148 Safari/604.1`;
  const chrome = `Mozilla/5.0 (Windows NT 10.0) ${BLINK} Chrome/140.0 Safari/537.36`;
  // MSE (その場で流しているもの) は通すと無音になる
  expect(tapSilent(safari, true)).toBe(true);
  // ファイルの直再生は通せる
  expect(tapSilent(safari, false)).toBe(false);
  expect(tapSilent(chrome, true)).toBe(false);
  expect(tapSilent(chrome, false)).toBe(false);
});

test("音量を入れても 1 のままの要素は、音量を変えられない端末 (iOS・iPadOS)", () => {
  // iOS の WebKit: 入れても読み返すと 1 のまま
  const ios = {
    get volume() {
      return 1;
    },
    set volume(_: number) {},
  };
  expect(volumeFixed(ios)).toBe(true);
  // ほかのブラウザ (macOS の Safari も): 入れた値が読み返せる
  expect(volumeFixed({ volume: 1 })).toBe(false);
  // 入れると例外になる要素も変えられないものとして扱う
  const throwing = {
    get volume() {
      return 1;
    },
    set volume(_: number) {
      throw new Error("read only");
    },
  };
  expect(volumeFixed(throwing)).toBe(true);
});
