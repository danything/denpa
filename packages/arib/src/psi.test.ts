import { describe, expect, test } from "bun:test";

import {
  NitReader,
  PacketStream,
  parseNit,
  parseNitSection,
  parseSdt,
  parseSdtOther,
  SdtReader,
  SectionAssembler,
  ServiceReader,
  withCrc,
} from "./psi.js";
import {
  nitSection,
  packetize,
  satelliteDeliveryDescriptor,
  sdtSection,
  terrestrialDeliveryDescriptor,
} from "./synth.js";

/**
 * 実チューナーが無いので、NIT と SDT を組み立てて食わせる。
 * セクションがパケットをまたぐ場合も作って、繋ぎ直しを確かめる。
 */

function stream(): Uint8Array {
  const nit = packetize(
    0x0010,
    nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
  );
  const sdt = packetize(
    0x0011,
    sdtSection(0x0408, 0x0004, [
      [1024, 0x01],
      [2048, 0xc1],
    ]),
    3,
  );
  return Uint8Array.from([...nit, ...sdt]);
}

describe("セクションの解釈", () => {
  test("SDT からサービスを読む", () => {
    const parsed = parseSdt(
      sdtSection(0x0408, 0x0004, [
        [1024, 0x01, "TOKYO MX1"],
        [1025, 0x01],
      ]),
    );
    expect(parsed?.transportStreamId).toBe(0x0408);
    expect(parsed?.originalNetworkId).toBe(0x0004);
    expect(parsed?.services).toEqual([
      // 局名は SDT にしか無い。番組表の列見出しはこれで決まる
      { serviceId: 1024, serviceType: 0x01, name: "TOKYO MX1" },
      { serviceId: 1025, serviceType: 0x01, name: "" },
    ]);
  });

  test("NIT からネットワークIDとリモコン番号を読む", () => {
    const parsed = parseNit(
      nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
    );
    expect(parsed?.networkId).toBe(0x7fe0);
    expect(parsed?.remoteControlKeyId).toBe(6);
    expect(parsed?.transportStreams[0]?.transportStreamId).toBe(0x0408);
    expect(parsed?.transportStreams[0]?.services[0]?.serviceId).toBe(1024);
  });

  test("CRCが合わないセクションは捨てる", () => {
    const section = sdtSection(0x0408, 0x0004, [[1024, 0x01]]);
    section[section.length - 1]! ^= 0xff;
    const reader = new ServiceReader();
    reader.feed(packetize(0x0011, section));
    expect(reader.transport).toBeNull();
  });
});

describe("サービスの読み取り", () => {
  test("NIT と SDT が揃うまで待つ", () => {
    const reader = new ServiceReader();
    expect(
      reader.feed(
        packetize(
          0x0010,
          nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
        ),
      ),
    ).toBe(false);
    expect(reader.services()).toEqual([]);
    expect(
      reader.feed(
        packetize(0x0011, sdtSection(0x0408, 0x0004, [[1024, 0x01]])),
      ),
    ).toBe(true);
  });

  test("録れない種別は混ぜない", () => {
    const reader = new ServiceReader();
    reader.feed(stream());
    // 0xC1 は蓄積型サービス。Mirakurun のスキャンが通す種別に入っていない
    expect(reader.services().map((s) => s.serviceId)).toEqual([1024]);
  });

  test("ネットワークIDとリモコン番号を配る", () => {
    const reader = new ServiceReader();
    reader.feed(stream());
    expect(reader.services()[0]).toMatchObject({
      networkId: 0x7fe0,
      transportStreamId: 0x0408,
      remoteControlKeyId: 6,
    });
  });

  test("パケットをまたぐセクションを繋ぎ直す", () => {
    const reader = new ServiceReader();
    const many: [number, number][] = Array.from({ length: 40 }, (_, i) => [
      1024 + i,
      0x01,
    ]);
    reader.feed(
      packetize(0x0010, nitSection(0x7fe0, 6, [[0x0408, 0x0004, many]])),
    );
    reader.feed(packetize(0x0011, sdtSection(0x0408, 0x0004, many)));
    expect(reader.complete).toBe(true);
    expect(reader.services()).toHaveLength(40);
  });

  test("188の切れ目と無関係に届いても読める", () => {
    const reader = new ServiceReader();
    const data = stream();
    for (let at = 0; at < data.length; at += 100)
      reader.feed(data.subarray(at, at + 100));
    expect(reader.complete).toBe(true);
    expect(reader.services().map((s) => s.serviceId)).toEqual([1024]);
  });

  test("別のPIDは読まない", () => {
    const reader = new ServiceReader();
    reader.feed(packetize(0x0100, sdtSection(0x0408, 0x0004, [[1024, 0x01]])));
    expect(reader.transport).toBeNull();
  });
});

