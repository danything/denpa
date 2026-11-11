import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isDecoded,
  isScrambled,
  mediaPids,
  readCardStatus,
  ScrambleCount,
  scrambledRatio,
} from "./scramble";

// カードの番号は必ず架空のものにする (本物のカードの番号を載せない)
const PACKET = 188;

/** 指定した割合だけスクランブルの印を立てた TS を作る */
function makeTs(packets: number, scrambledRatio: number): string {
  const buffer = Buffer.alloc(PACKET * packets);
  for (let i = 0; i < packets; i++) {
    const at = i * PACKET;
    buffer[at] = 0x47;
    buffer[at + 1] = 0x01;
    buffer[at + 2] = 0x00;
    // 4 バイト目の上位 2 ビットが transport_scrambling_control
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
  test("復号できていれば 0", () => {
    expect(scrambledRatio(makeTs(2000, 0))).toBe(0);
  });

  test("カードが読めていないと ほぼ全部 になる", () => {
    // 実機で壊れていたときは 98〜99% だった
    expect(scrambledRatio(makeTs(2000, 0.99))).toBeCloseTo(0.99, 2);
    expect(isScrambled(makeTs(2000, 0.99))).toBe(true);
  });

  test("一部だけ掛かっていても復号には回さない", () => {
    // 有料放送の一部だけが暗号の TS を復号に回すと、無駄に時間を食う
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

  test("無いファイルは 0", () => {
    expect(scrambledRatio("/tmp/denpa-does-not-exist.ts")).toBe(0);
  });

  test("復号できていると言えるのは、掛かっていないパケットが 20000 個以上あるときだけ", () => {
    expect(isDecoded(makeTs(20_000, 0))).toBe(true);
    // 中身がほとんど無い録画は、契約の手がかりにしない
    expect(isDecoded(makeTs(2000, 0))).toBe(false);
    expect(isDecoded(makeTs(20_000, 0.99))).toBe(false);
    expect(isDecoded("/tmp/denpa-does-not-exist.ts")).toBe(false);
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

  test("使わない設定のリーダーは 無効 にする", () => {
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
          tuners: [],
          disabled: false,
        },
        {
          name: "PIXELA PIX-DT295 3-5 Card Reader",
          card: false,
          ids: [],
          active: false,
          tuners: [],
          disabled: true,
        },
      ],
    });
    expect(card.readers.map((r) => r.state)).toEqual(["active", "disabled"]);
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

describe("局のパケットのスクランブルを数える (ScrambleCount)", () => {
  /** PID とスクランブルの印、ペイロードの有無を指定した 1 パケット */
  function packet(pid: number, scrambled: boolean, payload = true): Uint8Array {
    const buffer = new Uint8Array(PACKET);
    buffer[0] = 0x47;
    buffer[1] = (pid >> 8) & 0x1f;
    buffer[2] = pid & 0xff;
    buffer[3] = (scrambled ? 0x80 : 0) | (payload ? 0x10 : 0x20);
    return buffer;
  }
  const media = mediaPids("2:256,15:272,6:304");

  test("ServiceFilter.streams から映像・音声・字幕の PID を読む", () => {
    expect([...media]).toEqual([256, 272, 304]);
    expect(mediaPids(null).size).toBe(0);
  });

  test("局の ES のうちペイロードのあるものだけを数え、上限で止める", () => {
    const count = new ScrambleCount(3);
    // PMT (局の ES ではない) とペイロードの無いパケットは数えない
    count.feed(packet(0x1f0, true), media);
    count.feed(packet(256, true, false), media);
    count.feed(packet(256, true), media);
    count.feed(packet(272, false), media);
    expect(count.full).toBe(false);
    count.feed(packet(304, true), media);
    count.feed(packet(256, true), media);
    expect(count.full).toBe(true);
    expect({ total: count.total, scrambled: count.scrambled }).toEqual({
      total: 3,
      scrambled: 2,
    });
  });

  test("掛かったままと言えるのは、半分を超えて掛かっていて、数が足りるときだけ", () => {
    const count = new ScrambleCount(500);
    for (let i = 0; i < 49; i++) count.feed(packet(256, true), media);
    // 49 個ではまだ言えない
    expect(count.stillScrambled(50)).toBe(false);
    count.feed(packet(256, true), media);
    expect(count.stillScrambled(50)).toBe(true);
    // 復号できている局は、先頭から掛かっていない
    const clear = new ScrambleCount(500);
    for (let i = 0; i < 500; i++) clear.feed(packet(256, false), media);
    expect(clear.stillScrambled(500)).toBe(false);
  });
});
