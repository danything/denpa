import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  configured,
  denied,
  foreignHost,
  isOpenPath,
  knownHost,
  sharedNetworks,
  trusted,
} from "./auth";
import { config } from "./config";

/**
 * ログインの入口。**ここを守ると入れなくなる** (ログイン画面へ行くのに
 * ログインが要る、という輪になる)。
 */
describe("素通しにするエンドポイント", () => {
  test("ログインとログアウト", () => {
    expect(isOpenPath("/login")).toBe(true);
    expect(isOpenPath("/login/callback")).toBe(true);
    expect(isOpenPath("/login/out")).toBe(true);
    expect(isOpenPath("/logout")).toBe(true);
  });

  /*
   * **死活確認。** Kubernetes の livenessProbe が呼ぶ。守ると Pod が
   * 再起動を繰り返す — 掛ける範囲を選べるのをやめたときに実際に踏んだ
   */
  test("死活確認", () => {
    expect(isOpenPath("/api/health")).toBe(true);
  });

  /*
   * **マニフェスト。** ブラウザは資格情報を付けずに取得するので、守ると
   * ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
   * hooks より手前で返していて、そもそも掛かっていなかった
   */
  test("PWA のマニフェスト", () => {
    expect(isOpenPath("/manifest.webmanifest")).toBe(true);
  });

  test("似た名前は素通しにしない", () => {
    expect(isOpenPath("/loginx")).toBe(false);
    expect(isOpenPath("/logoutx")).toBe(false);
    expect(isOpenPath("/api/healthz")).toBe(false);
    expect(isOpenPath("/manifest.webmanifest.map")).toBe(false);
    expect(isOpenPath("/")).toBe(false);
  });
});

/**
 * **ログイン方法が1つも無ければ、全部断る** (fail-closed)。OIDC はこのテストでは
 * 設定していないので、TRUSTED_NETWORKS の有無がそのまま答えになる。
 */
describe("ログイン方法が設定してあるか", () => {
  const original = config.trustedNetworks;
  afterEach(() => {
    config.trustedNetworks = original;
  });

  test("TRUSTED_NETWORKS があれば設定済み", () => {
    config.trustedNetworks = "10.10.0.0/16";
    expect(configured()).toBe(true);
  });

  test("何も無ければ未設定 (全部断る)", () => {
    config.trustedNetworks = "";
    expect(configured()).toBe(false);
  });
});

/**
 * **何も聞かずに通す相手。** 家の中のプレイヤーやテレビに資格情報を
 * 入れずに使わせるためのもの。ここに当たると OIDC も掛からない。
 *
 * ここで見るのはアドレスだけ。名前は下の「知っている名前か」で別に見る。
 */
describe("ネットワークの中なら素通しにする", () => {
  const original = config.trustedNetworks;
  beforeEach(() => {
    config.trustedNetworks = "10.10.0.0/16";
  });
  afterEach(() => {
    config.trustedNetworks = original;
  });

  test("ネットワークの中なら通す", () => {
    expect(trusted("10.10.5.9")).toBe(true);
  });

  test("ネットワークの外は通さない", () => {
    expect(trusted("203.0.113.9")).toBe(false);
  });

  test("アドレスが読めなければ通さない", () => {
    // `clientAddress` は読めないとき空文字を返す。閉じる側に倒す
    expect(trusted("")).toBe(false);
  });

  test("何も書かなければ誰も通さない", () => {
    config.trustedNetworks = "";
    expect(trusted("10.10.5.9")).toBe(false);
  });

  test("いくつでも並べられる", () => {
    config.trustedNetworks = "10.10.0.0/16, 10.20.0.0/16, 192.168.1.5";
    expect(trusted("10.10.1.1")).toBe(true);
    expect(trusted("10.20.1.1")).toBe(true);
    // CIDR でなくアドレスそのままでも書ける
    expect(trusted("192.168.1.5")).toBe(true);
    expect(trusted("192.168.1.6")).toBe(false);
  });
});

/**
 * **信頼したネットワークから、ログインなしで開いてよい名前か** (DNS リバインディングを防ぐ)。
 * 攻める側が自分の名前として用意できないものと、設定にある自分の名前だけを通す。
 */