/**
 * 電波が弱いと途中でバイトが落ちる。1バイトずれただけで以降ずっと
 * 1パケットも読めなくなると、受信できているのに「局がいない」ことになる。
 */
describe("同期の取り直し", () => {
  /** 実際のチューナーと同じで、同じ表が何度も流れてくる状況にする */
  function repeated(times = 4): Uint8Array {
    const parts: number[] = [];
    for (let i = 0; i < times; i++) parts.push(...stream());
    return Uint8Array.from(parts);
  }

  test("頭がずれていても読める", () => {
    const body = repeated();
    // わざと 0x47 で埋める。頭が1つ合っただけでは切れ目とは言えない
    const data = new Uint8Array(37 + body.length);
    data.fill(0x47, 0, 37);
    data.set(body, 37);

    const reader = new ServiceReader();
    reader.feed(data);
    expect(reader.complete).toBe(true);
  });

  test("途中で落ちても後ろを読める", () => {
    const data = repeated();
    // 頭の NIT の直後で 3 バイト落とす。以降の切れ目が 188 の倍数から外れる
    const broken = Uint8Array.from([
      ...data.subarray(0, 188),
      ...data.subarray(191),
    ]);
    const reader = new ServiceReader();
    reader.feed(broken);
    expect(reader.transport).not.toBeNull();
  });

  test("同期が取れなくても溜め込まない", () => {
    const reader = new ServiceReader();
    for (let i = 0; i < 50; i++) reader.feed(new Uint8Array(4096).fill(0x00));
    reader.feed(repeated());
    expect(reader.complete).toBe(true);
  });
});

/** 前の切り分け (塊を毎回丸ごと写していた頃)。今のものと同じパケットが出ることを確かめる */
class CopyingPacketStream {
  private rest = new Uint8Array(0);

  *feed(chunk: Uint8Array): Generator<Uint8Array> {
    const data = new Uint8Array(this.rest.length + chunk.length);
    data.set(this.rest);
    data.set(chunk, this.rest.length);
    const sync = (from: number) => {
      for (let at = from; at + 376 < data.length; at++) {
        if (
          data[at] === 0x47 &&
          data[at + 188] === 0x47 &&
          data[at + 376] === 0x47
        )
          return at;
      }
      return -1;
    };
    let at = 0;
    while (at + 188 <= data.length) {
      if (data[at] !== 0x47) {
        const found = sync(at);
        if (found < 0) break;
        at = found;
        if (at + 188 > data.length) break;
      }
      yield data.subarray(at, at + 188);
      at += 188;
    }
    this.rest = data.slice(Math.max(at, data.length - 564));
  }
}

/** 決まった順に出る乱数 (落ちたときに同じ並びで再現できるように) */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** パケットを並べ、ところどころで数バイト落とす・ごみを挟む・0x47 を紛れ込ませる */
function damaged(next: () => number, packets: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < packets; i++) {
    const packet = new Array<number>(188);
    packet[0] = 0x47;
    for (let k = 1; k < 188; k++)
      packet[k] = next() < 0.05 ? 0x47 : Math.floor(next() * 256);
    const roll = next();
    if (roll < 0.03) out.push(...packet.slice(Math.floor(next() * 188)));
    else if (roll < 0.06)
      out.push(
        ...Array.from({ length: Math.floor(next() * 600) }, () =>
          Math.floor(next() * 256),
        ),
      );
    else if (roll < 0.08)
      out.push(...new Array(Math.floor(next() * 400)).fill(0x47));
    if (roll >= 0.03) out.push(...packet);
  }
  return Uint8Array.from(out);
}

/** 好きな大きさに切る。1バイトや 188 の倍数、残りより短いものも混ぜる */
function cut(next: () => number, data: Uint8Array): Uint8Array[] {
  const sizes = [1, 2, 187, 188, 189, 375, 564, 565, 1000, 24064];
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length;) {
    const size =
      next() < 0.5
        ? sizes[Math.floor(next() * sizes.length)]!
        : 1 + Math.floor(next() * 3000);
    out.push(data.subarray(at, at + size));
    at += size;
  }
  return out;
}

