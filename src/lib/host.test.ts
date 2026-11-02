import { describe, expect, test } from "bun:test";

import { indoorHost, parseIndoorHosts, readIndoorHosts } from "./host";
import { homeHost } from "./niconico";

/**
 * **家の中かは開いた名前で決める** (`indoorHost`)。世帯の設定に載せた名前と、プライベートの IP・`localhost`・`.local`・
 * `.home.arpa`。連携の戻り先 (`homeHost`) と違って CGNAT (VPN) は入れない
 */
describe("ライブの自動で家の中とみるホスト", () => {
  test("載せた名前は家の中。大文字・末尾の点・角括弧は気にしない", () => {
    const names = ["dp.l.example.com", "fd00::5"];
    expect(indoorHost("dp.l.example.com", names)).toBe(true);
    expect(indoorHost("DP.L.Example.com.", names)).toBe(true);
    expect(indoorHost("[fd00::5]", names)).toBe(true);
    // 外の名前は載せていなければ外
    expect(indoorHost("dp.example.com", names)).toBe(false);
  });

  test("載せていなくても、家の中のアドレス・名前は家の中", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.20",
      "localhost",
      "denpa.local",
      "tv.home.arpa",
      "[::1]",
      "[fd12:3456::1]",
      "[::ffff:c0a8:114]",
    ])
      expect(indoorHost(host, [])).toBe(true);
  });

  test("CGNAT (VPN) と、名前・インターネットのアドレスは外", () => {
    for (const host of [
      "100.64.0.1",
      "100.127.255.254",
      "dp.example.com",
      "denpa.tail1234.ts.net",
      "8.8.8.8",
      "[2001:db8::1]",
    ])
      expect(indoorHost(host, [])).toBe(false);
  });

  test("連携の戻り先は今までどおり CGNAT も家の中", () => {
    expect(homeHost("100.64.0.1")).toBe(true);
    expect(indoorHost("100.64.0.1", [])).toBe(false);
  });
});

describe("家の中の名前の欄", () => {
  test("1 行に 1 つ。URL で書いてもホスト名だけ採り、空の行と同じ名前は外す", () => {
    expect(
      parseIndoorHosts(
        "dp.l.example.com\n\nhttps://DP.L.example.com/live\n  nas.lan  \r\n[fd00::5]",
      ),
    ).toEqual({ hosts: ["dp.l.example.com", "nas.lan", "fd00::5"] });
  });

  test("名前として読めないものは理由を返す", () => {
    expect(parseIndoorHosts("dp example.com")).toEqual({
      error: "名前として読めません: dp example.com",
    });
    expect(parseIndoorHosts("-bad.example")).toHaveProperty("error");
  });

  test("多すぎれば理由を返す", () => {
    const many = Array.from({ length: 21 }, (_, i) => `h${i}.lan`).join("\n");
    expect(parseIndoorHosts(many)).toEqual({
      error: "家の中の名前は 20 個までです",
    });
  });

  test("保存してある値は、壊れていれば空。読めない名前は捨てる", () => {
    expect(readIndoorHosts('["dp.l.example.com", 3, "a b"]')).toEqual([
      "dp.l.example.com",
    ]);
    expect(readIndoorHosts("{")).toEqual([]);
    expect(readIndoorHosts(undefined)).toEqual([]);
  });
});
