import { describe, expect, test } from "bun:test";

import {
  eitSection,
  packetize,
  patSection,
  programMap,
  stream,
  withCrc,
} from "@danything/arib/synth";

import {
  CaObserver,
  caSystemIds,
  describe as describeObserved,
  epgText,
} from "./ca-observe";

/*
 * カード無しで分かること (`ca-observe.ts`)。PAT・PMT・CAT・EIT・CDT を自分で組んで流す。
 * スカパー！プレミアムの CA_system_id は分かっていないので、B-CAS (0x0005) 以外の値には作り物の 0x000B を使う
 */

const OTHER = 0x000b;
const PMT_PID = 0x0101;

/** CA 記述子 (0x09)。CA_system_id と CA_PID */
const ca = (system: number, pid: number) => [
  0x09,
  0x04,
  system >> 8,
  system & 0xff,
  0xe0 | (pid >> 8),
  pid & 0xff,
];

/** CAT。記述子の並びだけ */
const cat = (descriptors: number[]) =>
  withCrc([0x01, 0x00, 0x00, 0xff, 0xff, 0xc1, 0x00, 0x00, ...descriptors]);

/** CDT。ロゴの中身は入れない */
const cdt = () =>
  withCrc([
    0xc8, 0x00, 0x00, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x0a, 0x01, 0xf0,
    0x00,
  ]);

const eit = (tableId: number) =>
  eitSection({
    tableId,
    serviceId: 0x0101,
    transportStreamId: 0x0004,
    originalNetworkId: 0x000a,
    events: [],
  });

/** スクランブルされたパケット (transport_scrambling_control が 0b10)。中身は読めない詰め物 */
function scrambled(pid: number): Uint8Array {
  const packet = new Uint8Array(188).fill(0x5a);
  packet[0] = 0x47;
  packet[1] = 0x40 | (pid >> 8);
  packet[2] = pid & 0xff;
  packet[3] = 0x90;
  return packet;
}

/** 局 1 つの PAT と PMT。PMT の番組全体と映像の ES に記述子を置ける */
function program(info: number[], esInfo: number[] = []): Uint8Array {
  return stream(
    packetize(0x0000, patSection([[0x0101, PMT_PID]], 0x0004)),
    packetize(
      PMT_PID,
      programMap(0x0101, 0x0111, [[0x02, 0x0111, esInfo]], undefined, info),
    ),
  );
}

function observe(...parts: Uint8Array[]) {
  const observer = new CaObserver();
  observer.feed(stream(...parts));
  return observer;
}

describe("CA 記述子", () => {
  test("B-CAS 以外の CA_system_id を PMT と CAT から読み、ECM と EMM の PID と並べる", () => {
    const observed = observe(
      program(ca(OTHER, 0x0901)),
      packetize(0x0001, cat(ca(OTHER, 0x0020))),
    ).result();

    expect(observed.ecm).toEqual([
      { serviceId: 0x0101, caSystemId: OTHER, pid: 0x0901 },
    ]);
    expect(observed.emm).toEqual([
      { serviceId: null, caSystemId: OTHER, pid: 0x0020 },
    ]);
    expect(caSystemIds(observed)).toEqual([OTHER]);
    expect(describeObserved(observed)).toBe(
      "CA_system_id 0x000B (B-CAS 以外) ECM 0x0901・CA_system_id 0x000B (B-CAS 以外) EMM 0x0020、番組表 来ていない、ロゴ 来ていない",
    );
  });

  test("ES ごとの CA 記述子も読み、B-CAS は B-CAS と出す", () => {
    const observed = observe(program([], ca(0x0005, 0x0902))).result();
    expect(caSystemIds(observed)).toEqual([0x0005]);
    expect(describeObserved(observed)).toContain(
      "CA_system_id 0x0005 (B-CAS) ECM 0x0902",
    );
  });

  test("CA 記述子が無ければ無いと出す", () => {
    const observed = observe(program([])).result();
    expect(describeObserved(observed)).toStartWith("CA 記述子なし、");
  });
});

describe("番組表とロゴ", () => {
  test("スクランブルされていない EIT は読め、ほかの TS の局のぶんも分かる", () => {
    const observer = observe(
      program([]),
      packetize(0x0012, eit(0x4e)),
      packetize(0x0012, eit(0x60)),
      packetize(0x0029, cdt()),
    );
    const observed = observer.result();
    expect(observer.epgKnown).toBe(true);
    expect(observed.epg).toBe("readable");
    expect(observed.epgOther).toBe(true);
    expect(observed.logo).toBe("readable");
    expect(epgText(observed)).toBe(
      "番組表 スクランブルされていない (ほかの TS の局のぶんも来ている)",
    );
  });

  test("スクランブルされた EIT と CDT は読まずに、スクランブルされていると出す", () => {
    const observer = observe(
      program([]),
      scrambled(0x0012),
      scrambled(0x0029),
      scrambled(0x0012),
    );
    const observed = observer.result();
    expect(observer.epgKnown).toBe(true);
    expect(observed.epg).toBe("scrambled");
    expect(observed.logo).toBe("scrambled");
    expect(describeObserved(observed)).toBe(
      "CA 記述子なし、番組表 スクランブルされている、ロゴ スクランブルされている",
    );
  });

  test("自 TS の EIT だけなら、ほかの TS の局のぶんは言わない", () => {
    const observed = observe(
      program([]),
      packetize(0x0012, eit(0x50)),
    ).result();
    expect(epgText(observed)).toBe("番組表 スクランブルされていない");
  });

  test("EIT が来なければ、番組表の具合はまだ分からない", () => {
    const observer = observe(program([]));
    expect(observer.epgKnown).toBe(false);
    expect(observer.result().epg).toBe("absent");
  });
});
