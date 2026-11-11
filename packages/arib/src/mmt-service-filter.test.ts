import { describe, expect, test } from "bun:test";

import { concatBytes } from "./bytes.js";
import { MmtServiceFilter } from "./mmt-service-filter.js";
import { parseMmtp } from "./mmtp.js";
import {
  compressedIp,
  ipv6Udp,
  mmtpPacket,
  mptTable,
  mpuPayload,
  paMessage,
  pltTable,
  signalingPackets,
  tlvNitSection,
  tlvPacket,
  tlvSi,
} from "./synth-mmt.js";
import { TlvIpReader } from "./tlv-ip.js";
import { TlvStream } from "./tlv.js";

const ONE = 0xa1;
const TWO = 0xa2;

/** 映像の MPU を 1 つ (中身は番号) */
function mpu(cid: number, packetId: number, mark: number): Uint8Array {
  return compressedIp(
    cid,
    mmtpPacket({
      packetId,
      payloadType: 0,
      scrambling: "odd",
      payload: mpuPayload([mark]),
    }),
  );
}

/** 局の PLT と MPT。映像 0xF100、音声 0xF110、ECM 0xFFF1 */
function signals(cid: number, packages: number[], mptPacketId = 0xff01) {
  const plt = pltTable(packages.map((id, i) => [id, mptPacketId + i]));
  const mpts = packages.map((packageId, i) =>
    signalingPackets(mptPacketId + i, [
      paMessage(
        mptTable({
          packageId,
          access: { caSystemId: 0x0005, ecmPacketId: 0xfff1 },
          assets: [
            { type: "hev1", packetId: 0xf100 + i * 0x200 },
            { type: "mp4a", packetId: 0xf110 + i * 0x200 },
          ],
        }),
      ),
    ]),
  );
  return [...signalingPackets(0x0000, [paMessage(plt)]), ...mpts.flat()].map(
    (p) => compressedIp(cid, p),
  );
}

/** 出た TLV のバイト列を `[並び, packet_id, 印]` にする (MPU は中身の先頭、信号は null) */
function summary(data: Uint8Array): [string, number, number | null][] {
  const ip = new TlvIpReader();
  const out: [string, number, number | null][] = [];
  for (const packet of new TlvStream().feed(data)) {
    const datagram = ip.read(packet);
    if (datagram === null || packet.type !== 0x03) continue;
    const mmtp = parseMmtp(datagram.payload)!;
    out.push([
      datagram.flow,
      mmtp.packetId,
      mmtp.payloadType === 0 ? mmtp.payload[8]! : null,
    ]);
  }
  return out;
}

describe("MmtServiceFilter", () => {
  test("局ごとに IP の並びが分かれていれば、その局の並びだけを残す (packet_id が同じでも)", () => {
    const data = concatBytes([
      ...signals(1, [ONE]),
      ...signals(2, [TWO]),
      mpu(1, 0xf100, 1),
      mpu(2, 0xf100, 2),
      mpu(1, 0xf110, 3),
    ]);
    const filter = new MmtServiceFilter(ONE);
    const out = summary(filter.filter(data));
    expect(out.every(([flow]) => flow === "cid:1")).toBe(true);
    expect(
      out.filter(([, , mark]) => mark !== null).map(([, , mark]) => mark),
    ).toEqual([1, 3]);
    expect(filter.ready).toBe(true);
    expect(filter.mpt?.packageId).toBe(ONE);
  });

  test("1 つの並びに 2 局あれば、ほかの局の MPT とアセットを落とす", () => {
    const data = concatBytes([
      ...signals(1, [ONE, TWO]),
      mpu(1, 0xf100, 1),
      mpu(1, 0xf300, 2),
    ]);
    const out = summary(new MmtServiceFilter(ONE).filter(data));
    expect(out).toEqual([
      ["cid:1", 0x0000, null],
      ["cid:1", 0xff01, null],
      ["cid:1", 0xf100, 1],
    ]);
  });

  test("MPT を読む前の MPU は取っておき、MPT の後ろに届いた順で出す", () => {
    const filter = new MmtServiceFilter(ONE);
    const early = filter.filter(
      concatBytes([mpu(1, 0xf100, 1), mpu(1, 0xf110, 2)]),
    );
    expect(early.length).toBe(0);
    const out = summary(
      filter.filter(concatBytes([...signals(1, [ONE]), mpu(1, 0xf100, 3)])),
    );
    expect(out.map(([, id, mark]) => [id, mark])).toEqual([
      [0x0000, null],
      [0xff01, null],
      [0xf100, 1],
      [0xf110, 2],
      [0xf100, 3],
    ]);
  });

  test("TLV-SI と NTP は残し、詰め物は落とす", () => {
    const nit = tlvSi(tlvNitSection(0x000b, "高度ＢＳデジタル放送", []));
    const ntp = ipv6Udp("ff02::101", 123, new Uint8Array(48));
    const filter = new MmtServiceFilter(ONE);
    const out = filter.filter(
      concatBytes([nit, tlvPacket(0xff, [0, 0, 0]), ntp, nit]),
    );
    expect([...out]).toEqual([...concatBytes([nit, ntp, nit])]);
  });
});
