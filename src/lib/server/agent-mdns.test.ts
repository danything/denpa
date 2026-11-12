import { describe, expect, test } from "bun:test";

import { queryPacket, readResponse, Sightings } from "./agent-mdns";

/*
 * LAN でエージェントを見つける (agent-mdns.ts)。答えのパケットは、エージェントの自前の応答 (agent/Denpa.Agent/Mdns.cs) が
 * 組む形 (PTR に SRV と TXT を足す) と、mDNSResponder のように名前を圧縮して A を足す形の両方を読む
 */

const ID = "0123456789abcdef";
const INSTANCE = "居間 (01234567)._denpa-agent._tcp.local";

/** 答えのパケットを組む (名前は圧縮しない) */
function response(
  records: {
    name: string;
    type: number;
    ttl?: number;
    data: number[];
    flush?: boolean;
  }[],
): Uint8Array {
  const out = [0, 0, 0x84, 0, 0, 0, 0, records.length, 0, 0, 0, 0];
  for (const record of records) {
    out.push(...name(record.name));
    const ttl = record.ttl ?? 120;
    out.push(
      record.type >> 8,
      record.type & 0xff,
      record.flush ? 0x80 : 0,
      1,
      (ttl >>> 24) & 0xff,
      (ttl >>> 16) & 0xff,
      (ttl >>> 8) & 0xff,
      ttl & 0xff,
      record.data.length >> 8,
      record.data.length & 0xff,
      ...record.data,
    );
  }
  return Uint8Array.from(out);
}

