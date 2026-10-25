import { describe, expect, test } from "bun:test";

import {
  allowed,
  isPublicAddress,
  limited,
  Refused,
  relayed,
  requireFetch,
} from "./bml-network";

/*
 * **危ないのは繋ぎ先ではなく、繋ぐ範囲。**
 *
 * データ放送の双方向は、放送局のサーバから取得する API。局ごとのドメイン表は
 * 持たない (必ず古くなる) 代わりに、**denpa のサーバが内側へ繋がないこと**を
 * ここで固定する ([bml-network.ts](bml-network.ts))。
 */

describe("繋いでよいアドレスか", () => {
  test("公開のものは通す", () => {
    for (const address of [
      "1.1.1.1",
      "203.0.113.9",
      "2400:2410::1",
      "8.8.8.8",
    ]) {
      expect(isPublicAddress(address)).toBe(true);
    }
  });

  test("内側は断る", () => {
    for (const address of [
      "127.0.0.1", // ループバック
      "10.0.0.5", // 私設
      "172.16.0.1", // 私設
      "172.31.255.254", // 私設 (端)
      "192.168.1.1", // 私設
      "169.254.169.254", // リンクローカル。クラウドのメタデータもここ
      "100.64.0.1", // 事業者内 (CGNAT)
      "0.0.0.0",
      "224.0.0.1", // 多重放送
      "::1",
      "fe80::1", // リンクローカル
      "fd00::1", // ユニークローカル
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  /*
   * **`::ffff:` は剥がしてから見る。** 被せただけの IPv4 なので、
   * 綴りのまま見ると「IPv6 だから通す」で素通りする
   */
  test("IPv4 を被せた IPv6 も剥がして見る", () => {
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:10.1.2.3")).toBe(false);
    expect(isPublicAddress("::ffff:1.1.1.1")).toBe(true);
    // 16進の綴り (URL が直した後の形式) も同じ
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false); // 127.0.0.1
    expect(isPublicAddress("::ffff:a01:203")).toBe(false); // 10.1.2.3
    expect(isPublicAddress("::ffff:101:101")).toBe(true); // 1.1.1.1
    // 省かない書き方も同じ
    expect(isPublicAddress("0:0:0:0:0:0:0:1")).toBe(false);
    expect(isPublicAddress("0:0:0:0:0:ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("FE80:0:0:0:0:0:0:1")).toBe(false);
  });

  test("172 は 16〜31 だけが私設", () => {
    expect(isPublicAddress("172.15.0.1")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
});

describe("取得してよい URL か", () => {
  /*
   * **http も通す。** 放送がそう作られている (NHK は
   * `http://beacon.nhk.jp/` へ投げてくる)。https だけにすると、
   * 双方向を入れても「接続されていません」のままになる
   */
  test("http と https は通す", async () => {
    expect((await allowed("http://example.com/x")).url).toBeInstanceOf(URL);
    expect((await allowed("https://example.com/x")).url).toBeInstanceOf(URL);
  });

  test("別の仕組みへ逃がす経路は塞ぐ", async () => {
    expect(allowed("file:///etc/passwd")).rejects.toThrow(Refused);
    expect(allowed("ftp://example.com/x")).rejects.toThrow(Refused);
    expect(allowed("data:text/plain,x")).rejects.toThrow(Refused);
  });

  test("URL として読めなければ断る", async () => {
    expect(allowed("nhk.or.jp/data")).rejects.toThrow(Refused);
    expect(allowed("")).rejects.toThrow(Refused);
  });

  /*
   * **名前ではなく引いた先で見る。** `localhost` は名前で弾けるが、
   * 内側を指す公開の名前は綴りでは見分けが付かない
   */
  test("内側を指す名前は断る", async () => {
    expect(allowed("https://localhost/x")).rejects.toThrow(Refused);
  });

  /*
   * **IPv6 リテラルの [] は自分で剥がす。** `new URL().hostname` は
   * `[::1]` を括弧付きのまま返すので、そのまま綴りを見ると1つの判定にも
   * 掛からず、内側なのに公開扱いで素通りしていた
   */
  test("括弧付きの IPv6 リテラルも中身で断る", async () => {
    expect(allowed("http://[::1]:8080/x")).rejects.toThrow(Refused);
    expect(allowed("http://[::ffff:127.0.0.1]/x")).rejects.toThrow(Refused);
    expect(allowed("http://[fd00::1]/x")).rejects.toThrow(Refused);
  });
});

describe("IPv6 の抜け", () => {
  /*
   * **IPv4 を埋め込んだ形式は、中の IPv4 で見る。** NAT64 と 6to4 は着く先が中の IPv4 そのもので、
   * 「IPv6 の公開アドレス」として通すと内側へ繋がる
   */
  test("NAT64 と 6to4 は埋め込まれた IPv4 で見る", () => {
    expect(isPublicAddress("64:ff9b::127.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::a9fe:a9fe")).toBe(false); // 169.254.169.254
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true); // 8.8.8.8
    expect(isPublicAddress("2002:7f00:1::")).toBe(false); // 127.0.0.1
    expect(isPublicAddress("2002:c0a8:101::1")).toBe(false); // 192.168.1.1
    expect(isPublicAddress("2002:808:808::1")).toBe(true); // 8.8.8.8
  });

  test("公開のユニキャスト (2000::/3) のほかは断る", () => {
    for (const address of [
      "::127.0.0.1", // IPv4 互換
      "::a00:1", // IPv4 互換 (10.0.0.1)
      "fec0::1", // サイトローカル
      "ff02::1", // マルチキャスト
      "64:ff9b:1::a00:1", // NAT64 のローカル用
      "100::1", // 捨てる用
      "2001::1", // Teredo
      "2001:db8::1", // 文書用
      "fe80::1%eth0", // ゾーン付きは読めないので断る
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  test("IPv4 の予約も断る", () => {
    expect(isPublicAddress("198.18.0.1")).toBe(false); // 性能試験用
    expect(isPublicAddress("198.19.255.254")).toBe(false);
    expect(isPublicAddress("192.0.0.170")).toBe(false); // NAT64 の機器
    expect(isPublicAddress("198.20.0.1")).toBe(true);
  });
});

describe("ポート", () => {
  test("Web のポートは通し、ほかは断る", async () => {
    expect((await allowed("http://1.1.1.1:8080/x")).url.port).toBe("8080");
    expect((await allowed("https://1.1.1.1:443/x")).url.port).toBe(""); // 既定のポートは URL が省く
    expect(allowed("http://1.1.1.1:25/x")).rejects.toThrow(Refused);
    expect(allowed("http://1.1.1.1:6379/x")).rejects.toThrow(Refused);
  });
});

describe("同時の数", () => {
  test("上限を超えたら待たせずに断り、空けばまた通す", async () => {
    const releases: (() => void)[] = [];
    const hold = () =>
      limited(
        () => new Promise<void>((resolve) => releases.push(() => resolve())),
      );
    const running = Array.from({ length: 32 }, hold);
    expect(limited(async () => "ok")).rejects.toThrow(Refused);
    for (const release of releases) release();
    await Promise.all(running);
    expect(await limited(async () => "ok")).toBe("ok");
  });
});

/*
 * **中継した中身を denpa のオリジンで動かさない。**
 *
 * 中身も形式も相手の言うまま (`text/html` や SVG も来る)。画面は fetch で読むので形式はそのまま渡し、
 * 直に開かれたときだけ効く守りを付ける
 */
describe("中継した答えの返し方", () => {
  test("形式はそのまま、sandbox の CSP と nosniff を付ける", async () => {
    const svg = "<svg><script>alert(1)</script></svg>";
    const response = relayed({
      status: 200,
      contentType: "image/svg+xml",
      body: new TextEncoder().encode(svg),
    });
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-bml-relayed")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // 中身には手を入れない
    expect(await response.text()).toBe(svg);
  });

  test("相手の符号と BML の形式はそのまま", () => {
    const response = relayed({
      status: 404,
      contentType: "text/X-arib-bml; charset=EUC-JP",
      body: new Uint8Array(),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/X-arib-bml; charset=EUC-JP",
    );
  });
});

describe("画面の通信からだけ受ける", () => {
  const request = (dest?: string) =>
    new Request("http://denpa.test/api/bml/proxy?url=https://example.jp/", {
      headers: dest === undefined ? {} : { "sec-fetch-dest": dest },
    });

  test("fetch・XHR (sec-fetch-dest: empty) と、送ってこない古いブラウザは通す", () => {
    expect(() => requireFetch(request("empty"))).not.toThrow();
    expect(() => requireFetch(request())).not.toThrow();
  });

  test("ページとして開く・iframe・img・script からは断る", () => {
    for (const dest of ["document", "iframe", "image", "script", "object"]) {
      let status: number | undefined;
      try {
        requireFetch(request(dest));
      } catch (failure) {
        status = (failure as { status?: number }).status;
      }
      expect(status, dest).toBe(403);
    }
  });
});
