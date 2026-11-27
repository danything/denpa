import { expect, test } from "bun:test";

import { emit, sinceSent } from "./events";

/*
 * 送ったかどうかはモジュールが持つので、同じプロセスのほかのテストが先に送っていることがある。
 * 送ったことの無い名前を載せないことは確かめず、送った直後からの長さだけを見る
 */
test("名前ごとに、最後に送ってから経った長さを返す", () => {
  emit("clips");
  const at = performance.now();
  expect(sinceSent(at + 1500).clips).toBe(1500);
});
