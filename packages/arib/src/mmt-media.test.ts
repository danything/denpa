import { describe, expect, test } from "bun:test";

import {
  CLOCK,
  LatmReader,
  type MediaEvent,
  MmtMediaReader,
  ntpToClock,
  parseMpuExtendedTimestamps,
  parseMpuTimestamps,
  unitTime,
} from "./mmt-media.js";
import {
  compressedIp,
  latmElement,
  mfuPackets,
  mmtpPacket,
  mptTable,
  mpuExtendedTimestampDescriptor,
  mpuTimestampDescriptor,
  paMessage,
  signalingPackets,
  type SynthAsset,
  type SynthNtp,
} from "./synth-mmt.js";

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g)!.map((b) => parseInt(b, 16)));

/**
 * 実機のケーブルの BS4K (QC26) の MPT にあった、映像のアセットの記述子の中身 (最初の MPU のぶん)。
 * timescale 180000、pts_offset はどれも 3003 (59.94 コマ)、1 MPU に 32 コマ
 */
const QC26_TIMESTAMP = hex("0058da25ee9e4b21df125947");
const QC26_EXTENDED = hex(
  "fb0002bf200bbb" +
    "0058da253f233020" +
    "754e3aa8177600000bba23320bba1776".repeat(4),
);

describe("MPU の時刻", () => {
  test("実機の MPT の記述子を読む", () => {
    const [[sequence, presentation]] = parseMpuTimestamps(QC26_TIMESTAMP) as [
      [number, number],
    ];
    expect(sequence).toBe(0x58da25);
    // 2026-11-11 の NTP の秒
    expect(Math.floor(presentation / CLOCK)).toBe(0xee9e4b21);
    const [extended] = parseMpuExtendedTimestamps(QC26_EXTENDED);
    expect(extended).toMatchObject({
      mpuSequenceNumber: 0x58da25,
      timescale: 180000,
      decodingOffset: 9008,
    });
    expect(extended!.dtsPtsOffsets).toHaveLength(32);
    expect(new Set(extended!.durations)).toEqual(new Set([3003]));
  });

  test("デコードの順の 8 コマが、表示の順では隙間なく並び、最初の提示時刻から始まる", () => {
    const [[, presentation]] = parseMpuTimestamps(QC26_TIMESTAMP) as [
      [number, number],
    ];
    const extended = parseMpuExtendedTimestamps(QC26_EXTENDED)[0]!;
    const times = Array.from({ length: 32 }, (_, i) =>
      unitTime(presentation, extended, i)!,
    );
    // DTS は 1 コマずつ (90 kHz で 1501.5) 進む
    for (let i = 1; i < 32; i++)
      expect(times[i]!.dts - times[i - 1]!.dts).toBeOneOf([1501, 1502]);
    // 実機の dts_pts_offset は 180000 の単位で 1 ずれたもの (3002・9010) があり、90 kHz に直すと前後に 1 ずれる
    const pts = times.map((t) => t.pts).sort((a, b) => a - b);
    expect(Math.abs(pts[0]! - presentation)).toBeLessThanOrEqual(1);
    for (let i = 1; i < 32; i++)
      expect(pts[i]! - pts[i - 1]!).toBeOneOf([1500, 1501, 1502, 1503]);
    expect(unitTime(presentation, extended, 32)).toBeNull();
  });

  test("NTP の端数を 90 kHz に直す", () => {
    expect(ntpToClock(hex("0000000180000000"), 0)).toBe(CLOCK + CLOCK / 2);
  });

  test("timescale の無い拡張タイムスタンプは読まない", () => {
    expect(parseMpuExtendedTimestamps(hex("fa0bbb0000000100000001"))).toEqual(
      [],
    );
  });

  test("pts_offset の無い拡張タイムスタンプ (種類 0) は、コマの長さが分からないので読まない", () => {
    expect(
      parseMpuExtendedTimestamps(hex("f9000075300000000a3f0000010000")),
    ).toEqual([]);
  });

  test("予約の種類 3 の拡張タイムスタンプは読まない", () => {
    expect(
      parseMpuExtendedTimestamps(hex("ff000075300000000a3f0000010000")),
    ).toEqual([]);
  });
});

