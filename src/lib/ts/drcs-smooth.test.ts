import { describe, expect, test } from "bun:test";

import {
  boxDown,
  collapseDoubled,
  decodeGrey,
  type Grey,
  pack4,
  scale2x,
  smoothDrcs,
} from "./drcs-smooth";

/** `size`x`size` の白黒の画像を、放送の詰め方 (1画素1ビット) で作る。`scale` 倍に水増しして送る放送を真似る */
function pack(
  size: number,
  on: (x: number, y: number) => boolean,
  scale = 1,
): Uint8Array {
  const side = size * scale;
  const bytes = new Uint8Array(Math.ceil((side * side) / 8));
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (!on(Math.floor(x / scale), Math.floor(y / scale))) continue;
      const i = y * side + x;
      bytes[i >> 3]! |= 0x80 >> (i & 7);
    }
  }
  return bytes;
}

/** 濃さの画像を作る。`#` は 255、`.` は 0 */
function grey(rows: string[]): Grey {
  const width = rows[0]?.length ?? 0;
  const pixels = Uint8Array.from(rows.join(""), (c) => (c === "#" ? 255 : 0));
  return { width, height: rows.length, pixels };
}

function rows(g: Grey): string[] {
  return Array.from({ length: g.height }, (_, y) =>
    [...g.pixels.subarray(y * g.width, (y + 1) * g.width)]
      .map((v) => (v === 255 ? "#" : v === 0 ? "." : "+"))
      .join(""),
  );
}

/** 送る画像を濃さの画像に開き直す */
function sent(
  size: number,
  on: (x: number, y: number) => boolean,
  scale = 1,
): Grey {
  const drcs = smoothDrcs(
    size * scale,
    size * scale,
    2,
    1,
    pack(size, on, scale),
  );
  expect(drcs).toMatchObject({ depth: 16, bits: 4 });
  return decodeGrey(
    drcs.w,
    drcs.h,
    drcs.depth,
    drcs.bits,
    Uint8Array.from(Buffer.from(drcs.data, "base64")),
  );
}

const at = (g: Grey, x: number, y: number) => g.pixels[y * g.width + x]!;

describe("decodeGrey", () => {
  test("1画素 bits ビットを上の桁から読み、v / (depth - 1) の濃さにする", () => {
    expect([
      ...decodeGrey(4, 1, 2, 1, Uint8Array.from([0b1010_0000])).pixels,
    ]).toEqual([255, 0, 255, 0]);
    expect([
      ...decodeGrey(4, 1, 4, 2, Uint8Array.from([0b00_01_10_11])).pixels,
    ]).toEqual([0, 85, 170, 255]);
  });
});

describe("collapseDoubled", () => {
  test("縦横 2 倍に水増しされた画像を元の大きさに戻す", () => {
    const small = grey(["#..", ".#.", "..#", "##."]);
    const doubled = grey([
      "##....",
      "##....",
      "..##..",
      "..##..",
      "....##",
      "....##",
      "####..",
      "####..",
    ]);
    expect(rows(collapseDoubled(doubled))).toEqual(rows(small));
  });

  test("4 倍でも畳み切る。片方だけ水増しなら片方だけ畳む", () => {
    expect(
      rows(collapseDoubled(grey(["####", "####", "....", "...."]))),
    ).toEqual(["#", "."]);
    expect(rows(collapseDoubled(grey(["##..", "..##", "##.."])))).toEqual([
      "#.",
      ".#",
      "#.",
    ]);
  });

  test("水増しでない画像はそのまま", () => {
    const g = grey(["#.", ".#"]);
    expect(collapseDoubled(g)).toBe(g);
  });
});

describe("scale2x", () => {
  test("斜めに接する点の間を埋める", () => {
    expect(rows(scale2x(grey(["....", ".#..", "..#.", "...."])))).toEqual([
      "........",
      "........",
      "..##....",
      "..###...",
      "...###..",
      "....##..",
      "........",
      "........",
    ]);
  });

  test("縦横の線と塗りは 2 倍にするだけ (縁に接した角も欠けない)", () => {
    expect(rows(scale2x(grey(["...", "###", "..."])))).toEqual([
      "......",
      "......",
      "######",
      "######",
      "......",
      "......",
    ]);
    expect(rows(scale2x(grey(["##.", "##."])))).toEqual([
      "####..",
      "####..",
      "####..",
      "####..",
    ]);
  });

  test("縁へ抜ける斜めの線に余計な点を付けない (画像の外は縁で折り返して見る)", () => {
    expect(rows(scale2x(grey(["#.", ".#"])))).toEqual([
      "##..",
      "##..",
      "..##",
      "..##",
    ]);
  });
});

