import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import type { ResponseMessage } from "@danything/arib/bml-protocol";

import { crc32 } from "#lib/ts/png.js";

import { parseDrcs } from "./drcs";
import { isDrcs } from "./euc";
import { alphaPng, applyClut } from "./png";
import { refToPath, REMOTE, Resources, unknownScheme } from "./resources";
import { parseXml } from "./xml";

const media = (type: string, subtype: string) => ({
  type,
  originalType: type,
  subtype,
  originalSubtype: subtype,
  parameters: [],
});
const b64 = (text: string) => Buffer.from(text).toString("base64");

function pmt(...components: number[]): ResponseMessage {
  return {
    type: "pmt",
    components: components.map((componentId) => ({
      pid: 0x100 + componentId,
      componentId,
      streamType: 0x0d,
    })),
  };
}
function dii(
  component: number,
  modules: [number, number][],
  dataEventId = 1,
): ResponseMessage {
  return {
    type: "moduleListUpdated",
    componentId: component,
    modules: modules.map(([id, version]) => ({ id, version, size: 1 })),
    dataEventId,
  };
}
function module(
  component: number,
  id: number,
  version: number,
  files: [string, string][],
  dataEventId = 1,
): ResponseMessage {
  return {
    type: "moduleDownloaded",
    componentId: component,
    moduleId: id,
    version,
    dataEventId,
    files: files.map(([name, body]) => ({
      contentLocation: name,
      contentType: media("text", "plain"),
      dataBase64: b64(body),
    })),
  };
}

