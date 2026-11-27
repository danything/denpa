import { expect, test } from "bun:test";

import { missedBeforeOpen } from "./live-missed";

test("読んでから送られた通知があれば取りこぼしている", () => {
  // 読み始めてから 800 ms。recordings は 100 ms 前に送られた
  expect(missedBeforeOpen({ recordings: 100 }, ["recordings"], 800)).toBe(true);
});

test("読む前に送られた通知は、もう中身に入っている", () => {
  expect(missedBeforeOpen({ recordings: 5000 }, ["recordings"], 800)).toBe(
    false,
  );
});

test("聞いていない名前の通知では読み直さない", () => {
  expect(
    missedBeforeOpen({ encode: 10, tuners: 10 }, ["recordings"], 800),
  ).toBe(false);
});

test("読めない中身は取りこぼしていないとみなす", () => {
  expect(missedBeforeOpen(null, ["recordings"], 800)).toBe(false);
  expect(missedBeforeOpen({ recordings: "1" }, ["recordings"], 800)).toBe(
    false,
  );
});
