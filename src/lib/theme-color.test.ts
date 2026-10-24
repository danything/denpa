import { expect, test } from "bun:test";

import { normalizeHex } from "./theme-color";

test("テーマの地は #rrggbb にそろえる", () => {
  expect(normalizeHex(" #FFF ")).toBe("#ffffff");
  expect(normalizeHex("#0b0c0f")).toBe("#0b0c0f");
  expect(normalizeHex("rgb(0, 0, 0)")).toBeNull();
});