describe("カルーセルのファイル", () => {
  test("名前を解決する (絶対・相対・~・arib-dc・大文字小文字)", () => {
    const r = new Resources();
    const base = "/40/0000/startup.bml";
    expect(r.resolve("/40/0001/A.PNG", null)).toEqual({
      component: 0x40,
      module: 1,
      file: "a.png",
    });
    expect(r.resolve("a.bml", base)).toEqual({
      component: 0x40,
      module: 0,
      file: "a.bml",
    });
    expect(r.resolve("~/0FFF", base)).toEqual({
      component: 0x40,
      module: 0xfff,
      file: null,
    });
    expect(r.resolve("/50/0fFf/x.bml", base)).toEqual({
      component: 0x50,
      module: 0xfff,
      file: "x.bml",
    });
    expect(r.resolve("arib-dc://-1.-1.-1/40/0002/b.bml", null)).toEqual({
      component: 0x40,
      module: 2,
      file: "b.bml",
    });
    expect(r.resolve("../0003/c.bml", base)).toEqual({
      component: 0x40,
      module: 3,
      file: "c.bml",
    });
    expect(r.resolve("ftp://example.jp/", base)).toBeNull();
    expect(refToPath({ component: 0x40, module: 1, file: "a.bml" })).toBe(
      "/40/0001/a.bml",
    );
  });

  test("通信の名前: http・https は URL のまま。通信の文書の中の相対は文書の URL から、arib-dc:// は放送", () => {
    const r = new Resources();
    const remote = (url: string) => ({
      component: REMOTE,
      module: 0,
      file: null,
      url,
    });
    expect(
      r.resolve("http://example.jp/a.bml#top", "/40/0000/startup.bml"),
    ).toEqual(remote("http://example.jp/a.bml"));
    const base = "https://example.jp/d/menu.bml?x=1";
    expect(r.resolve("img/a.png", base)).toEqual(
      remote("https://example.jp/d/img/a.png"),
    );
    expect(r.resolve("/40/0000/b.bml", base)).toEqual(
      remote("https://example.jp/40/0000/b.bml"),
    );
    expect(r.resolve("next.bml?y=2", base)).toEqual(
      remote("https://example.jp/d/next.bml?y=2"),
    );
    expect(r.resolve("arib-dc://-1.-1.-1/40/0002/b.bml", base)).toEqual({
      component: 0x40,
      module: 2,
      file: "b.bml",
    });
    expect(r.resolve("~/0001/a.png", base)).toBeNull();
    expect(r.resolve("", base)).toBeNull();
    expect(refToPath(remote("https://example.jp/d/img/a.png"))).toBe(
      "https://example.jp/d/img/a.png",
    );
  });

  test("通信のものは中継から取って覚える。同じものを重ねて取らない。取れなければ null", async () => {
    const r = new Resources();
    const asked: string[] = [];
    r.remoteGet = async (url) => {
      asked.push(url);
      return url.endsWith("a.png")
        ? { contentType: "image/png", body: Uint8Array.of(1, 2) }
        : null;
    };
    const ref = r.resolve("https://example.jp/a.png", null)!;
    const [first, second] = await Promise.all([r.fetch(ref), r.fetch(ref)]);
    expect(first?.data).toEqual(Uint8Array.of(1, 2));
    expect(first?.type.subtype).toBe("png");
    expect(second).toBe(first);
    expect(r.file(ref)).toBe(first);
    expect(r.missing(ref)).toBe(false);
    expect(
      await r.fetch(r.resolve("https://example.jp/b.png", null)!),
    ).toBeNull();
    expect(asked).toEqual([
      "https://example.jp/a.png",
      "https://example.jp/b.png",
    ]);
  });

  test("refetch は覚えたものを使わずに取り直す (通信の文書へ移るとき)", async () => {
    const r = new Resources();
    let n = 0;
    r.remoteGet = async () => ({
      contentType: "text/X-arib-bml",
      body: Uint8Array.of(++n),
    });
    const ref = r.resolve("https://example.jp/vote.bml", null)!;
    expect((await r.fetch(ref))?.data).toEqual(Uint8Array.of(1));
    expect((await r.fetch(ref))?.data).toEqual(Uint8Array.of(1));
    expect((await r.refetch(ref))?.data).toEqual(Uint8Array.of(2));
    expect(r.file(ref)?.data).toEqual(Uint8Array.of(2));
  });

  test("上限 (64 個) を超えても、今の文書が使ったものは捨てない。文書を替えたら古いものから捨てる", async () => {
    const r = new Resources();
    r.remoteGet = async () => ({
      contentType: "image/png",
      body: Uint8Array.of(1),
    });
    const refs = Array.from({ length: 70 }, (_, i) =>
      r.resolve(`https://example.jp/${i}.png`, null)!,
    );
    for (const ref of refs) await r.fetch(ref);
    expect(refs.every((ref) => r.file(ref) !== null)).toBe(true);
    r.newPage();
    // 次の文書が 1 つ取ると、前の文書のぶんを上限まで捨てる (長く使っていないものから)
    await r.fetch(r.resolve("https://example.jp/next.png", null)!);
    expect(refs.filter((ref) => r.file(ref) !== null)).toHaveLength(63);
    expect(r.file(refs[0]!)).toBeNull();
  });

  test("届くのを待つ。DII に無いもの・PMT に無い部品は待たない", async () => {
    const r = new Resources();
    const receiving: boolean[] = [];
    r.onReceiving = (on) => receiving.push(on);
    r.feed(pmt(0x40));
    r.feed(dii(0x40, [[0, 1]]));
    const waiting = r.fetch({
      component: 0x40,
      module: 0,
      file: "startup.bml",
    });
    expect(receiving).toEqual([true]);
    r.feed(module(0x40, 0, 1, [["startup.bml", "<bml/>"]]));
    expect(new TextDecoder().decode((await waiting)?.data)).toBe("<bml/>");
    expect(receiving).toEqual([true, false]);
    expect(
      await r.fetch({ component: 0x40, module: 9, file: null }),
    ).toBeNull();
    expect(
      await r.fetch({ component: 0x50, module: 0, file: null }),
    ).toBeNull();
  });

  test("押さえたモジュールは版が上がっても持ち続ける。外すと新しい版", async () => {
    const r = new Resources();
    r.feed(pmt(0x40));
    r.feed(dii(0x40, [[1, 1]]));
    r.feed(module(0x40, 1, 1, [["a.txt", "old"]]));
    const statuses: number[] = [];
    expect(r.lock(0x40, 1, "lock", (s) => statuses.push(s))).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toEqual([0]);
    expect(r.lock(0x40, 1, "lockEx", () => {})).toBeNaN();
    r.feed(dii(0x40, [[1, 2]]));
    r.feed(module(0x40, 1, 2, [["a.txt", "new"]]));
    const read = () =>
      new TextDecoder().decode(
        r.file({ component: 0x40, module: 1, file: "a.txt" })?.data,
      );
    expect(read()).toBe("old");
    expect(r.locked()).toEqual([["/40/0001", false, false]]);
    r.unlock(0x40, 1);
    expect(read()).toBe("new");
  });

  test("DII に無いモジュールを Ex で押さえると -2、PMT に無ければ -3", async () => {
    const r = new Resources();
    r.feed(pmt(0x40));
    r.feed(dii(0x40, [[1, 1]]));
    const statuses: number[] = [];
    expect(r.lock(0x40, 5, "lockEx", (s) => statuses.push(s))).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toEqual([-2]);
    expect(r.lock(0x60, 0, "lockEx", () => {})).toBe(-3);
  });

  test("データイベントが変わったら前のものを捨てる", () => {
    const r = new Resources();
    r.feed(pmt(0x40));
    r.feed(dii(0x40, [[1, 1]], 1));
    r.feed(module(0x40, 1, 1, [["a.txt", "x"]], 1));
    const events = r.feed(dii(0x40, [[1, 1]], 2));
    expect(events[0]).toMatchObject({
      type: "dii",
      previous: { dataEventId: 1 },
      dii: { dataEventId: 2 },
    });
    expect(r.has(0x40, 1)).toBe(false);
  });
});

