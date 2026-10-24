import { describe, expect, test } from "bun:test";

import { visibleFrom } from "../bml/nvram";
import { bmlCompat, type CompatInit } from "./compat";

const INIT: CompatInit = {
  greg: ["", "kept"],
  nvram: {},
  receiver: { zipcode: "1500041", prefecture: 13 },
  who: { originalNetworkId: 0x7fe0, serviceId: 1024 },
};

function make(init: CompatInit = INIT): {
  // oxlint-disable-next-line typescript/no-explicit-any -- アプリから見える形 (型の無い世界) で触る
  api: any;
  posted: Record<string, unknown>[];
} {
  const posted: Record<string, unknown>[] = [];
  return { api: bmlCompat(init, (message) => posted.push(message)), posted };
}

describe("bmlCompat", () => {
  test("Greg はデータ放送のものを読み、書いたら親へ知らせる (256 バイトで切る)", () => {
    const { api, posted } = make();
    const greg = api.bmlCompat.browserPseudo.Greg;
    expect(greg[1]).toBe("kept");
    expect(greg[63]).toBe("");
    greg[55] = "nhk:x";
    greg[64] = "out";
    greg[2] = "あ".repeat(200);
    expect(greg[55]).toBe("nhk:x");
    expect(posted).toEqual([
      { type: "greg", index: 55, value: "nhk:x" },
      { type: "greg", index: 2, value: "あ".repeat(128) },
    ]);
  });

  test("NVRAM は読み書きでき、書いた中身を親へ知らせる (データ放送と同じ鍵)", () => {
    const { api, posted } = make();
    const pseudo = api.bmlCompat.browserPseudo;
    expect(
      pseudo.writePersistentArray("nvram://00;group/14", "U:1B,S:1V", [
        15,
        "あ",
      ]),
    ).toBeGreaterThan(0);
    expect(
      pseudo.readPersistentArray("nvram://00;group/14", "U:1B,S:1V"),
    ).toEqual([15, "あ"]);
    expect(posted).toEqual([
      { type: "nvram", key: "group:00:14", value: expect.any(String) },
    ]);
    // 渡された中身を読む (同じ鍵なら別の作りでも読める)
    const again = make({
      ...INIT,
      nvram: { "group:00:14": posted[0]!["value"] as string },
    });
    expect(
      again.api.bmlCompat.browserPseudo.readPersistentArray(
        "nvram://00;group/14",
        "U:1B",
      ),
    ).toEqual([15]);
    // 受信機の設定は読むだけ
    expect(
      pseudo.readPersistentArray("nvram://receiverinfo/zipcode", "S:7B"),
    ).toEqual(["1500041"]);
    expect(
      pseudo.checkAccessInfoOfPersistentArray("nvram://receiverinfo/zipcode"),
    ).toBe(1);
  });

  test("データ放送へ戻ると言われたら閉じる", () => {
    const { api, posted } = make();
    api.applicationManager.launchDataBroadcastingBrowser({ component_tag: 64 });
    expect(posted).toEqual([{ type: "close" }]);
  });
});

test("visibleFrom: アプリへ写すのは、起動した局から見える NVRAM だけ", () => {
  const nhk = { originalNetworkId: 0x7fe0, serviceId: 1024 };
  expect(visibleFrom("local:32736:0", nhk)).toBe(true);
  expect(visibleFrom("local:32737:0", nhk)).toBe(false);
  expect(visibleFrom("group:00:14", nhk)).toBe(true);
  expect(visibleFrom("tr_common::3", nhk)).toBe(true);
  // BS は局の領域もサービスで分ける
  const bs = { originalNetworkId: 4, serviceId: 101 };
  expect(visibleFrom("local:4.101:0", bs)).toBe(true);
  expect(visibleFrom("local:4.103:0", bs)).toBe(false);
  expect(visibleFrom("~:4.101:0", bs)).toBe(true);
  expect(visibleFrom("unknown:x:0", nhk)).toBe(false);
  // アプリが書いてきた鍵も確かめる。`Nvram` が作らない形は通さない
  expect(visibleFrom("group:00:64", nhk)).toBe(false);
  expect(visibleFrom("group:zz:0", nhk)).toBe(false);
  expect(visibleFrom("group:00:1:x", nhk)).toBe(false);
  expect(visibleFrom("local:32736:64", nhk)).toBe(false);
  expect(visibleFrom("local_web:32736:32", nhk)).toBe(false);
});