describe("パケットの切り分け (塊を写さない)", () => {
  test("どこで切って届いても、前の切り分けと同じパケットが同じ順に出る", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const chunks = cut(next, damaged(next, 300));
      const before = new CopyingPacketStream();
      const after = new PacketStream();
      const expected: number[][] = [];
      const actual: number[][] = [];
      for (const chunk of chunks) {
        for (const packet of before.feed(chunk)) expected.push([...packet]);
        for (const packet of after.feed(chunk)) actual.push([...packet]);
      }
      expect(actual.length).toBe(expected.length);
      expect(actual).toEqual(expected);
    }
  });

  test("入れ物を使い回されても、出したパケットは届いた中身のまま", () => {
    // recorded-bml.ts と同じ使い方: 1つの入れ物に読み込み直しながら食わせる
    const next = random(7);
    const data = damaged(next, 400);
    const before = new CopyingPacketStream();
    const stream = new PacketStream();
    const buffer = new Uint8Array(1000);
    const expected: number[][] = [];
    const actual: number[][] = [];
    for (let at = 0; at < data.length; at += buffer.length) {
      const length = Math.min(buffer.length, data.length - at);
      for (const packet of before.feed(data.slice(at, at + length)))
        expected.push([...packet]);
      buffer.set(data.subarray(at, at + length));
      for (const packet of stream.feed(buffer.subarray(0, length)))
        actual.push([...packet]);
      buffer.fill(0xee);
    }
    expect(actual).toEqual(expected);
  });

  test("関係ないパケットには配列を作らない", () => {
    const assembler = new SectionAssembler(0x0011);
    const nit = packetize(
      0x0010,
      nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
    );
    const first = assembler.feed(nit.subarray(0, 188));
    expect(first).toHaveLength(0);
    expect(Object.isFrozen(first)).toBe(true);
    expect(assembler.feed(new Uint8Array(188))).toBe(first);
  });
});

/**
 * 衛星はどの TS にもネットワークの全部の TS の NIT と、ほかの TS の SDT[other] を流している。
 * 再編に付いていくにはこれを読む。値は BS の実際の割当に合わせる (BS-1 の BS朝日・BS-15 の NHK BS)
 */
