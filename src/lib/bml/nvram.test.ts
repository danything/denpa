import { describe, expect, test } from "bun:test";

import {
  parseStructure,
  readFields,
  Table,
  writeFields,
  zipIncludes,
  type ZipRanges,
} from "./binary";
import { decodeEuc, encodeEuc } from "./euc";
import { Nvram } from "./nvram";
import { decodeAiff } from "./sound";

describe("2 進の表", () => {
  test("U/S/B/I/P と行の長さ", () => {
    // 行: 長さ 1 バイト + U:4b + B:1b + P:3b + S:2B + I:1B
    const row = (n: number, text: string, i: number) => [
      4,
      (n << 4) | 0x08,
      ...Buffer.from(text),
      i & 0xff,
    ];
    const table = new Table(
      Uint8Array.from([...row(3, "ab", -1), ...row(15, "cd", 5)]),
      "1,U:4b,B:1b,P:3b,S:2B,I:1B",
      decodeEuc,
    );
    expect(table.fields.length).toBe(4);
    expect(table.rows).toEqual([
      [3, true, "ab", -1],
      [15, true, "cd", 5],
    ]);
    const [found, last] = table.search(0, [[0, 10, 4]], false, 5)!;
    // 型に合わない演算子・件数 0 は使えない
    expect(table.search(0, [[0, 10, 32]], false, 5)).toBeNull();
    expect(table.search(0, [[0, 10, 4]], false, 0)).toBeNull();
    expect(found).toEqual([[15, true, "cd", 5]]);
    expect(last).toBe(-1);
  });

  test("書いて読み戻す。足りない文字列は空白で埋める", () => {
    const fields = parseStructure("U:8b,S:4B,S:1V,B:1b,P:7b")!;
    const data = writeFields([200, "あ", "xyz", true], fields, encodeEuc);
    expect([...data.subarray(1, 5)]).toEqual([0xa4, 0xa2, 0x20, 0x20]);
    expect(readFields(data, fields, decodeEuc)[0]).toEqual([
      200,
      "あ  ",
      "xyz",
      true,
    ]);
  });

  test("郵便番号の範囲", () => {
    // 長さ 9、除く 0、含む: 上 2 桁 10〜10 と、7 桁の 1500001
    const zip = readFields(
      Uint8Array.of(10, 9, 0, 0x0a, 0x0a, 0x00, 0x00, 0x8f, 0xd0, 0x00, 0x01),
      parseStructure("Z:1V")!,
      decodeEuc,
    )[0][0] as ZipRanges;
    expect(zipIncludes(zip, 1000001)).toBe(true);
    expect(zipIncludes(zip, 2000000)).toBe(false);
  });

  test("書式に大きな長さを書かれても、1 ビットずつ回さない", () => {
    const started = performance.now();
    // 真偽は長くても、ある分だけ見る。値 (U) は 32 ビットまで
    expect(
      readFields(
        Uint8Array.of(0, 0, 1),
        parseStructure("B:1000000000B")!,
        decodeEuc,
      )[0],
    ).toEqual([true]);
    expect(
      () => new Table(Uint8Array.of(1, 2, 3), "0,S:2000000000V", decodeEuc),
    ).toThrow();
    expect(
      () => new Table(Uint8Array.of(1, 2, 3), "9,U:8b", decodeEuc),
    ).toThrow();
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("NVRAM", () => {
  const store = (): Map<string, string> => new Map();
  const make = (
    kept: Map<string, string>,
    onid = 0x7fe1,
    zipcode = "1000001",
  ) =>
    new Nvram(
      { get: (k) => kept.get(k) ?? null, set: (k, v) => kept.set(k, v) },
      () => ({ zipcode, prefecture: 255 }),
      () => ({ originalNetworkId: onid, serviceId: 0x400 }),
    );

  test("局ごとの領域に書いて読む。別の局からは見えない", () => {
    const kept = store();
    expect(
      make(kept).write("nvram://local_web/0", "U:8b,S:4B", [7, "ab"]),
    ).toBe(5);
    expect(make(kept).read("nvram://local_web/0", "U:8b,S:4B")).toEqual([
      7,
      "ab  ",
    ]);
    expect(make(kept, 0x7fe2).read("nvram://local_web/0", "U:8b,S:4B")).toEqual(
      [0, ""],
    );
  });

  test("系列 (NN;group) と共通の領域、ブロックの範囲", () => {
    const kept = store();
    expect(make(kept).write("nvram://0a;group/3", "S:2B", ["zz"])).toBe(2);
    expect(make(kept, 0x7fe2).read("nvram://0a;group/3", "S:2B")).toEqual([
      "zz",
    ]);
    expect(make(kept).write("nvram://tr_common/32", "S:2B", ["x"])).toBeNaN();
    expect(make(kept).check("nvram://local/63")).toBe(2);
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(make(kept).write(`nvram://${name}/0`, "S:2B", ["x"])).toBeNaN();
      expect(make(kept).read(`nvram://${name}/0`, "S:2B")).toBeNull();
    }
  });

  test("郵便番号は渡されたものを読む (書いても変わらない)", () => {
    expect(make(store()).read("nvram://receiverinfo/zipcode", "S:7B")).toEqual([
      "1000001",
    ]);
    expect(
      make(store(), 1, "").read("nvram://receiverinfo/zipcode", "S:7B"),
    ).toEqual([""]);
    expect(
      make(store()).read("nvram://receiverinfo/prefecture", "U:1B"),
    ).toEqual([255]);
  });

  test("NHK のように U:1B を 16 個、配列で書く", () => {
    const kept = store();
    const structure = Array(16).fill("U:1B").join(",");
    expect(
      make(kept).write("nvram://local/1", structure, Array(16).fill(0)),
    ).toBe(16);
  });

  test("BS の事業者の領域 (~) は 0〜15 番・1 ブロック 64 バイト。外れたら失敗にして知らせる (TR-B15 8.2)", () => {
    const kept = store();
    const logs: string[] = [];
    const bs = new Nvram(
      { get: (k) => kept.get(k) ?? null, set: (k, v) => kept.set(k, v) },
      () => ({ zipcode: "", prefecture: 255 }),
      () => ({ originalNetworkId: 4, serviceId: 171 }),
      (message) => logs.push(message),
    );
    // BSテレ東の書き方: 番号を計算し、64 バイト近い並びを書く (U:1B × 5 + S:19B × 3 = 62 バイト)
    const structure = "U:1B,U:1B,U:1B,U:1B,U:1B,S:19B,S:19B,S:19B";
    const x = 13;
    const values = [1, 2, 3, 4, 5, "a", "b", "c"];
    expect(bs.write(`nvram://~/${x + 2}`, structure, values)).toBe(62);
    expect(bs.read(`nvram://~/${x + 2}`, structure)?.slice(0, 6)).toEqual([
      1,
      2,
      3,
      4,
      5,
      `a${" ".repeat(18)}`,
    ]);
    expect(logs).toEqual([]);
    // 64 バイトちょうどは書ける。超えたら NaN
    expect(bs.write("nvram://~/0", "S:64B", ["x"])).toBe(64);
    expect(bs.write("nvram://~/0", "S:65B", ["x"])).toBeNaN();
    // 16 番からは ~/ext (16〜63)
    expect(bs.write("nvram://~/16", "S:1B", ["x"])).toBeNaN();
    expect(bs.read("nvram://~/16", "S:1B")).toBeNull();
    expect(bs.write("nvram://~/ext/16", "S:1B", ["x"])).toBe(1);
    expect(logs.length).toBe(3);
    expect(logs[0]).toContain("64 バイト");
    expect(logs[1]).toContain("~ は 0〜15");
  });
});

describe("AIFF", () => {
  test("AIFF-C の PCM を読む", () => {
    const pcm = Uint8Array.of(0x40, 0x00, 0xc0, 0x00);
    const chunk = (id: string, body: number[]) => [
      ...Buffer.from(id),
      0,
      0,
      0,
      body.length,
      ...body,
    ];
    // 12000 Hz の 80 ビット浮動小数
    const rate = [0x40, 0x0c, 0xbb, 0x80, 0, 0, 0, 0, 0, 0];
    const comm = chunk("COMM", [
      0,
      1,
      0,
      0,
      0,
      2,
      0,
      16,
      ...rate,
      ...Buffer.from("NONE"),
      0,
      0,
    ]);
    const ssnd = chunk("SSND", [0, 0, 0, 0, 0, 0, 0, 0, ...pcm]);
    const body = [...Buffer.from("AIFC"), ...comm, ...ssnd];
    const aiff = Uint8Array.from([
      ...Buffer.from("FORM"),
      0,
      0,
      0,
      body.length,
      ...body,
    ]);
    const decoded = decodeAiff(aiff);
    expect(decoded?.rate).toBe(12000);
    expect([...(decoded?.samples ?? [])]).toEqual([0.5, -0.5]);
  });
});

describe("AIFF の不正な中身", () => {
  test("読めないものは null (投げない)", () => {
    const form = (body: number[]) =>
      Uint8Array.from([...Buffer.from("FORM"), 0, 0, 0, body.length, ...body]);
    expect(decodeAiff(Uint8Array.of(1, 2, 3))).toBeNull();
    // 大きさが巨大な塊
    expect(
      decodeAiff(
        form([
          ...Buffer.from("AIFC"),
          ...Buffer.from("COMM"),
          0x7f,
          0xff,
          0xff,
          0xff,
        ]),
      ),
    ).toBeNull();
    // 標本化周波数が範囲の外 (1 Hz)
    const comm = [
      ...Buffer.from("COMM"),
      0,
      0,
      0,
      24,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      16,
      0x3f,
      0xff,
      0x80,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...Buffer.from("NONE"),
      0,
      0,
    ];
    const ssnd = [
      ...Buffer.from("SSND"),
      0,
      0,
      0,
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      2,
    ];
    expect(
      decodeAiff(form([...Buffer.from("AIFC"), ...comm, ...ssnd])),
    ).toBeNull();
  });
});
