import { describe, expect, test } from "bun:test";

import { withCrc } from "@danything/arib/psi";

import { announcesCommonData, parseSdtt } from "./logo-sdtt";

const LOGO_TAGS = new Set([0x79, 0x7a]);

/** download_content_descriptor (0xC9)。モジュールの情報も文字も持たせない */
function downloadContent(componentTag: number): number[] {
  return [
    0xc9,
    17,
    0x00, // reboot・add_on・compatibility・module_info・text_info の印はどれも立てない
    0x00,
    0x04,
    0x93,
    0xe0, // component_size
    0x12,
    0x34,
    0x56,
    0x78, // download_id
    0x00,
    0x00,
    0xea,
    0x60, // time_out_value_DII
    0x00,
    0x27,
    0x10, // leak_rate + reserved
    componentTag,
  ];
}

/** 予定1つ: 2026-11-03 04:30:00 から 20 分 (MJD + BCD) */
const SCHEDULE = [0xef, 0xa3, 0x04, 0x30, 0x00, 0x00, 0x20, 0x00];

function sdtt(
  makerId: number,
  modelId: number,
  contents: {
    newVersion: number;
    schedules: number[];
    descriptors: number[];
  }[],
): Uint8Array {
  const body = [0xc3, 0, 0, makerId, modelId, 0xc1, 0, 0];
  body.push(0x40, 0x31, 0x00, 0x04, 0x03, 0xa1, contents.length);
  for (const c of contents) {
    const length = c.schedules.length + c.descriptors.length;
    body.push(
      0x00, // group・target_version の上
      0x01,
      c.newVersion >> 4,
      ((c.newVersion & 0x0f) << 4) | 0x06,
      length >> 4,
      ((length & 0x0f) << 4) | 0x0f,
      c.schedules.length >> 4,
      (c.schedules.length & 0x0f) << 4,
      ...c.schedules,
      ...c.descriptors,
    );
  }
  return withCrc(body);
}

describe("SDTT", () => {
  test("全受信機共通データの SDTT は予定を持たず、ロゴの ES の component_tag を指す", () => {
    const parsed = parseSdtt(
      sdtt(0xff, 0xfe, [
        {
          newVersion: 0x123,
          schedules: [],
          descriptors: downloadContent(0x79),
        },
      ]),
    );
    expect(parsed).toEqual({
      makerId: 0xff,
      modelId: 0xfe,
      serviceId: 929,
      contents: [{ newVersion: 0x123, schedules: 0, componentTags: [0x79] }],
    });
    expect(announcesCommonData(parsed!, LOGO_TAGS)).toBe(true);
  });

  test("受信機のソフト更新は予定を持つ。予定を飛ばして記述子を読む。ロゴの印にはしない", () => {
    const parsed = parseSdtt(
      sdtt(0x19, 0x01, [
        {
          newVersion: 5,
          schedules: [...SCHEDULE, ...SCHEDULE],
          descriptors: [0xfe, 2, 0, 0, ...downloadContent(0x71)],
        },
        {
          newVersion: 6,
          schedules: SCHEDULE,
          descriptors: downloadContent(0x72),
        },
      ]),
    );
    expect(parsed?.contents).toEqual([
      { newVersion: 5, schedules: 2, componentTags: [0x71] },
      { newVersion: 6, schedules: 1, componentTags: [0x72] },
    ]);
    expect(announcesCommonData(parsed!, LOGO_TAGS)).toBe(false);
  });

  test("送る前の試験 (model_id 0xFD) と、ロゴでない ES を指す共通データはロゴの印にしない", () => {
    const test = parseSdtt(
      sdtt(0xff, 0xfd, [
        { newVersion: 1, schedules: [], descriptors: downloadContent(0x79) },
      ]),
    );
    expect(announcesCommonData(test!, LOGO_TAGS)).toBe(false);
    const other = parseSdtt(
      sdtt(0xff, 0xfe, [
        { newVersion: 1, schedules: [], descriptors: downloadContent(0x71) },
      ]),
    );
    expect(announcesCommonData(other!, LOGO_TAGS)).toBe(false);
  });

  test("SDTT でないもの・切れているものは読まない。長さが中身を越えても外へ読みに行かない", () => {
    expect(parseSdtt(Uint8Array.from([0x00, 0xb0, 0x0d]))).toBeNull();
    const broken = sdtt(0xff, 0xfe, [
      { newVersion: 1, schedules: [], descriptors: downloadContent(0x79) },
    ]);
    // 記述子の長さを中身より大きく書き換える (CRC は確かめ済みで渡される前提なので、読む側は長さだけ守る)
    broken[24] = 0xf0;
    expect(parseSdtt(broken)?.contents[0]?.componentTags).toEqual([]);
  });
});
