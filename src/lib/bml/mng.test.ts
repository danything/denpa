import { describe, expect, test } from "bun:test";
import { DEFAULT_CLUT } from "./clut";
import { parseMng, visibleFrames } from "./mng";
import { chunk, defi, fram, frame, MHDR, mng, u32 } from "./mng.fixture";
import { applyClut } from "./png";

describe("MNG", () => {
  test("コマに分け、置き場所・間隔・重ね方・くり返しを読む", () => {
    const data = mng([
      MHDR,
      chunk("TERM", [3, 0, ...u32(0), ...u32(0x7fffffff)]),
      fram(1, 50),
      defi(10, 20),
      ...frame(),
      defi(-4, 0),
      ...frame(),
      fram(3, 25),
      ...frame(),
      chunk("MEND", []),
    ]);
    const parsed = parseMng(data);
    expect(parsed).not.toBeNull();
    expect(parsed!.width).toBe(64);
    expect(parsed!.height).toBe(32);
    expect(parsed!.iterations).toBe(Number.POSITIVE_INFINITY);
    expect(parsed!.frames.map((f) => [f.x, f.y, f.delay, f.keep])).toEqual([
      [10, 20, 500, true],
      [-4, 0, 500, true],
      [-4, 0, 250, false],
    ]);
    // 1 コマずつ PNG として読める (CLUT の色が入る)
    const png = applyClut(parsed!.frames[0]!.png, DEFAULT_CLUT);
    expect(png?.width).toBe(2);
    expect(png?.height).toBe(1);
    const names: string[] = [];
    for (let at = 8; at + 8 <= png!.data.length;) {
      const length = new DataView(png!.data.buffer).getUint32(at);
      names.push(String.fromCharCode(...png!.data.subarray(at + 4, at + 8)));
      at += 12 + length;
    }
    expect(names).toEqual(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
  });

  test("名前の付いた FRAM でも間隔を読む", () => {
    const named = chunk("FRAM", [1, 0x61, 0x62, 0, 2, 0, 0, 0, ...u32(30)]);
    expect(
      parseMng(mng([MHDR, named, ...frame(), chunk("MEND", [])]))?.frames[0]
        ?.delay,
    ).toBe(300);
  });

  test("TERM が無ければ 1 回、回数があればその回数。間隔 0 でも下限を置く", () => {
    expect(
      parseMng(mng([MHDR, fram(1, 0), ...frame(), chunk("MEND", [])]))
        ?.iterations,
    ).toBe(1);
    expect(
      parseMng(mng([MHDR, fram(1, 0), ...frame(), chunk("MEND", [])]))
        ?.frames[0]?.delay,
    ).toBe(20);
    const three = mng([
      MHDR,
      chunk("TERM", [3, 0, ...u32(0), ...u32(3)]),
      ...frame(),
      chunk("MEND", []),
    ]);
    expect(parseMng(three)?.iterations).toBe(3);
    // 終わり方が 3 (最初から) でなければくり返さない
    const once = mng([
      MHDR,
      chunk("TERM", [0, 0, ...u32(0), ...u32(3)]),
      ...frame(),
      chunk("MEND", []),
    ]);
    expect(parseMng(once)?.iterations).toBe(1);
    // 場所を省いた DEFI は 0, 0 に戻る
    const reset = mng([
      MHDR,
      defi(5, 6),
      ...frame(),
      chunk("DEFI", [0, 0]),
      ...frame(),
      chunk("MEND", []),
    ]);
    expect(parseMng(reset)?.frames.map((f) => [f.x, f.y])).toEqual([
      [5, 6],
      [0, 0],
    ]);
  });

  test("MNG でない・コマが無いものは null", () => {
    expect(parseMng(Uint8Array.of(1, 2, 3))).toBeNull();
    expect(parseMng(mng([MHDR, chunk("MEND", [])]))).toBeNull();
    // 途中で切れていても、そこまでのコマは読む
    const cut = mng([MHDR, ...frame(), ...frame()]);
    expect(parseMng(cut.subarray(0, cut.length - 5))?.frames.length).toBe(1);
  });

  test("重ねて見えるコマ (消してから描くコマからやり直す)", () => {
    const a = { keep: true };
    const b = { keep: true };
    const c = { keep: false };
    const d = { keep: true };
    const frames = [a, b, c, d];
    expect(visibleFrames(frames, 0)).toEqual([a]);
    expect(visibleFrames(frames, 1)).toEqual([a, b]);
    expect(visibleFrames(frames, 2)).toEqual([c]);
    expect(visibleFrames(frames, 3)).toEqual([c, d]);
  });
});