describe("boxDown", () => {
  test("n x n ずつ平均する", () => {
    expect([...boxDown(grey(["#.##", "..##"]), 2).pixels]).toEqual([64, 255]);
  });
});

describe("smoothDrcs", () => {
  test("2 倍で送られた 18x18 の斜めの線は、階段が細かくなり縁に中間の濃さが付く", () => {
    // (2,2)〜(15,15)。送る画像では 8〜63 の行に載る。両端の丸まったところ (元の1点ぶん) は見ない
    const line = sent(18, (x, y) => x === y && x >= 2 && x < 16, 2);
    expect([line.width, line.height]).toEqual([72, 72]);
    let partial = false;
    let prev = -1;
    for (let y = 12; y < 60; y++) {
      let left = -1;
      for (let x = 0; x < 72; x++) {
        const v = at(line, x, y);
        if (v > 0 && v < 255) partial = true;
        if (left < 0 && v >= 128) left = x;
      }
      expect(left).toBeGreaterThanOrEqual(0);
      // そのまま引き伸ばすと 4 画素ずつの階段になる
      if (prev >= 0) expect([0, 1, 2]).toContain(left - prev);
      prev = left;
    }
    expect(partial).toBe(true);
    expect(at(line, 8, 63)).toBe(0);
    expect(at(line, 63, 8)).toBe(0);
  });

  test("全部塗った画像は縁まで塗ったまま", () => {
    const block = sent(18, () => true, 2);
    expect(new Set(block.pixels)).toEqual(new Set([255]));
  });

  test("縦横の線はぼけない (縁の途中は 0 か 255 だけ)", () => {
    const box = sent(18, (x, y) => x >= 4 && x < 14 && y >= 4 && y < 14, 2);
    expect(at(box, 36, 36)).toBe(255);
    expect(at(box, 8, 8)).toBe(0);
    // 辺の真ん中あたりの行・列を横切る
    for (let i = 0; i < 72; i++) {
      const inside = i >= 16 && i < 56;
      expect(at(box, i, 36)).toBe(inside ? 255 : 0);
      expect(at(box, 36, i)).toBe(inside ? 255 : 0);
    }
  });

  test("一辺 64 に届くまで 2 倍ずつ。256 は超えない", () => {
    /** 斜めの線 (畳めない) を `size`x`size` で送ったときの、送る画像の大きさ */
    const sizeOf = (size: number) => {
      const drcs = smoothDrcs(
        size,
        size,
        2,
        1,
        pack(size, (x, y) => x === y),
      );
      return [drcs.w, drcs.h];
    };
    expect(sizeOf(16)).toEqual([64, 64]);
    expect(sizeOf(36)).toEqual([72, 72]);
    expect(sizeOf(200)).toEqual([200, 200]);
    const wide = smoothDrcs(255, 1, 2, 1, new Uint8Array(32).fill(0xaa));
    expect([wide.w, wide.h]).toEqual([255, 1]);
  });

  test("読めない画像 (大きさ 0・知らない bits) はそのまま渡す", () => {
    expect(smoothDrcs(0, 0, 2, 1, new Uint8Array())).toEqual({
      w: 0,
      h: 0,
      depth: 2,
      bits: 1,
      data: "",
    });
    expect(smoothDrcs(2, 2, 8, 3, Uint8Array.from([0xff, 0xff]))).toMatchObject(
      {
        w: 2,
        h: 2,
        depth: 8,
        bits: 3,
      },
    );
  });
});

describe("pack4", () => {
  test("16 階調にして1画素4ビットで詰める (左の画素が上の桁。奇数なら最後の下の桁は 0)", () => {
    const g = { width: 3, height: 1, pixels: Uint8Array.from([255, 0, 128]) };
    expect([...pack4(g)]).toEqual([0xf0, 0x80]);
  });
});