function name(text: string): number[] {
  const out: number[] = [];
  for (const label of text.split(".")) {
    const bytes = new TextEncoder().encode(label);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return out;
}

function txt(...entries: string[]): number[] {
  return entries.flatMap((entry) => {
    const bytes = new TextEncoder().encode(entry);
    return [bytes.length, ...bytes];
  });
}

function srv(port: number, target: string): number[] {
  return [0, 0, 0, 0, port >> 8, port & 0xff, ...name(target)];
}

/** エージェントの自前の応答と同じ形 (PTR・SRV・TXT) */
function announcement(ttl = 120, entries = ["v=1", `id=${ID}`, "name=居間"]) {
  return response([
    {
      name: "_denpa-agent._tcp.local",
      type: 12,
      ttl: ttl === 0 ? 0 : 4500,
      data: name(INSTANCE),
    },
    {
      name: INSTANCE,
      type: 33,
      ttl,
      data: srv(25252, "tuner.local"),
      flush: true,
    },
    { name: INSTANCE, type: 16, ttl, data: txt(...entries), flush: true },
  ]);
}

describe("パケット", () => {
  test("問いは型と名前を並べ、legacy unicast のときだけ ID を付ける", () => {
    const packet = queryPacket([{ name: "_denpa-agent._tcp.local", type: 12 }]);
    expect(Array.from(packet.subarray(0, 12))).toEqual([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    ]);
    expect(Array.from(packet.subarray(12))).toEqual([
      ...name("_denpa-agent._tcp.local"),
      0,
      12,
      0,
      1,
    ]);
    expect(Array.from(queryPacket([], 0x1234).subarray(0, 2))).toEqual([
      0x12, 0x34,
    ]);
  });

  test("答えの PTR・SRV・TXT・A を読み、圧縮した名前も辿る", () => {
    const records = readResponse(announcement())!;
    expect(records.map((record) => record.type)).toEqual([12, 33, 16]);
    expect(records[0]?.target).toBe(INSTANCE);
    expect(records[1]).toMatchObject({ port: 25252, target: "tuner.local" });
    expect(records[2]?.txt?.get("name")).toBe("居間");

    // 2 つ目の名前を、1 つ目の名前の位置 (12) への圧縮にする
    const compressed = Uint8Array.from([
      0,
      0,
      0x84,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      ...name("tuner.local"),
      0,
      1,
      0x80,
      1,
      0,
      0,
      0,
      120,
      0,
      4,
      192,
      168,
      1,
      20,
      0xc0,
      12,
      0,
      1,
      0x80,
      1,
      0,
      0,
      0,
      120,
      0,
      4,
      10,
      0,
      0,
      1,
    ]);
    const read = readResponse(compressed)!;
    expect(read.map((record) => [record.name, record.address])).toEqual([
      ["tuner.local", "192.168.1.20"],
      ["tuner.local", "10.0.0.1"],
    ]);
  });

  test("問いと壊れたパケットは読まない", () => {
    expect(
      readResponse(queryPacket([{ name: "a.local", type: 12 }])),
    ).toBeNull();
    expect(readResponse(new Uint8Array(5))).toBeNull();
    const loop = Uint8Array.from([
      0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 1,
      0, 0,
    ]);
    expect(readResponse(loop)).toBeNull();
  });
});

describe("Sightings", () => {
  test("そろったら、A があればそのアドレス、無ければ送り元で返す", () => {
    const sightings = new Sightings();
    const { missing, found } = sightings.take(
      readResponse(announcement())!,
      "192.168.1.30",
      1000,
    );
    expect(missing).toEqual([]);
    expect(found).toEqual([
      { id: ID, name: "居間", host: "192.168.1.30", port: 25252, seenAt: 1000 },
    ]);

    const withA = response([
      { name: "_denpa-agent._tcp.local", type: 12, data: name(INSTANCE) },
      { name: INSTANCE, type: 33, data: srv(25252, "tuner.local") },
      { name: INSTANCE, type: 16, data: txt("v=1", `id=${ID}`, "name=居間") },
      { name: "tuner.local", type: 1, data: [192, 168, 1, 20] },
    ]);
    expect(
      sightings.take(readResponse(withA)!, "192.168.1.99", 2000).found,
    ).toEqual([
      { id: ID, name: "居間", host: "192.168.1.20", port: 25252, seenAt: 2000 },
    ]);
  });

  test("PTR だけなら SRV と TXT を問い直し、別のパケットで来たらそろえる", () => {
    const sightings = new Sightings();
    const ptr = response([
      { name: "_denpa-agent._tcp.local", type: 12, data: name(INSTANCE) },
    ]);
    const first = sightings.take(readResponse(ptr)!, "192.168.1.30", 1000);
    expect(first.missing).toEqual([INSTANCE.toLowerCase()]);
    expect(first.found).toEqual([]);
    const rest = response([
      { name: INSTANCE, type: 33, data: srv(25252, "tuner.local") },
      { name: INSTANCE, type: 16, data: txt("v=1", `id=${ID}`, "name=居間") },
    ]);
    expect(
      sightings.take(readResponse(rest)!, "192.168.1.30", 1100).found,
    ).toHaveLength(1);
  });

  test("TTL 0 (さよなら) で消し、古いものは忘れる。v が 1 でない・id が読めないものは使わない", () => {
    const sightings = new Sightings();
    sightings.take(readResponse(announcement())!, "192.168.1.30", 1000);
    expect(sightings.list(0, 1000)).toHaveLength(1);
    // 問いより前に答えたものは出さない
    expect(sightings.list(2000, 2000)).toEqual([]);
    sightings.take(readResponse(announcement(0))!, "192.168.1.30", 3000);
    expect(sightings.list(0, 3000)).toEqual([]);

    sightings.take(readResponse(announcement())!, "192.168.1.30", 1000);
    expect(sightings.list(0, 1000 + 11 * 60_000)).toEqual([]);
    expect(sightings.instances.size).toBe(0);

    expect(
      sightings.take(
        readResponse(announcement(120, ["v=2", `id=${ID}`, "name=居間"]))!,
        "192.168.1.30",
      ).found,
    ).toEqual([]);
    expect(
      sightings.take(
        readResponse(announcement(120, ["v=1", "id=xyz", "name=居間"]))!,
        "192.168.1.30",
      ).found,
    ).toEqual([]);
  });

  test("ほかのサービスの答えは控えない", () => {
    const sightings = new Sightings();
    const other = response([
      {
        name: "_http._tcp.local",
        type: 12,
        data: name("web._http._tcp.local"),
      },
      { name: "web._http._tcp.local", type: 33, data: srv(80, "web.local") },
    ]);
    expect(sightings.take(readResponse(other)!, "192.168.1.30")).toEqual({
      missing: [],
      found: [],
    });
    expect(sightings.instances.size).toBe(0);
  });
});

test("控えるインスタンスは 64 までで、超えたら古いものから忘れる", () => {
  const sightings = new Sightings();
  for (let index = 0; index < 70; index++) {
    const ptr = response([
      {
        name: "_denpa-agent._tcp.local",
        type: 12,
        data: name(`偽 ${index}._denpa-agent._tcp.local`),
      },
    ]);
    sightings.take(readResponse(ptr)!, "192.168.1.66", index);
  }
  expect(sightings.instances.size).toBe(64);
  expect(sightings.instances.has("偽 0._denpa-agent._tcp.local")).toBe(false);
  expect(sightings.instances.has("偽 69._denpa-agent._tcp.local")).toBe(true);
});