describe("LatmReader", () => {
  const asc = [0x11, 0x90]; // AAC LC、48 kHz、2 チャンネル

  test("設定を読み、あいだの「前と同じ」にも同じ設定を付ける", () => {
    const latm = new LatmReader();
    const first = latm.read(latmElement([1, 2, 3], asc))!;
    expect(first.config).toMatchObject({
      objectType: 2,
      sampleRate: 48000,
      channels: 2,
    });
    expect([...first.config.audioSpecificConfig]).toEqual(asc);
    expect([...first.frame]).toEqual([1, 2, 3]);
    const next = latm.read(latmElement([4, 5]))!;
    expect(next.config).toBe(first.config);
    expect([...next.frame]).toEqual([4, 5]);
  });

  test("255 バイトを越える長さ", () => {
    const frame = Array.from({ length: 600 }, (_, i) => i & 0xff);
    const read = new LatmReader().read(latmElement(frame, asc))!;
    expect([...read.frame]).toEqual(frame);
  });

  test("設定が来るまでのフレームと、切れたフレームは読まない", () => {
    const latm = new LatmReader();
    expect(latm.read(latmElement([1, 2]))).toBeNull();
    expect(latm.read(latmElement([1, 2, 3], asc).subarray(0, 6))).toBeNull();
  });
});

const SERVICE = 0xa1;
const VIDEO = 0xf100;
const AUDIO = 0xf110;
const CAPTION = 0xf130;
const CID = 1;
/** 2026-11-11 ごろの NTP の秒 */
const SECONDS = 0xee9e4b21;
const at = (offset: number): SynthNtp => [SECONDS + offset, 0];

/** 映像 (2 MPU × 3 コマ、30000 で 1 コマ 1000)・音声 (1 MPU × 2 フレーム)・字幕の時刻を載せた MPT */
function mpt(
  assets: Partial<Record<"video" | "audio" | "caption", boolean>> = {},
) {
  const list: SynthAsset[] = [];
  if (assets.video !== false)
    list.push({
      type: "hev1",
      packetId: VIDEO,
      componentTag: 0x00,
      descriptors: [
        ...mpuTimestampDescriptor([
          [10, at(0)],
          [11, at(1)],
        ]),
        ...mpuExtendedTimestampDescriptor(
          30000,
          [
            { sequence: 10, decodingOffset: 1000, dtsPtsOffsets: [2000, 0, 0] },
            { sequence: 11, decodingOffset: 1000, dtsPtsOffsets: [2000, 0, 0] },
          ],
          1000,
        ),
      ],
    });
  if (assets.audio !== false)
    list.push({
      type: "mp4a",
      packetId: AUDIO,
      componentTag: 0x10,
      descriptors: [
        ...mpuTimestampDescriptor([[20, at(0)]]),
        ...mpuExtendedTimestampDescriptor(48000, [
          {
            sequence: 20,
            decodingOffset: 0,
            dtsPtsOffsets: [0, 0],
            durations: [1024, 1024],
          },
        ]),
      ],
    });
  if (assets.caption !== false)
    list.push({
      type: "stpp",
      packetId: CAPTION,
      componentTag: 0x30,
      descriptors: [
        ...mpuTimestampDescriptor([[30, at(0)]]),
        ...mpuExtendedTimestampDescriptor(
          1000,
          [{ sequence: 30, decodingOffset: 0, dtsPtsOffsets: [0] }],
          0,
        ),
      ],
    });
  return signalingPackets(0xff01, [
    paMessage(mptTable({ packageId: SERVICE, assets: list })),
  ]).map((p) => compressedIp(CID, p));
}

