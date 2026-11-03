import { describe, expect, test } from "bun:test";

import { homeHost } from "./niconico";

describe("denpa-hub が戻り先として受け付けるホスト", () => {
  test("家の中のアドレス・名前は通す", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.20",
      "100.64.0.1",
      "100.127.255.254",
      "localhost",
      "denpa.local",
      "tv.home.arpa",
      "[::1]",
      "[fd12:3456::1]",
      "[fc00::1]",
      "[::ffff:c0a8:114]",
      "::ffff:192.168.1.20",
    ])
      expect(homeHost(host)).toBe(true);
  });

  test("名前で届くホスト・インターネットのアドレスは通さない", () => {
    for (const host of [
      "tv.example.com",
      "denpa.tail1234.ts.net",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "192.169.0.1",
      "[2001:db8::1]",
      "[fe80::1]",
      "[::ffff:808:808]",
      ".local",
      "local",
      "999.1.1.1",
    ])
      expect(homeHost(host)).toBe(false);
  });
});
