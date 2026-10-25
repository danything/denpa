import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isScrambled, readCardStatus, scrambledRatio } from "./scramble";

// カードの番号は必ず架空のものにする (本物のカードの番号を載せない)
const PACKET = 188;

/** 指定した割合だけスクランブルの印を立てたTSを作る */
function makeTs(packets: number, scrambledRatio: number): string {
  const buffer = Buffer.alloc(PACKET * packets);
  for (let i = 0; i < packets; i++) {
    const at = i * PACKET;
    buffer[at] = 0x47;
    buffer[at + 1] = 0x01;
    buffer[at + 2] = 0x00;
    // 4バイト目の上位2ビットが transport_scrambling_control
    buffer[at + 3] = i / packets < scrambledRatio ? 0x90 : 0x10;
  }
  const path = join(
    mkdtempSync(join(tmpdir(), "denpa-scramble-")),
    "sample.ts",
  );
  writeFileSync(path, buffer);
  return path;
}

describe("スクランブルの検出", () => {
  test("復号できていれば0", () => {
    expect(scrambledRatio(makeTs(2000, 0))).toBe(0);
  });

  test("カードが読めていないと ほぼ全部 になる", () => {
    // 実機で壊れていたときは 98〜99% だった
    expect(scrambledRatio(makeTs(2000, 0.99))).toBeCloseTo(0.99, 2);
    expect(isScrambled(makeTs(2000, 0.99))).toBe(true);
  });

  test("一部だけ掛かっていても復号には回さない", () => {
    // 有料放送の一部だけが暗号のTSを復号に回すと、無駄に時間を食う
    expect(isScrambled(makeTs(2000, 0.2))).toBe(false);
  });

  test("同期が取れないファイルは判定しない", () => {
    // mkv などを渡されても復号に回さない
    const path = join(
      mkdtempSync(join(tmpdir(), "denpa-scramble-")),
      "not-ts.bin",
    );
    writeFileSync(path, Buffer.alloc(PACKET * 500, 0xff));
    expect(scrambledRatio(path)).toBe(0);
  });

  test("無いファイルは0", () => {
    expect(scrambledRatio("/tmp/denpa-does-not-exist.ts")).toBe(0);
  });
});

describe("カードリーダーの状態", () => {
  test("リーダーごとに 使用中・予備・カードなし・エラー を分ける", () => {
    const card = readCardStatus({
      ok: true,
      message: "",
      source: "local",
      readers: [
        {
          name: "A",
          card: true,
          ids: ["0000000000000001"],
          active: true,
          tuners: ["PT3-T1"],
        },
        {
          name: "B",
          card: true,
          ids: ["0000000000000002"],
          active: false,
          tuners: [],
        },
        { name: "C", card: false, ids: [], active: false, tuners: [] },
        {
          name: "D",
          card: false,
          ids: [],
          active: false,
          tuners: [],
          error: "使えません",
        },
      ],
    });
    expect(card.readers.map((r) => r.state)).toEqual([
      "active",
      "standby",
      "empty",
      "error",
    ]);
    expect(card.readers[0]?.tuners).toEqual(["PT3-T1"]);
    expect(card.readers[3]?.error).toBe("使えません");
  });

  test("前のバージョンのエージェント (名前だけの並び) でも落ちずに名前を出す", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const card = readCardStatus({
        ok: true,
        readers: ["Gemplus (usb 4-11)"],
        message: "カードが読めています (Gemplus (usb 4-11)、0000001234567890)",
      });
      expect(card.ok).toBe(true);
      expect(card.source).toBe("local");
      expect(card.message).toContain("0000001234567890");
      expect(card.readers).toEqual([
        { name: "Gemplus (usb 4-11)", state: "unknown", ids: [], tuners: [] },
      ]);
    } finally {
      console.warn = warn;
    }
  });

  test("鍵を配る相手から貰っているときは相手と番号を持つ", () => {
    const card = readCardStatus({
      ok: true,
      message: "",
      source: "remote",
      remote: "http://card:25252",
      ids: ["0000001234567890"],
      tuners: ["PT3-T1"],
      readers: [],
    });
    expect(card.remote).toBe("http://card:25252");
    expect(card.ids).toEqual(["0000001234567890"]);
    expect(card.tuners).toEqual(["PT3-T1"]);
  });
});
