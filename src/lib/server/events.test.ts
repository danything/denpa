import { expect, test } from "bun:test";

import { emit, sinceSent } from "./events";

test("名前ごとに、最後に送ってから経った長さを返す", () => {
  const before = sinceSent();
  expect(before.clips).toBeUndefined();
  emit("clips");
  const at = performance.now();
  expect(sinceSent(at + 1500).clips).toBe(1500);
  // 送ったことの無い名前は載せない
  expect(sinceSent(at + 1500).migrate).toBeUndefined();
});
