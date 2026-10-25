import { describe, expect, test } from "bun:test";

import {
  inNetwork,
  normalize,
  overlaps,
  resolveClient,
  unreadable,
} from "./address";

describe("アドレスがネットワークの中か", () => {
  test("CIDR の中と外", () => {
    expect(inNetwork("10.10.0.1", "10.10.0.0/16")).toBe(true);
    expect(inNetwork("10.10.255.254", "10.10.0.0/16")).toBe(true);
    // 隣の /16。1ビット違いを通してしまわないこと
    expect(inNetwork("10.11.0.1", "10.10.0.0/16")).toBe(false);
    expect(inNetwork("10.9.255.255", "10.10.0.0/16")).toBe(false);
  });

  test("境界の長さ", () => {
    expect(inNetwork("192.168.1.5", "192.168.1.5/32")).toBe(true);
    expect(inNetwork("192.168.1.6", "192.168.1.5/32")).toBe(false);
    // /0 は全部。書いた人がそう書いたなら通す
    expect(inNetwork("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });

  test("長さを書かなければ1台だけ", () => {
    expect(inNetwork("10.0.0.1", "10.0.0.1")).toBe(true);
    expect(inNetwork("10.0.0.2", "10.0.0.1")).toBe(false);
  });

  /*
   * IPv4 のアドレスが IPv6 の形式で届くことがある。素で比べると
   * `::ffff:10.10.0.1` が `10.10.0.0/16` に当たらず、LAN から入れなくなる
   */
  test("IPv6 に包まれた IPv4 も取り出す", () => {
    expect(inNetwork("::ffff:10.10.0.1", "10.10.0.0/16")).toBe(true);
    expect(inNetwork("::FFFF:10.11.0.1", "10.10.0.0/16")).toBe(false);
  });

  test("IPv6 も CIDR で書ける", () => {
    expect(inNetwork("fd00::1", "fd00::1")).toBe(true);
    expect(inNetwork("fd00:0:0::1", "fd00::1")).toBe(true);
    expect(inNetwork("fd00::2", "fd00::1")).toBe(false);
    expect(inNetwork("fd00::1", "fd00::/8")).toBe(true);
    expect(inNetwork("fd42::f539", "fd42::/64")).toBe(true);
    expect(inNetwork("fd42:0:0:1::1", "fd42::/64")).toBe(false);
    expect(inNetwork("FD42::1", "fd42::/64")).toBe(true);
    expect(inNetwork("::1", "::/0")).toBe(true);
  });

  test("IPv4 と IPv6 は互いに当たらない", () => {
    expect(inNetwork("10.0.0.1", "::/0")).toBe(false);
    expect(inNetwork("fd00::1", "0.0.0.0/0")).toBe(false);
  });

  test("壊れた指定では通さない", () => {
    expect(inNetwork("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(inNetwork("10.0.0.1", "10.0.0.0/-1")).toBe(false);
    expect(inNetwork("10.0.0.1", "10.0.0.0/abc")).toBe(false);
    expect(inNetwork("10.0.0.1", "")).toBe(false);
    // 桁が溢れているもの。数として読めてもアドレスではない
    expect(inNetwork("10.0.0.1", "10.0.0.256/24")).toBe(false);
    expect(inNetwork("fd00::1", "fd00::/129")).toBe(false);
    expect(inNetwork("fd00::1", "fd00:::/8")).toBe(false);
    expect(inNetwork("fd00::1", "fd00::/8/8")).toBe(false);
    expect(inNetwork("", "0.0.0.0/0")).toBe(false);
  });
});

describe("アドレスをそろえる", () => {
  test("IPv4 はそのまま、IPv4 を写した IPv6 は IPv4 に戻す", () => {
    expect(normalize("10.0.0.1")).toBe("10.0.0.1");
    expect(normalize("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalize("::FFFF:a00:1")).toBe("10.0.0.1");
  });

  test("IPv6 は省略しない小文字の形式", () => {
    expect(normalize("FD42::1")).toBe("fd42:0:0:0:0:0:0:1");
    expect(normalize("::1")).toBe("0:0:0:0:0:0:0:1");
  });

  test("読めなければ null", () => {
    expect(normalize("")).toBeNull();
    expect(normalize("unknown")).toBeNull();
    expect(normalize("10.0.0.1:443")).toBeNull();
    expect(normalize("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(normalize("1::2::3")).toBeNull();
  });
});

/*
 * 本番の構成: 前段 (Cilium Gateway の Envoy) が Pod の網 (10.42.0.0/16) から繋いでくる。
 * LAN は 10.10.0.0/16
 */
describe("本当の接続元を決める", () => {
  const proxies = ["10.42.0.0/16", "fd42::/64"];

  test("前段が無い構成 (TRUSTED_PROXIES が空) では相手そのもの", () => {
    expect(resolveClient("10.10.5.9", null, [])).toBe("10.10.5.9");
    // 付けて来たヘッダは読まない
    expect(resolveClient("203.0.113.9", "10.10.5.9", [])).toBe("203.0.113.9");
  });

  test("前段を1つ挟む", () => {
    expect(resolveClient("10.42.0.148", "10.10.5.9", proxies)).toBe(
      "10.10.5.9",
    );
  });

  test("前段を2つ挟む (どちらも信頼した網)", () => {
    expect(resolveClient("10.42.0.148", "10.10.5.9, 10.42.0.7", proxies)).toBe(
      "10.10.5.9",
    );
  });

  test("客が前段の前で偽のアドレスを付けて来ても、右から最初の前段でないアドレスを使う", () => {
    // Envoy は付いて来た X-Forwarded-For の右に本当の相手を足す
    expect(
      resolveClient("10.42.0.148", "10.10.5.9, 203.0.113.9", proxies),
    ).toBe("203.0.113.9");
  });

  test("前段でない相手が付けて来たヘッダは信じない (直に :3000 へ来た)", () => {
    expect(resolveClient("203.0.113.9", "10.10.5.9", proxies)).toBe(
      "203.0.113.9",
    );
    expect(resolveClient("10.10.7.7", "10.10.5.9", proxies)).toBe("10.10.7.7");
  });

  test("全部が前段なら左端", () => {
    expect(resolveClient("10.42.0.148", "10.42.0.9, 10.42.0.7", proxies)).toBe(
      "10.42.0.9",
    );
  });

  test("前段なのにヘッダが無ければ相手そのもの", () => {
    expect(resolveClient("10.42.0.148", null, proxies)).toBe("10.42.0.148");
    expect(resolveClient("10.42.0.148", "", proxies)).toBe("10.42.0.148");
  });

  test("読めない項目に当たったら、その先 (左) は信じない", () => {
    expect(resolveClient("10.42.0.148", "10.10.5.9, unknown", proxies)).toBe(
      "10.42.0.148",
    );
    expect(
      resolveClient("10.42.0.148", "10.10.5.9, garbage, 10.42.0.7", proxies),
    ).toBe("10.42.0.7");
  });

  test("IPv6 の前段と客", () => {
    expect(resolveClient("fd42::f539", "2001:db8::1", proxies)).toBe(
      "2001:db8:0:0:0:0:0:1",
    );
    expect(resolveClient("2001:db8::2", "10.10.5.9", proxies)).toBe(
      "2001:db8:0:0:0:0:0:2",
    );
  });

  test("IPv4 を写した IPv6 で届いても前段と分かり、客も IPv4 に戻す", () => {
    expect(
      resolveClient("::ffff:10.42.0.148", "::ffff:10.10.5.9", proxies),
    ).toBe("10.10.5.9");
    expect(resolveClient("::ffff:10.10.5.9", null, [])).toBe("10.10.5.9");
  });

  test("相手が読めなければ空 (どこにも当たらない)", () => {
    expect(resolveClient("", "10.10.5.9", proxies)).toBe("");
  });
});

describe("読めない項目を見つける", () => {
  test("書き損じだけを返す", () => {
    expect(unreadable(["10.42.0.0/16", "fd42::/64", "192.168.1.5"])).toEqual(
      [],
    );
    expect(
      unreadable([
        "10.42.0.0/16",
        "10.42.0/16",
        "10.0.0.0/33",
        "fd42::/129",
        "localhost",
      ]),
    ).toEqual(["10.42.0/16", "10.0.0.0/33", "fd42::/129", "localhost"]);
  });
});

describe("ネットワークが重なるか", () => {
  test("片方がもう片方を含めば重なる", () => {
    expect(overlaps("172.16.0.0/12", "172.18.0.3/16")).toBe(true);
    expect(overlaps("172.18.0.3/16", "172.16.0.0/12")).toBe(true);
    // アドレス1つでも
    expect(overlaps("10.0.0.0/8", "10.42.0.7")).toBe(true);
  });

  test("隣どうしは重ならない", () => {
    expect(overlaps("192.168.0.0/16", "172.18.0.3/16")).toBe(false);
    expect(overlaps("10.10.0.0/16", "10.11.0.0/16")).toBe(false);
  });

  test("IPv4 と IPv6、読めないものは重ならない", () => {
    expect(overlaps("0.0.0.0/0", "fd00::1/64")).toBe(false);
    expect(overlaps("fd00::/8", "fd00:1::5/64")).toBe(true);
    expect(overlaps("10.0.0.0/33", "10.0.0.1")).toBe(false);
  });
});
