import { describe, expect, test } from "bun:test";

import {
  decodeHtml,
  frameMessage,
  prepareApp,
  receiverKey,
  type ShimInit,
  storageKey,
} from "./app";

const INIT: ShimInit = {
  url: "https://hc.example.jp/app/index.html",
  organisationId: 0x10,
  applicationId: 1,
  storage: { a: "</script><script>alert(1)</script>" },
  state: { program: null, serviceName: "", captions: true },
  relay: {
    root: "https://denpa.example/api/bml/hc/0123/",
    origin: "https://hc.example.jp",
  },
  compat: {
    greg: [],
    nvram: {},
    receiver: { zipcode: "", prefecture: 255 },
    who: { originalNetworkId: null, serviceId: null },
  },
};

/** 束ねた `compat.ts` の代わり */
const COMPAT = "/* compat */";

describe("prepareApp", () => {
  test("<head> の直後に <base> と差し込みを入れる (doctype は先頭のまま)", () => {
    const html = prepareApp(
      "<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>",
      INIT,
      COMPAT,
    );
    expect(
      html.startsWith(
        '<!DOCTYPE html><html><head><base href="https://denpa.example/api/bml/hc/0123/app/index.html"><script>(',
      ),
    ).toBe(true);
    expect(html.indexOf("<title>")).toBeGreaterThan(html.indexOf("</script>"));
  });

  test("アプリ自身の <base> は、アプリの URL から解決したものを先に置く", () => {
    const html = prepareApp(
      '<html><head><base href="../common/"></head></html>',
      INIT,
      COMPAT,
    );
    expect(html).toContain(
      '<base href="https://denpa.example/api/bml/hc/0123/common/">',
    );
  });

  test("記憶の中身で差し込みの script が切れない", () => {
    const html = prepareApp("<head></head>", INIT, COMPAT);
    // </script> は差し込みと、その後ろの `compat.ts` の 2 つだけ
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain(`</script><script>${COMPAT}</script>`);
  });

  /*
   * **http のアプリは中継を通す** (NHK は http にしか無く、https の画面からは Mixed Content で止められる)。
   * <base> と HTML に直に書かれた配信元の URL を中継へ。ほかの配信元は触らない
   */
  test("http のアプリは <base> と配信元の URL を中継へ書き換える", () => {
    const html = prepareApp(
      '<html><head><script src="http://hc.example.jp/common/a.js"></script><img src="http://other.example/b.png"></head></html>',
      {
        ...INIT,
        url: "http://hc.example.jp/p/index.html",
        relay: {
          root: "https://denpa.example/api/bml/hc/0123/",
          origin: "http://hc.example.jp",
        },
      },
      COMPAT,
    );
    expect(html).toContain(
      '<base href="https://denpa.example/api/bml/hc/0123/p/index.html">',
    );
    expect(html).toContain(
      '<script src="https://denpa.example/api/bml/hc/0123/common/a.js">',
    );
    expect(html).toContain("http://other.example/b.png");
    // `/` から始まる住所も中継の頭へ (NHK のアプリはこう書く)。`//` から始まるものは別の配信元なので触らない
    const rooted = prepareApp(
      '<head><script src="/common/b.js"></script><img src="//cdn.example/c.png"></head>',
      {
        ...INIT,
        url: "http://hc.example.jp/p/index.html",
        relay: {
          root: "https://denpa.example/api/bml/hc/0123/",
          origin: "http://hc.example.jp",
        },
      },
      COMPAT,
    );
    expect(rooted).toContain(
      '<script src="https://denpa.example/api/bml/hc/0123/common/b.js">',
    );
    expect(rooted).toContain('src="//cdn.example/c.png"');
    // a の行き先は触らない
    const links = prepareApp(
      `<head></head><a href="/x">x</a><script>var s = '<img src="/y">';</script>`,
      {
        ...INIT,
        url: "http://hc.example.jp/p/index.html",
        relay: {
          root: "https://denpa.example/api/bml/hc/0123/",
          origin: "http://hc.example.jp",
        },
      },
      COMPAT,
    );
    expect(links).toContain('<a href="/x">');
    // 差し込みには元の URL を渡す (getAITInfo は元の行き先を返す)
    expect(html).toContain('"url":"http://hc.example.jp/p/index.html"');
  });

  test("head も html も無ければ頭に入れる", () => {
    expect(prepareApp("<p>x</p>", INIT, COMPAT).startsWith("<base ")).toBe(
      true,
    );
  });
});

