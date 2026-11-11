import { describe, expect, test } from "bun:test";

import { concatBytes } from "./bytes.js";
import { compressedIp, ipv6Udp, mmtpPacket, tlvPacket } from "./synth-mmt.js";
import { TlvIpReader } from "./tlv-ip.js";
import { type TlvPacket, TlvStream } from "./tlv.js";

/** 中身の長さが違う TLV パケットを `count` 個 (ヌルの TLV。中身は番号) */
function nulls(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, i) =>
    tlvPacket(0xff, new Array(10 + ((i * 37) % 200)).fill(i & 0xff)),
  );
}

/** `data` を `size` バイトずつ渡して、出たパケットを集める */
function feedAll(
  stream: TlvStream,
  data: Uint8Array,
  size: number,
): TlvPacket[] {
  const out: TlvPacket[] = [];
  for (let at = 0; at < data.length; at += size)
    for (const packet of stream.feed(data.subarray(at, at + size)))
      out.push({ ...packet, payload: packet.payload.slice() });
  return out;
}

describe("TlvStream", () => {
  test("チャンクの切れ目がパケットのどこに来ても、同じパケットに切り分ける", () => {
    const packets = nulls(40);
    const data = concatBytes(packets);
    for (const size of [1, 3, 4, 5, 97, 1000, data.length]) {
      const stream = new TlvStream();
      const out = feedAll(stream, data, size);
      expect(out.map((p) => p.payload.length)).toEqual(
        packets.map((p) => p.length - 4),
      );
      expect(stream.skipped).toBe(0);
    }
  });

  test("パケットの途中から受けても、次のパケットの先頭で合わせる", () => {
    const packets = nulls(10);
    const data = concatBytes(packets).subarray(7);
    const stream = new TlvStream();
    const out = feedAll(stream, data, 64);
    expect(out[0]!.payload[0]).toBe(1);
    expect(stream.skipped).toBe(packets[0]!.length - 7);
  });

  test("中身にある 7F は、長さの先が次のパケットの先頭でなければ先頭と取り違えない", () => {
    // 7F FF 00 02 は先頭に見えるが、6 バイト先は次のパケットの先頭ではない
    const decoy = Uint8Array.of(0x00, 0x7f, 0xff, 0x00, 0x02, 0x55, 0x55, 0x55);
    const packets = nulls(4);
    const stream = new TlvStream();
    const out = feedAll(stream, concatBytes([decoy, ...packets]), 5);
    expect(out[0]!.payload).toEqual(packets[0]!.subarray(4));
    expect(stream.skipped).toBe(decoy.length);
  });

  test("壊れたヘッダーのあとは合わせ直し、数える", () => {
    const packets = nulls(6);
    const broken = packets[2]!.slice();
    broken[0] = 0x00;
    const stream = new TlvStream();
    const out = feedAll(
      stream,
      concatBytes([packets[0]!, packets[1]!, broken, ...packets.slice(3)]),
      50,
    );
    expect(stream.resyncs).toBe(1);
    expect(out.map((p) => p.payload[0])).toEqual([0, 1, 3, 4, 5]);
  });

  test("パケット全体 (ヘッダーを含む) も返す", () => {
    const packet = tlvPacket(0xfe, [1, 2, 3]);
    const out = feedAll(new TlvStream(), concatBytes([packet, packet]), 100);
    expect([...out[0]!.bytes]).toEqual([...packet]);
  });
});

describe("TlvIpReader", () => {
  test("全部のヘッダー (0x60) で覚えた宛先を、ヘッダー無し (0x61) にも付ける", () => {
    const reader = new TlvIpReader();
    const mmtp = mmtpPacket({ packetId: 0xf100, payloadType: 0, payload: [9] });
    const read = (bytes: Uint8Array) =>
      reader.read({ type: bytes[1]!, payload: bytes.subarray(4), bytes });

    const before = read(compressedIp(1, mmtp))!;
    expect(before.flow).toBe("cid:1");
    expect(before.address).toBeNull();
    expect([...before.payload]).toEqual([...mmtp]);

    const full = read(compressedIp(1, mmtp, {}))!;
    expect(full.address).toEqual({
      source: "2401:dbc0:1003:0:0:0:0:b111",
      destination: "ff3e:0:0:0:0:0:a000:1000",
      sourcePort: 50000,
      destinationPort: 51216,
    });
    // 圧縮したヘッダーは 3 + 38 + 4 バイトで、MMTP はその後ろから
    expect([...full.payload]).toEqual([...mmtp]);

    const after = read(compressedIp(1, mmtp))!;
    expect(after.address?.destinationPort).toBe(51216);
    expect(read(compressedIp(2, mmtp))!.address).toBeNull();
  });

  test("素の IPv6 の UDP (NTP) を読む", () => {
    const bytes = ipv6Udp("ff02::101", 123, new Uint8Array(48).fill(7));
    const datagram = new TlvIpReader().read({
      type: bytes[1]!,
      payload: bytes.subarray(4),
      bytes,
    })!;
    expect(datagram.flow).toBe("ff02:0:0:0:0:0:0:101:123");
    expect(datagram.payload.length).toBe(48);
  });
});
