import { describe, expect, test } from "bun:test";

import { PacketCheck } from "./signal-quality";

/**
 * 数え方の境目だけを試す。選局から測り終えるまでは `tests/e2e/16-scan.spec.ts` で、偽の放送に当てて通す
 */
function packet(
  cc: number,
  { pid = 0x100, tei = false, payload = true, discontinuity = false } = {},
): Uint8Array {
  const out = new Uint8Array(188);
  out[0] = 0x47;
  out[1] = (tei ? 0x80 : 0) | (pid >> 8);
  out[2] = pid & 0xff;
  out[3] = (discontinuity ? 0x20 : 0) | (payload ? 0x10 : 0) | cc;
  if (discontinuity) {
    out[4] = 1;
    out[5] = 0x80;
  }
  return out;
}

function count(...packets: Uint8Array[]): PacketCheck {
  const check = new PacketCheck();
  const all = new Uint8Array(packets.length * 188);
  packets.forEach((p, i) => all.set(p, i * 188));
  // 塊の切れ目がパケットの途中に来ても数える
  check.feed(all.subarray(0, 100));
  check.feed(all.subarray(100));
  return check;
}

describe("PacketCheck", () => {
  test("カウンタの飛びを欠けとして数え、15 から 0 への一巡と 2 度送りは数えない", () => {
    const check = count(
      packet(14),
      packet(15),
      packet(0),
      packet(0),
      packet(3),
    );
    expect(check.packets).toBe(5);
    expect(check.drops).toBe(2);
  });

  test("PID ごとに数える", () => {
    const check = count(
      packet(0),
      packet(7, { pid: 0x200 }),
      packet(1),
      packet(8, { pid: 0x200 }),
    );
    expect(check.drops).toBe(0);
  });

  test("誤りのあるパケットは誤りに数え、その PID は数え直す", () => {
    const check = count(packet(0), packet(9, { tei: true }), packet(5));
    expect(check.errors).toBe(1);
    expect(check.drops).toBe(0);
  });

  test("飛んでよい印・ペイロードの無いパケット・NULL パケットでは欠けを数えない", () => {
    const check = count(
      packet(0),
      packet(9, { discontinuity: true }),
      packet(10),
      packet(10, { payload: false }),
      packet(11),
      packet(4, { pid: 0x1fff }),
      packet(12),
    );
    expect(check.packets).toBe(7);
    expect(check.drops).toBe(0);
  });
});