describe("DRCS・PNG", () => {
  test("DRCS: 字数 0 は空、4 階調の 16x16 を読む", () => {
    expect(parseDrcs(Uint8Array.of(0))).toEqual([]);
    // 1 字・87 区 1 点・字体 1 つ (fontId 1, mode 1)・深さ 2 (4 階調)・16x16
    const pixels = new Uint8Array(64).fill(0b11100100);
    const glyphs = parseDrcs(
      Uint8Array.from([1, 0x77, 0x21, 1, 0x11, 2, 16, 16, ...pixels]),
    );
    expect(glyphs.length).toBe(1);
    const [unit, glyph] = glyphs[0]!;
    expect(isDrcs(unit)).toBe(true);
    expect([glyph.fontId, glyph.width, glyph.height]).toEqual([1, 16, 16]);
    expect([...glyph.alpha.subarray(0, 4)]).toEqual([255, 170, 85, 0]);
  });

  test("PNG: CRC と、CLUT の PLTE・tRNS を差し込む", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    const mask = alphaPng(2, 1, Uint8Array.of(0, 255));
    const fixed = applyClut(mask, [[1, 2, 3, 4]]);
    expect(fixed?.width).toBe(2);
    // 灰 + 透明度の PNG (色の型 4) には手を入れない
    expect(fixed?.data.length).toBe(mask.length);
  });
});

describe("押さえ直し", () => {
  test("同じ種類で押さえ直すと今の版になり、通知は 1 回ずつ", async () => {
    const r = new Resources();
    r.feed(pmt(0x40));
    r.feed(dii(0x40, [[1, 1]]));
    r.feed(module(0x40, 1, 1, [["a.txt", "v1"]]));
    const statuses: number[] = [];
    r.lock(0x40, 1, "lock", (s) => statuses.push(s));
    await new Promise((resolve) => setTimeout(resolve, 0));
    r.feed(dii(0x40, [[1, 2]]));
    r.feed(module(0x40, 1, 2, [["a.txt", "v2"]]));
    expect(r.lock(0x40, 1, "lock", (s) => statuses.push(s))).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toEqual([0, 0]);
    expect(
      new TextDecoder().decode(
        r.file({ component: 0x40, module: 1, file: "a.txt" })?.data,
      ),
    ).toBe("v2");
  });
});

describe("PNG・DRCS・深い入れ子 (レビューで足したもの)", () => {
  /** PNG の塊の名前の並び */
  const chunks = (png: Uint8Array): string[] => {
    const names: string[] = [];
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    for (let at = 8; at + 12 <= png.length; at += 12 + view.getUint32(at)) {
      names.push(String.fromCharCode(...png.subarray(at + 4, at + 8)));
    }
    return names;
  };

  test("mask の PNG は zlib で戻せる (stored のブロックと Adler-32)", () => {
    const alpha = Uint8Array.from({ length: 40 * 40 }, (_, i) => i & 0xff);
    const png = alphaPng(40, 40, alpha);
    const view = new DataView(png.buffer);
    const idatAt = 8 + 12 + 13;
    const idat = png.subarray(idatAt + 8, idatAt + 8 + view.getUint32(idatAt));
    const raw = inflateSync(idat);
    expect(raw.length).toBe(40 * (1 + 40 * 2));
    // 2 行目 (y=1) の x=1 の透明度: 行の頭 81 + フィルタ 1 + 灰と透明度 2 × 1 + 灰 1
    expect(raw[81 + 1 + 2 + 1]).toBe(alpha[41]);
  });

  test("PLTE・tRNS は最初の IDAT の前 (gAMA の後ろ) に入れる", () => {
    const ihdr = Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0);
    const chunk = (name: string, body: Uint8Array) => {
      const out = new Uint8Array(12 + body.length);
      new DataView(out.buffer).setUint32(0, body.length);
      out.set(new TextEncoder().encode(name), 4);
      out.set(body, 8);
      return out;
    };
    const parts = [
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      chunk("IHDR", ihdr),
      chunk("gAMA", new Uint8Array(4)),
      chunk("IDAT", new Uint8Array(2)),
      chunk("IEND", new Uint8Array()),
    ];
    const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      png.set(p, at);
      at += p.length;
    }
    const fixed = applyClut(png, [[1, 2, 3, 255]]);
    expect(chunks(fixed!.data)).toEqual([
      "IHDR",
      "gAMA",
      "PLTE",
      "tRNS",
      "IDAT",
      "IEND",
    ]);
  });

  test("DRCS が途中で切れていても投げない", () => {
    expect(() =>
      parseDrcs(Uint8Array.of(2, 0x77, 0x21, 1, 0x11, 2, 16, 16, 0xff)),
    ).not.toThrow();
  });

  test("閉じない要素が延々と続いても、深さの上限で止まる", () => {
    const doc = parseXml(`<bml><body>${"<div>".repeat(100000)}x</body></bml>`);
    expect(doc?.name).toBe("bml");
    let depth = 0;
    for (
      let node = doc?.children[0];
      node?.kind === "element";
      node = node.children[0]
    )
      depth++;
    expect(depth).toBeLessThanOrEqual(64);
  });
});