/** 長さ (4 バイト) を前に付けた NAL ユニット */
function nal(type: number, size: number, fill = 0): number[] {
  const body = [type << 1, 0x01, ...new Array(size).fill(fill)];
  const n = body.length;
  return [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, ...body];
}

const ip = (packets: Uint8Array[]) => packets.map((p) => compressedIp(CID, p));

function read(
  packets: Uint8Array[],
  reader = new MmtMediaReader(SERVICE),
): MediaEvent[] {
  const out: MediaEvent[] = [];
  for (const packet of packets) out.push(...reader.feed(packet));
  return out;
}

const units = (events: MediaEvent[]) =>
  events.filter((e) => e.kind !== "assets");

describe("MmtMediaReader", () => {
  test("MPT のアセットを選び、映像のコマを組み立てて時刻を付ける", () => {
    let sequence = 0;
    const picture = (mpu: number, sample: number, key: boolean) => [
      // 小さな NAL ユニットは集約、大きなスライスは分割して送る
      ...mfuPackets(
        VIDEO,
        mpu,
        key
          ? [32, 33, 34].map((type) => ({ sample, data: nal(type, 3) }))
          : [{ sample, data: nal(35, 1) }],
        { aggregate: true, sequenceNumber: sequence++, rap: key },
      ),
      ...mfuPackets(
        VIDEO,
        mpu,
        [{ sample, data: nal(key ? 19 : 1, 500, sample) }],
        {
          fragment: 120,
          sequenceNumber: (sequence += 5) - 5,
        },
      ),
    ];
    const events = read([
      ...mpt(),
      ...ip(picture(10, 0, true)),
      ...ip(picture(10, 1, false)),
      ...ip(picture(10, 2, false)),
      ...ip(picture(11, 0, true)),
    ]);
    expect(events[0]).toEqual({
      kind: "assets",
      assets: [
        { kind: "video", type: "hev1", packetId: VIDEO, componentTag: 0x00 },
        { kind: "audio", type: "mp4a", packetId: AUDIO, componentTag: 0x10 },
        {
          kind: "caption",
          type: "stpp",
          packetId: CAPTION,
          componentTag: 0x30,
        },
      ],
    });
    // MPU 11 の最初のコマは、次が来るまで閉じない
    const video = units(events).filter((e) => e.kind === "video");
    expect(video.map((v) => [v.mpuSequenceNumber, v.keyframe])).toEqual([
      [10, true],
      [10, false],
      [10, false],
    ]);
    expect(video[0]!.nals.map((n) => (n[0]! >> 1) & 0x3f)).toEqual([
      32, 33, 34, 19,
    ]);
    expect(video[0]!.nals[3]!.length).toBe(502);
    // 30000 の 1000 は 90 kHz の 3000。最初の提示時刻は MPU 10 の 2 コマ目 (I の前に B が 1 つ並ぶ)
    const base = SECONDS * CLOCK;
    expect(video.map((v) => [v.dts - base, v.pts - base, v.duration])).toEqual([
      [-3000, 3000, 3000],
      [0, 0, 3000],
      [3000, 3000, 3000],
    ]);
  });

  test("音声は LATM を外し、字幕は文書を返す", () => {
    const asc = [0x11, 0x90];
    const events = read([
      ...mpt(),
      ...ip(
        mfuPackets(AUDIO, 20, [
          { sample: 1, data: latmElement([0xaa, 0xbb], asc) },
          { sample: 2, data: latmElement([0xcc]) },
        ]),
      ),
      ...ip(
        mfuPackets(CAPTION, 30, [
          { sample: 1, data: [...new TextEncoder().encode("<tt>字幕</tt>")] },
        ]),
      ),
      // 次の MPU の始まりで閉じる
      ...ip(
        mfuPackets(AUDIO, 21, [{ sample: 1, data: latmElement([0]) }], {
          sequenceNumber: 2,
        }),
      ),
      ...ip(
        mfuPackets(CAPTION, 31, [{ sample: 1, data: [0x3c] }], {
          sequenceNumber: 1,
        }),
      ),
    ]);
    const audio = units(events).filter((e) => e.kind === "audio");
    expect(audio.map((a) => [...a.frame])).toEqual([[0xaa, 0xbb], [0xcc]]);
    const base = SECONDS * CLOCK;
    expect(audio.map((a) => [a.dts - base, a.duration])).toEqual([
      [0, 1920],
      [1920, 1920],
    ]);
    const caption = units(events).find((e) => e.kind === "caption");
    expect(caption).toMatchObject({ document: "<tt>字幕</tt>", pts: base });
  });

  test("欠けたコマ、スクランブルされたパケット、時刻の分からない MPU は捨てて数える", () => {
    const reader = new MmtMediaReader(SERVICE);
    const slice = (mpu: number, sample: number, from: number) =>
      mfuPackets(VIDEO, mpu, [{ sample, data: nal(1, 300) }], {
        fragment: 100,
        sequenceNumber: from,
      });
    const lost = slice(10, 1, 4);
    read(
      [
        ...mpt(),
        // MPT に時刻の載っていない MPU
        ...ip(slice(9, 1, 0)),
        // 途中の断片が 1 つ欠ける
        ...ip([lost[0]!, lost[2]!, lost[3]!]),
        ...ip(slice(10, 2, 8)),
        ip([
          mmtpPacket({
            packetId: VIDEO,
            payloadType: 0,
            sequenceNumber: 12,
            scrambling: "odd",
            payload: [0, 8, 0x28, 0, 0, 0, 0, 10],
          }),
        ])[0]!,
        ...ip(slice(11, 0, 13)),
      ],
      reader,
    );
    expect(reader.untimed).toBe(1);
    expect(reader.scrambled).toBe(1);
    expect(reader.media).toBeGreaterThan(reader.scrambled);
    // 欠けたコマ (sample 1) と、スクランブルのパケットが割り込んだコマ (sample 2)
    expect(reader.dropped).toBe(2);
  });

  test("先頭の断片が欠けたコマも 1 つと数え、後ろのコマの時刻をずらさない", () => {
    const reader = new MmtMediaReader(SERVICE);
    const sample1 = mfuPackets(VIDEO, 10, [{ sample: 1, data: nal(1, 300) }], {
      fragment: 100,
      sequenceNumber: 1,
    });
    const events = read(
      [
        ...mpt(),
        ...ip(
          mfuPackets(VIDEO, 10, [{ sample: 0, data: nal(19, 10) }], {
            rap: true,
          }),
        ),
        // sample 1 の先頭の断片が欠ける
        ...ip(sample1.slice(1)),
        ...ip(
          mfuPackets(VIDEO, 10, [{ sample: 2, data: nal(1, 10) }], {
            sequenceNumber: 5,
          }),
        ),
        ...ip(
          mfuPackets(VIDEO, 11, [{ sample: 0, data: nal(19, 10) }], {
            sequenceNumber: 6,
          }),
        ),
      ],
      reader,
    );
    // 欠けた所の手前のコマ (sample 0) は、欠けたのがどちらのコマか分からないので捨てる
    const base = SECONDS * CLOCK;
    expect(
      units(events)
        .filter((e) => e.kind === "video")
        .map((v) => [v.dts - base, v.pts - base]),
    ).toEqual([[3000, 3000]]);
    expect(reader.dropped).toBe(2);
  });

  test("ほかの局の MPT は読まない", () => {
    expect(read(mpt(), new MmtMediaReader(0xa2))).toEqual([]);
  });

  test("アセットが変わったら、もう一度 assets を返す", () => {
    const events = read([...mpt(), ...mpt(), ...mpt({ caption: false })]);
    expect(
      events.map((e) => (e.kind === "assets" ? e.assets.length : null)),
    ).toEqual([3, 2]);
  });
});
