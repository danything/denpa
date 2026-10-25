import { describe, expect, test } from "bun:test";

import { PACKET } from "./psi.js";
import { ServiceFilter, StreamsWatch } from "./service-filter.js";
import {
  copyControlDescriptor,
  packetize,
  patSection,
  programMap,
} from "./synth.js";

/** MX1 と MX2 が同じ TS に入っている、実機と同じ構成 */
const MX1 = 23608;
const MX2 = 23609;
const PMT1 = 0x1f0;
const PMT2 = 0x1f1;

/** 適当な中身のパケットを1つ作る。PID だけ合っていればいい */
function payload(pid: number, counter = 0): Uint8Array {
  const out = new Uint8Array(PACKET).fill(0x00);
  out[0] = 0x47;
  out[1] = (pid >> 8) & 0x1f;
  out[2] = pid & 0xff;
  out[3] = 0x10 | (counter & 0x0f);
  return out;
}

/** 実機の TSID。PAT の頭に書いてある */
const TSID = 0x7fe1;

const pat = () =>
  packetize(
    0x0000,
    patSection(
      [
        [MX1, PMT1],
        [MX2, PMT2],
      ],
      TSID,
    ),
  );

/** MX1 は映像 0x100・音声 0x110、MX2 は 0x200・0x210 */
const pmt1 = () =>
  packetize(
    PMT1,
    programMap(
      MX1,
      0x100,
      [
        [0x02, 0x100],
        [0x0f, 0x110],
      ],
      0x900,
    ),
  );
const pmt2 = () =>
  packetize(
    PMT2,
    programMap(MX2, 0x200, [
      [0x02, 0x200],
      [0x0f, 0x210],
    ]),
  );

/** 出てきたバイト列から PID を並べる */
function pids(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let at = 0; at + PACKET <= data.length; at += PACKET) {
    out.push(((data[at + 1]! & 0x1f) << 8) | data[at + 2]!);
  }
  return out;
}

describe("局の選り分け", () => {
  test("PAT が来るまでは何も出さない", () => {
    const filter = new ServiceFilter(MX1);
    expect(filter.ready).toBe(false);
    expect(filter.filter(payload(0x100))).toHaveLength(0);
  });

  test("自局の ES だけ通す。同じ TS のほかの局は落とす", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(Uint8Array.from([...pat(), ...pmt1(), ...pmt2()]));
    expect(filter.ready).toBe(true);

    const out = filter.filter(
      Uint8Array.from([
        ...payload(0x100), // MX1 映像
        ...payload(0x110), // MX1 音声
        ...payload(0x200), // MX2 映像 → 落とす
        ...payload(0x210), // MX2 音声 → 落とす
      ]),
    );
    expect(pids(out)).toEqual([0x100, 0x110]);
  });

  test("ECM は残す。掛かったまま録れたものを後から復号するのに要る", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
    expect(pids(filter.filter(payload(0x900)))).toEqual([0x900]);
  });

  test("局に関係ない表 (NIT/SDT/EIT/TDT/CAT) は残す", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
    const out = filter.filter(
      Uint8Array.from([
        ...payload(0x0001),
        ...payload(0x0010),
        ...payload(0x0011),
        ...payload(0x0012),
        ...payload(0x0014),
      ]),
    );
    expect(pids(out)).toEqual([0x0001, 0x0010, 0x0011, 0x0012, 0x0014]);
  });

  test("詰め物 (PID 0x1FFF) は落とす", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
    expect(filter.filter(payload(0x1fff))).toHaveLength(0);
  });

  /**
   * **ここが目的。** 丸ごと通すと ffmpeg には2つのプログラムが見えて、
   * 1つ目のつもりで読んだ値が2つ目のものだったりする
   */
  test("PAT はその局1つだけに書き直す", () => {
    const filter = new ServiceFilter(MX1);
    const out = filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
    // PAT は1パケットに収まる。先頭に出てくるはず
    expect(pids(out)[0]).toBe(0x0000);

    const section = out.subarray(5, 5 + 20);
    expect(section[0]).toBe(0x00);
    const programs: number[] = [];
    const length = ((section[1]! & 0x0f) << 8) | section[2]!;
    for (let at = 8; at + 4 <= 3 + length - 4; at += 4) {
      programs.push((section[at]! << 8) | section[at + 1]!);
    }
    // 0 は NIT の枠。局は MX1 だけ
    expect(programs).toEqual([0, MX1]);
  });

  /**
   * **絞るのに要るわけではない。** データ放送が受信機に訊いてくるので覚える —
   * テレ朝の TVerリンクはこれを TVer のサーバへ送り、無いと `DT-RE` で止まる
   * ([server/live.ts](https://github.com/danything/denpa/blob/main/src/lib/server/live.ts) の `programInfo`)
   */
  test("中継の番号 (TSID) を PAT から覚える", () => {
    const filter = new ServiceFilter(MX1);
    // 読む前は分からない。**分からないことを 0 と言わない**
    expect(filter.transportStreamId).toBeNull();
    filter.filter(pat());
    expect(filter.transportStreamId).toBe(TSID);
  });

  test("PMT そのものは通す。読む側が ES の意味を知るのに要る", () => {
    const filter = new ServiceFilter(MX1);
    const out = filter.filter(
      Uint8Array.from([...pat(), ...pmt1(), ...pmt2()]),
    );
    expect(pids(out)).toContain(PMT1);
    expect(pids(out)).not.toContain(PMT2);
  });
});

