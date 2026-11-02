/**
 * SDTT (ソフトウェアダウンロードトリガーテーブル) から、**衛星のロゴがいま流れているか**だけを読む。
 *
 * 衛星のロゴは全受信機共通データとして、エンジニアリングサービス (929) のカルーセルで運ばれる
 * (`logo-dsmcc.ts`)。ARIB TR-B15 (第一部 BS デジタル放送ダウンロード運用規定 5.1.2.2・5.1.3.2・5.3.2) では、
 * 共通データの SDTT は**予定 (開始時刻・長さ) を持たず、カルーセルを流している間だけ**送られる。
 * 予定を持つのは受信機のソフト更新の SDTT だけで、ロゴの時刻は前もって分からない。
 * なのでここで読むのは「いま共通データのダウンロードが出ているか」だけ (`server/logo-period.ts`)。
 *
 * 書式は ARIB STD-B21 12.2.1 / TR-B15。PID 0x0023、table_id 0xC3、table_id_extension が
 * maker_id (8bit) + model_id (8bit)。中身ごとに download_content_descriptor (0xC9) が付き、
 * その component_tag で運ぶ ES が分かる。
 */

import { u16 } from "@danything/arib/bytes";

/** SDTT が乗る PID (ARIB STD-B10。地上波の 0x0028 は衛星では使わない) */
export const PID_SDTT = 0x0023;
const TABLE_SDTT = 0xc3;
const DESC_DOWNLOAD_CONTENT = 0xc9;

/**
 * 全受信機共通データの maker_id / model_id。0xFE が本番、0xFD が送る前の試験 (TR-B15 5.1.2.2・7.1.8)。
 * 試験のものはロゴの印にしない
 */
const COMMON_MAKER_ID = 0xff;
const COMMON_MODEL_ID = 0xfe;

/** 中身1つ。ロゴの判断に使うものだけ */
export interface SdttContent {
  /** 共通データの版。共通データ全体で1つの番号 (TR-B15 5.1.6.2) */
  newVersion: number;
  /** 予定の数。共通データは 0 (TR-B15 5.1.2.2) */
  schedules: number;
  /** download_content_descriptor の component_tag。運ぶ ES の目印 */
  componentTags: number[];
}

export interface Sdtt {
  makerId: number;
  modelId: number;
  /** ダウンロードを運ぶサービス。いまは 929 だけ (TR-B15 5.1.2) */
  serviceId: number;
  contents: SdttContent[];
}

/** SDTT を読む。SDTT でない・短すぎるものは null。CRC は `SectionAssembler` が確かめ済みのものを渡す */
export function parseSdtt(section: Uint8Array): Sdtt | null {
  if (section[0] !== TABLE_SDTT || section.length < 19) return null;
  const end = section.length - 4;
  const contents: SdttContent[] = [];
  let at = 15;
  for (let n = section[14]!; n > 0 && at + 8 <= end; n--) {
    const newVersion = (section[at + 2]! << 4) | (section[at + 3]! >> 4);
    const contentLength = (section[at + 4]! << 4) | (section[at + 5]! >> 4);
    const scheduleLength = (section[at + 6]! << 4) | (section[at + 7]! >> 4);
    const body = at + 8;
    const bodyEnd = Math.min(body + contentLength, end);
    const componentTags: number[] = [];
    // 予定 (8バイトずつ) のあとに記述子が並ぶ。記述子の長さの欄は無い
    for (let p = Math.min(body + scheduleLength, bodyEnd); p + 2 <= bodyEnd;) {
      const tag = section[p]!;
      const length = section[p + 1]!;
      if (p + 2 + length > bodyEnd) break;
      // component_tag は記述子の中身の 17 バイト目 (フラグ1・大きさ4・download_id 4・DII待ち4・leak_rate 3 のあと)
      if (tag === DESC_DOWNLOAD_CONTENT && length >= 17)
        componentTags.push(section[p + 2 + 16]!);
      p += 2 + length;
    }
    contents.push({
      newVersion,
      schedules: Math.floor(scheduleLength / 8),
      componentTags,
    });
    at = body + contentLength;
  }
  return {
    makerId: section[3]!,
    modelId: section[4]!,
    serviceId: u16(section, 12),
    contents,
  };
}

/**
 * 全受信機共通データのダウンロードで、`tags` (ロゴの ES の component_tag) のどれかを運ぶものか。
 * これが来ている間は、ロゴのカルーセルが流れている
 */
export function announcesCommonData(
  sdtt: Sdtt,
  tags: ReadonlySet<number>,
): boolean {
  return (
    sdtt.makerId === COMMON_MAKER_ID &&
    sdtt.modelId === COMMON_MODEL_ID &&
    sdtt.contents.some((c) => c.componentTags.some((tag) => tags.has(tag)))
  );
}