describe("名前の書き方", () => {
  test("問い合わせ (?tsid=…) と断片は、ファイルを引くのに使わない", () => {
    const r = new Resources();
    expect(r.resolve("/40/0001/Next.bml?tsid=0x7FE1", null)).toEqual({
      component: 0x40,
      module: 1,
      file: "next.bml",
    });
    expect(
      r.resolve("next.bml?tsid=1&x=2#a", "/40/0002/startup.bml?y=1"),
    ).toEqual({
      component: 0x40,
      module: 2,
      file: "next.bml",
    });
    expect(r.resolve("~/0003/a.png?x", "/50/0000/startup.bml")).toEqual({
      component: 0x50,
      module: 3,
      file: "a.png",
    });
  });

  test("規格に無いスキーム (bml:// など) だけを「扱えない」と言う", () => {
    expect(unknownScheme("bml://startup.bml")).toBe("bml");
    expect(unknownScheme("BML://x")).toBe("bml");
    for (const known of [
      "arib-dc://-1.-1.-1/40/0000",
      "arib://-1.-1.-1",
      "nvram://local/0",
      "romsound://1",
      "http://a/",
      "https://a/",
    ])
      expect(unknownScheme(known)).toBeNull();
    expect(unknownScheme("/40/0000/startup.bml")).toBeNull();
    expect(unknownScheme("next.bml")).toBeNull();
    // 扱えない名前は解決できない (null)
    expect(
      new Resources().resolve("bml://startup.bml", "/40/0000/startup.bml"),
    ).toBeNull();
  });
});

describe("長く流し続けても持つものが増えない", () => {
  /** 作った blob: の URL の代わりに、返したものを数える */
  function countRevokes(): { revoked: string[]; restore: () => void } {
    const original = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    return {
      revoked,
      restore: () => {
        URL.revokeObjectURL = original;
      },
    };
  }

  test("版上げを何千回くり返しても、持つのは今の版だけで、作った URL は全部返す", () => {
    const { revoked, restore } = countRevokes();
    try {
      const r = new Resources();
      r.feed(pmt(0x40));
      let made = 0;
      for (let version = 1; version <= 5000; version++) {
        r.feed(dii(0x40, [[1, version & 0xff]], 1));
        r.feed(module(0x40, 1, version & 0xff, [["a.jpg", `v${version}`]]));
        // 描く側が URL を作ったことにする (engine.ts の image)
        const file = r.file({ component: 0x40, module: 1, file: "a.jpg" });
        file?.urls.set("raw", {
          url: `blob:${version}`,
          width: null,
          height: null,
        });
        made++;
      }
      expect(r.has(0x40, 1)).toBe(true);
      // 今の版の 1 つだけが残る
      expect(made - revoked.length).toBe(1);
      expect((r as unknown as { cache: Map<string, unknown> }).cache.size).toBe(
        1,
      );
    } finally {
      restore();
    }
  });

  test("PMT から消えた部品のモジュールは捨てて URL を返す (押さえたものは残す)", async () => {
    const { revoked, restore } = countRevokes();
    try {
      const r = new Resources();
      r.feed(pmt(0x40, 0x50, 0x60));
      r.feed(dii(0x50, [[0, 1]]));
      r.feed(module(0x50, 0, 1, [["a.jpg", "x"]]));
      r.file({ component: 0x50, module: 0, file: "a.jpg" })?.urls.set("raw", {
        url: "blob:50",
        width: null,
        height: null,
      });
      r.feed(dii(0x60, [[0, 1]]));
      r.feed(module(0x60, 0, 1, [["b.jpg", "y"]]));
      r.lock(0x60, 0, "lockEx", () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      r.feed(pmt(0x40));
      expect(r.has(0x50, 0)).toBe(false);
      expect(revoked).toEqual(["blob:50"]);
      // 押さえたものは押さえた側が持つ (外すまで読める)
      expect(
        r.file({ component: 0x60, module: 0, file: "b.jpg" }),
      ).not.toBeNull();
    } finally {
      restore();
    }
  });
});