/*
 * **コピー禁止の番組は録らない** (docs/data.md「コピー禁止の番組」)。番組表が古い・無いときの備えに、
 * 録画は PMT の印を見て保存を止める (`recorder.ts`)。絞り方そのものは変えない (ライブはそのまま観られる)
 */
describe("コピー禁止", () => {
  const pmt = (programInfo: number[], videoInfo: number[] = []) =>
    packetize(
      PMT1,
      programMap(
        MX1,
        0x100,
        [
          [0x02, 0x100, videoInfo],
          [0x0f, 0x110],
        ],
        undefined,
        programInfo,
      ),
    );

  test("PMT を読むまでは禁止と言わない", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(pat());
    expect(filter.copyNever).toBe(false);
  });

  test("番組ぜんたいの記述子で禁止なら禁止。1世代のみは禁止ではない", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(
      Uint8Array.from([...pat(), ...pmt(copyControlDescriptor(0b11))]),
    );
    expect(filter.copyNever).toBe(true);

    filter.filter(pmt(copyControlDescriptor(0b10)));
    expect(filter.copyNever).toBe(false);
  });

  test("ES ごとの記述子で禁止でも禁止", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(
      Uint8Array.from([...pat(), ...pmt([], copyControlDescriptor(0b11))]),
    );
    expect(filter.copyNever).toBe(true);
  });

  test("途中で禁止に変わり、また解ける。絞り方は変わらない", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(Uint8Array.from([...pat(), ...pmt([])]));
    expect(filter.copyNever).toBe(false);

    filter.filter(pmt(copyControlDescriptor(0b11)));
    expect(filter.copyNever).toBe(true);
    expect(pids(filter.filter(payload(0x100)))).toEqual([0x100]);

    filter.filter(pmt([]));
    expect(filter.copyNever).toBe(false);
  });
});

/**
 * **映像・音声・字幕の並び** (`streams`)。ライブはこれが変わったら ffmpeg を作り直す (`server/live.ts` の `restart`)。
 * 番組が替わって音声が増えた・字幕の PID が変わったときだけ変わり、データ放送の増減では変わらない
 */
describe("映像・音声・字幕の並び", () => {
  const map = (streams: ([number, number] | [number, number, number[]])[]) =>
    packetize(PMT1, programMap(MX1, 0x100, streams));

  test("PMT を読むまでは null。読めば種別と PID の並び", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(pat());
    expect(filter.streams).toBeNull();
    filter.filter(pmt1());
    expect(filter.streams).toBe("2:256,15:272");
  });

  test("音声が増えた・字幕の PID が変わったら変わる。データ放送の増減では変わらない", () => {
    const filter = new ServiceFilter(MX1);
    filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
    const before = filter.streams;

    filter.filter(
      map([
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x0d, 0x140],
      ]),
    );
    expect(filter.streams).toBe(before);

    filter.filter(
      map([
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x0f, 0x111],
      ]),
    );
    expect(filter.streams).toBe("2:256,15:272,15:273");

    filter.filter(
      map([
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x06, 0x130],
      ]),
    );
    const captioned = filter.streams;
    filter.filter(
      map([
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x06, 0x131],
      ]),
    );
    expect(filter.streams).not.toBe(captioned);
  });
});

/**
 * **並びが変わったか** (`StreamsWatch`)。ライブ・追っかけのエンコードと、放送のままの経路の字幕の ffmpeg は、
 * これが true を返したら起こし直す。最初に読んだ並びは「変わった」にしない
 */
describe("並びが変わったか", () => {
  const map = (streams: [number, number][]) =>
    packetize(PMT1, programMap(MX1, 0x100, streams));

  test("最初の PMT では変わったことにしない。変わったら1回だけ true、データ放送の増減では false", () => {
    const filter = new ServiceFilter(MX1);
    const watch = new StreamsWatch();
    filter.filter(pat());
    expect(watch.changed(filter)).toBe(false);
    filter.filter(pmt1());
    expect(watch.changed(filter)).toBe(false);
    filter.filter(pmt1());
    expect(watch.changed(filter)).toBe(false);

    filter.filter(
      map([
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x0d, 0x140],
      ]),
    );
    expect(watch.changed(filter)).toBe(false);

    filter.filter(
      map([
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x0f, 0x111],
      ]),
    );
    expect(watch.changed(filter)).toBe(true);
    expect(watch.changed(filter)).toBe(false);

    // 元の並びに戻ったのも変わったこと (切り替わりの前後で行き来する局)
    filter.filter(pmt1());
    expect(watch.changed(filter)).toBe(true);
  });
});