describe("ネットワークの全部の TS (NIT・SDT[other])", () => {
  /** BS-1 (11.72748 GHz) と BS-15 (11.99600 GHz) */
  const BS1 = satelliteDeliveryDescriptor(11_727_480);
  const BS15 = satelliteDeliveryDescriptor(11_996_000);

  /** current_next_indicator を 0 (これから使う表) にしたセクション */
  function next(section: Uint8Array): Uint8Array {
    const body = [...section.subarray(0, -4)];
    body[5]! &= 0xfe;
    return withCrc(body);
  }

  test("衛星の分配の記述子から周波数・軌道・シンボルレートを読む", () => {
    const parsed = parseNitSection(
      nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]]),
    );
    expect(parsed?.transportStreams[0]?.delivery).toEqual({
      kind: "satellite",
      frequency: 11_727_480,
      orbitalPosition: 1100,
      east: true,
      polarization: 3,
      modulation: 0x08,
      symbolRate: 28_860_000,
      fec: 1,
    });
  });

  test("地上の分配の記述子から周波数を読む (1/7 MHz 単位)", () => {
    // T27 は 557.142857 MHz。放送は 1/7 MHz の 3900 と書く
    const parsed = parseNitSection(
      nitSection(0x7fe0, 6, [
        [
          0x7fe0,
          0x7fe0,
          [[1024, 0x01]],
          terrestrialDeliveryDescriptor(0x5a5, [557_142_857]),
        ],
      ]),
    );
    expect(parsed?.transportStreams[0]?.delivery).toEqual({
      kind: "terrestrial",
      areaCode: 0x5a5,
      guardInterval: 1,
      transmissionMode: 2,
      frequencies: [557_142_857],
    });
  });

  test("分配の記述子が無い TS は null", () => {
    const parsed = parseNitSection(
      nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
    );
    expect(parsed?.transportStreams[0]?.delivery).toBeNull();
  });

  test("セクションの頭からバージョンと節の番号を読む", () => {
    const parsed = parseNitSection(
      nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]], {
        version: 7,
        sectionNumber: 1,
        lastSectionNumber: 2,
      }),
    );
    expect(parsed).toMatchObject({
      other: false,
      networkId: 4,
      version: 7,
      current: true,
      sectionNumber: 1,
      lastSectionNumber: 2,
    });
  });

  test("分配の記述子が付いても parseNit は今までどおり読む", () => {
    const parsed = parseNit(
      nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]]),
    );
    expect(parsed?.networkId).toBe(4);
    expect(parsed?.transportStreams[0]?.services[0]?.serviceId).toBe(151);
    // NIT[other] はスキャンの「どのネットワークか」に使わない
    expect(
      parseNit(
        nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]], { other: true }),
      ),
    ).toBeNull();
  });

  test("全部のセクションがそろうまで返さず、そろったら TS をつなぐ", () => {
    const reader = new NitReader();
    const second = nitSection(4, null, [[16625, 4, [[101, 0x01]], BS15]], {
      sectionNumber: 1,
      lastSectionNumber: 1,
    });
    const first = nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]], {
      sectionNumber: 0,
      lastSectionNumber: 1,
    });
    // 後ろの節から届いても並びは section_number の順
    expect(reader.feed(packetize(0x0010, second))).toBe(false);
    expect(reader.actual).toBeNull();
    expect(reader.feed(packetize(0x0010, first, 1))).toBe(true);
    expect(
      reader.actual?.transportStreams.map((ts) => [
        ts.transportStreamId,
        ts.delivery?.kind === "satellite" ? ts.delivery.frequency : null,
        ts.services.map((s) => s.serviceId),
      ]),
    ).toEqual([
      [16400, 11_727_480, [151]],
      [16625, 11_996_000, [101]],
    ]);
  });

  test("同じ表が繰り返し流れても、変わったとは言わない", () => {
    const reader = new NitReader();
    const section = nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]]);
    expect(reader.feed(packetize(0x0010, section))).toBe(true);
    expect(reader.feed(packetize(0x0010, section, 1))).toBe(false);
  });

  test("バージョンが変わったら、新しい表がそろうまで前の表を返す", () => {
    const reader = new NitReader();
    reader.feed(
      packetize(0x0010, nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]])),
    );
    expect(reader.actual?.version).toBe(0);

    // 局が BS-15 へ移った表 (2 節)。1 節目だけではまだ前の表
    const part = { version: 1, lastSectionNumber: 1 };
    expect(
      reader.feed(
        packetize(
          0x0010,
          nitSection(4, null, [[16626, 4, [[151, 0x01]], BS15]], {
            ...part,
            sectionNumber: 0,
          }),
          1,
        ),
      ),
    ).toBe(false);
    expect(reader.actual?.version).toBe(0);
    expect(reader.actual?.transportStreams[0]?.transportStreamId).toBe(16400);

    expect(
      reader.feed(
        packetize(
          0x0010,
          nitSection(4, null, [[16625, 4, [[101, 0x01]], BS15]], {
            ...part,
            sectionNumber: 1,
          }),
          2,
        ),
      ),
    ).toBe(true);
    expect(reader.actual?.version).toBe(1);
    expect(
      reader.actual?.transportStreams.map((ts) => ts.transportStreamId),
    ).toEqual([16626, 16625]);
  });

  test("集めている途中でバージョンが変わったら、古い節を混ぜない", () => {
    const reader = new NitReader();
    reader.feed(
      packetize(
        0x0010,
        nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]], {
          version: 0,
          sectionNumber: 0,
          lastSectionNumber: 1,
        }),
      ),
    );
    // バージョン 1 の 2 節目だけでは、バージョン 0 の 1 節目とつながない
    reader.feed(
      packetize(
        0x0010,
        nitSection(4, null, [[16625, 4, [[101, 0x01]], BS15]], {
          version: 1,
          sectionNumber: 1,
          lastSectionNumber: 1,
        }),
        1,
      ),
    );
    expect(reader.actual).toBeNull();
  });

  test("これから使う表 (current_next_indicator が 0) は読まない", () => {
    const reader = new NitReader();
    reader.feed(
      packetize(
        0x0010,
        next(nitSection(4, null, [[16400, 4, [[151, 0x01]], BS1]])),
      ),
    );
    expect(reader.actual).toBeNull();
  });

  test("NIT[other] はネットワークごとに別に持つ", () => {
    const reader = new NitReader();
    reader.feed(
      packetize(0x0010, nitSection(6, null, [[0x6020, 6, [[55, 0x01]]]])),
    );
    reader.feed(
      packetize(
        0x0010,
        nitSection(7, null, [[0x7040, 7, [[296, 0x01]]]], { other: true }),
        1,
      ),
    );
    expect(reader.actual?.networkId).toBe(6);
    expect(
      reader.networks().map((network) => [network.other, network.networkId]),
    ).toEqual([
      [false, 6],
      [true, 7],
    ]);
  });

  test("188 の切れ目と無関係に届いても、大きな表を読める", () => {
    // BS は 26 の TS があり、TS ごとに記述子が付くので 1 節が何パケットにもまたがる
    const streams: [number, number, [number, number][], number[]][] =
      Array.from({ length: 26 }, (_, i) => [
        16400 + i,
        4,
        [
          [100 + i * 3, 0x01],
          [101 + i * 3, 0x01],
          [700 + i, 0xc0],
        ],
        satelliteDeliveryDescriptor(11_727_480 + 38_360 * (i % 12)),
      ]);
    const data = packetize(0x0010, nitSection(4, null, streams));
    const reader = new NitReader();
    for (let at = 0; at < data.length; at += 100)
      reader.feed(data.subarray(at, at + 100));
    expect(reader.actual?.transportStreams).toHaveLength(26);
    expect(reader.actual?.transportStreams[25]?.services).toHaveLength(3);
  });

  test("SDT[other] からほかの TS の局名を読む", () => {
    const section = sdtSection(16625, 4, [[101, 0x01, "NHK BS"]], {
      other: true,
    });
    expect(parseSdtOther(section)?.services).toEqual([
      { serviceId: 101, serviceType: 0x01, name: "NHK BS" },
    ]);
    // 自分の TS の読み取りは SDT[other] を読まない (スキャンが別の TS の局を自分のものと取り違える)
    expect(parseSdt(section)).toBeNull();
    const reader = new ServiceReader();
    reader.feed(packetize(0x0011, section));
    expect(reader.transport).toBeNull();
  });

  test("SDT を TS ごとにそろえる (actual と other)", () => {
    const reader = new SdtReader();
    reader.feed(
      packetize(0x0011, sdtSection(16400, 4, [[151, 0x01, "BS朝日1"]])),
    );
    reader.feed(
      packetize(
        0x0011,
        sdtSection(16625, 4, [[101, 0x01, "NHK BS"]], {
          other: true,
          sectionNumber: 0,
          lastSectionNumber: 1,
        }),
        1,
      ),
    );
    // 2 節に分かれた TS は、そろうまで返らない
    expect(reader.tables().map((t) => t.transportStreamId)).toEqual([16400]);
    reader.feed(
      packetize(
        0x0011,
        sdtSection(16625, 4, [[102, 0x01, "NHK BS"]], {
          other: true,
          sectionNumber: 1,
          lastSectionNumber: 1,
        }),
        2,
      ),
    );
    expect(reader.actual?.transportStreamId).toBe(16400);
    expect(
      reader
        .tables()
        .map((t) => [
          t.other,
          t.transportStreamId,
          t.services.map((s) => [s.serviceId, s.name]),
        ]),
    ).toEqual([
      [false, 16400, [[151, "BS朝日1"]]],
      [
        true,
        16625,
        [
          [101, "NHK BS"],
          [102, "NHK BS"],
        ],
      ],
    ]);
  });

  test("SDT のバージョンが変わったら局名を書き換える", () => {
    const reader = new SdtReader();
    const old = sdtSection(17970, 4, [[251, 0x01, "釣りビジョン"]], {
      other: true,
    });
    expect(reader.feed(packetize(0x0011, old))).toBe(true);
    expect(reader.feed(packetize(0x0011, old, 1))).toBe(false);
    expect(
      reader.feed(
        packetize(
          0x0011,
          sdtSection(17970, 4, [[251, 0x01, "BS12"]], {
            other: true,
            version: 1,
          }),
          2,
        ),
      ),
    ).toBe(true);
    expect(reader.tables()[0]?.services[0]?.name).toBe("BS12");
  });
});