test("decodeHtml は content-type、無ければ meta の charset で読む", () => {
  const sjis = Uint8Array.of(0x82, 0xa0); // 「あ」
  expect(decodeHtml(sjis, "text/html; charset=Shift_JIS")).toBe("あ");
  const meta = new Uint8Array([
    ...new TextEncoder().encode('<meta charset="shift_jis">'),
    0x82,
    0xa0,
  ]);
  expect(decodeHtml(meta, "text/html").endsWith("あ")).toBe(true);
  expect(decodeHtml(new TextEncoder().encode("あ"), "text/html")).toBe("あ");
});

test("frameMessage は別のページへの移動を http(s) のときだけ受ける", () => {
  expect(
    frameMessage({
      hc: 1,
      type: "navigate",
      url: "https://hc.example.jp/top/index.html",
    }),
  ).toEqual({
    type: "navigate",
    url: "https://hc.example.jp/top/index.html",
  });
  expect(
    frameMessage({ hc: 1, type: "navigate", url: "javascript:alert(1)" }),
  ).toBeNull();
});

test("frameMessage は形式の合わないものを捨てる", () => {
  expect(frameMessage({ type: "close" })).toBeNull();
  expect(frameMessage({ hc: 1, type: "close" })).toEqual({ type: "close" });
  expect(
    frameMessage({ hc: 1, type: "fetch", id: "x", url: "a", method: "GET" }),
  ).toBeNull();
  expect(frameMessage({ hc: 1, type: "tune", onid: 1, sid: 2 })).toEqual({
    type: "tune",
    onid: 1,
    tsid: null,
    sid: 2,
  });
  expect(
    frameMessage({ hc: 1, type: "store", items: { a: "b", c: 1 } }),
  ).toEqual({
    type: "store",
    items: { a: "b" },
  });
  expect(frameMessage({ hc: 1, type: "unknown" })).toBeNull();
  expect(frameMessage({ hc: 1, type: "video", place: "other" })).toBeNull();
  expect(
    frameMessage({
      hc: 1,
      type: "video",
      place: { left: "x", top: 1, width: 2, height: 3 },
    }),
  ).toEqual({
    type: "video",
    place: { left: 0, top: 1, width: 2, height: 3 },
  });
  expect(
    frameMessage({
      hc: 1,
      type: "fetch",
      id: 1,
      url: "a",
      method: "GET",
      body: "x",
    }),
  ).toMatchObject({
    body: null,
  });
});

test("frameMessage は Greg の番号と NVRAM の中身を確かめる", () => {
  expect(
    frameMessage({ hc: 1, type: "greg", index: 55, value: "nhk:x" }),
  ).toEqual({
    type: "greg",
    index: 55,
    value: "nhk:x",
  });
  expect(
    frameMessage({ hc: 1, type: "greg", index: 64, value: "x" }),
  ).toBeNull();
  expect(
    frameMessage({ hc: 1, type: "greg", index: 1.5, value: "x" }),
  ).toBeNull();
  expect(
    frameMessage({ hc: 1, type: "nvram", key: "group:00:14", value: 1 }),
  ).toBeNull();
});

test("receiverKey:色ボタンは 403〜406、戻ると d は閉じる", () => {
  expect(receiverKey(22)).toEqual({ key: "r", code: 403 });
  expect(receiverKey(21)).toEqual({ key: "b", code: 406 });
  expect(receiverKey(18)).toEqual({ key: "Enter", code: 13 });
  expect(receiverKey(7)).toEqual({ key: "2", code: 50 });
  expect(receiverKey(19)).toBeNull();
  expect(receiverKey(20)).toBeNull();
});

test("記憶の置き場はアプリの配信元 (オリジン) ごと。AIT が名乗る番号では分けない", () => {
  expect(storageKey("https://hc.example.jp/app/index.html")).toBe(
    "denpa_hybridcast_https://hc.example.jp",
  );
  // 同じ配信元のページは同じ置き場、別の配信元は別の置き場
  expect(storageKey("https://hc.example.jp/other.html")).toBe(
    storageKey("https://hc.example.jp/app/index.html"),
  );
  expect(storageKey("http://hc.example.jp/app/index.html")).not.toBe(
    storageKey("https://hc.example.jp/app/index.html"),
  );
  expect(storageKey("https://evil.example/app/index.html")).not.toBe(
    storageKey("https://hc.example.jp/app/index.html"),
  );
  // オリジンが "null" になるものどうしを混ぜない
  expect(storageKey("data:text/html,a")).not.toBe(
    storageKey("data:text/html,b"),
  );
});