describe("知っている名前か", () => {
  const original = { ...config };
  afterEach(() => {
    config.allowedHosts = original.allowedHosts;
    config.pwaNames = original.pwaNames;
    config.hostHeader = original.hostHeader;
  });

  test("IP の直書きと localhost は通す", () => {
    expect(knownHost("192.168.1.5")).toBe(true);
    expect(knownHost("192.168.1.5:3000")).toBe(true);
    expect(knownHost("[::1]:3000")).toBe(true);
    expect(knownHost("[fd00::5]")).toBe(true);
    expect(knownHost("localhost:3000")).toBe(true);
    expect(knownHost("denpa.localhost")).toBe(true);
  });

  test("ドットの無い名前と、家の中だけの名前は通す", () => {
    expect(knownHost("nas:3000")).toBe(true);
    expect(knownHost("denpa.local")).toBe(true);
    expect(knownHost("denpa.lan")).toBe(true);
    expect(knownHost("tv.home.arpa")).toBe(true);
    expect(knownHost("denpa.internal")).toBe(true);
    // 最後のドットと大文字は気にしない
    expect(knownHost("Denpa.LAN.")).toBe(true);
  });

  test("外で引ける名前は、設定に無ければ通さない", () => {
    config.allowedHosts = "";
    config.pwaNames = "";
    expect(knownHost("evil.example")).toBe(false);
    expect(knownHost("denpa.example.com:3000")).toBe(false);
    // 家の中の名前に見せかけたもの
    expect(knownHost("local.evil.example")).toBe(false);
    expect(knownHost("lan.evil.example")).toBe(false);
  });

  test("ALLOWED_HOSTS の名前は通す。頭にドットでその下も", () => {
    config.allowedHosts = "tv.example.com, .tail1234.ts.net";
    expect(knownHost("tv.example.com")).toBe(true);
    expect(knownHost("TV.example.com:443")).toBe(true);
    expect(knownHost("other.example.com")).toBe(false);
    expect(knownHost("denpa.tail1234.ts.net")).toBe(true);
    expect(knownHost("tail1234.ts.net")).toBe(true);
    // 似た名前は通さない
    expect(knownHost("eviltail1234.ts.net")).toBe(false);
    expect(knownHost("denpa.tail9999.ts.net")).toBe(false);
  });

  test("PWA_NAMES の名前も自分の名前", () => {
    config.pwaNames = "dp.example.com=denpa,dp.l.example.com=denpa 宅内";
    expect(knownHost("dp.l.example.com")).toBe(true);
    expect(knownHost("dp.example.com")).toBe(true);
    expect(knownHost("x.example.com")).toBe(false);
  });

  test("読めない名前は通さない", () => {
    expect(knownHost("")).toBe(false);
    expect(knownHost("[]")).toBe(false);
    expect(knownHost("évil")).toBe(false);
  });

  test("Host と HOST_HEADER のヘッダの両方を見る", () => {
    config.allowedHosts = "";
    config.hostHeader = "x-forwarded-host";
    const headers = (init: Record<string, string>) => new Headers(init);
    expect(
      foreignHost(headers({ host: "192.168.1.5:3000" }), "192.168.1.9"),
    ).toBeNull();
    // Host は変えられないが、同じオリジンのスクリプトは x-forwarded-host を付けられる。どちらが知らない名前でも断る
    expect(
      foreignHost(
        headers({ host: "evil.example", "x-forwarded-host": "192.168.1.5" }),
        "192.168.1.9",
      ),
    ).toBe("evil.example");
    expect(
      foreignHost(
        headers({ host: "192.168.1.5", "x-forwarded-host": "evil.example" }),
        "192.168.1.9",
      ),
    ).toBe("evil.example");
    // 名前が無ければ通さない
    expect(foreignHost(headers({}), "192.168.1.9")).toBe("");
  });

  test("断るときは理由を言う", async () => {
    const original = config.trustedNetworks;
    config.trustedNetworks = "10.10.0.0/16";
    try {
      expect(await denied("10.10.5.9", "evil.example").text()).toContain(
        "ALLOWED_HOSTS",
      );
      // ネットワークの外なら、接続元を書く (何を足せばよいか分かるように)
      expect(await denied("172.18.0.1").text()).toContain("172.18.0.1");
      // 相手の送ってきた名前が入るので、ブラウザに HTML と読ませない
      expect(
        denied("10.10.5.9", "<b>x</b>").headers.get("x-content-type-options"),
      ).toBe("nosniff");
    } finally {
      config.trustedNetworks = original;
    }
  });
});

/**
 * **前段と同じネットワークを信頼していないか** (起動時の警告)。TRUSTED_PROXIES が空で、
 * TRUSTED_NETWORKS が自分のインターフェースのネットワークと重なっていたら当たる。
 */
describe("前段と同じネットワークを信頼していないか", () => {
  const iface = (cidr: string, internal = false) => ({
    address: cidr.split("/")[0]!,
    netmask: "",
    family: cidr.includes(":") ? ("IPv6" as const) : ("IPv4" as const),
    mac: "00:00:00:00:00:00",
    internal,
    cidr,
    scopeid: 0,
  });
  const docker = {
    lo: [iface("127.0.0.1/8", true), iface("::1/128", true)],
    eth0: [iface("172.18.0.3/16"), iface("fe80::42:acff:fe12:3/64")],
  };

  test("Docker のネットワークを含む範囲を信頼し、TRUSTED_PROXIES が空なら当たる", () => {
    expect(
      sharedNetworks("192.168.0.0/16,10.0.0.0/8,172.16.0.0/12", "", docker),
    ).toEqual(["172.18.0.3/16"]);
  });

  test("TRUSTED_PROXIES を書いてあれば当たらない", () => {
    expect(sharedNetworks("172.16.0.0/12", "172.18.0.0/16", docker)).toEqual(
      [],
    );
  });

  test("重ならなければ当たらない", () => {
    expect(sharedNetworks("192.168.0.0/16,10.0.0.0/8", "", docker)).toEqual([]);
  });

  test("ループバックとリンクローカルは見ない", () => {
    expect(
      sharedNetworks("127.0.0.0/8,fe80::/10,169.254.0.0/16", "", {
        ...docker,
        wslc: [iface("169.254.73.2/16")],
      }),
    ).toEqual([]);
  });
});
