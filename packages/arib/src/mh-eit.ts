/**
 * 4K の放送 (MMT/TLV) の番組表 MH-EIT (ARIB STD-B60) を、TS の番組表と同じ `EitEvent` に読む。
 *
 * 並びは TS の EIT と同じで、違うのは次の所 (実機のケーブルの BS4K で確かめた)。
 *
 * - TS の transport_stream_id の位置に tlv_stream_id が入る。`EitEvent.transportStreamId` にはそれを入れる
 * - table_id は p/f が 0x8B、予定の基本が 0x8C から、詳細が 0x94 から。**TS の番号 (0x4E・0x50・0x58) に直して返す**
 *   ので、揃ったかの数え方 (`ScheduleProgress`) と混ぜ方 (`EpgReader`) をそのまま使える
 * - 記述子のタグが 2 バイトで (`mmt-si.ts` の `mmtDescriptors`)、文字は UTF-8。番組名の「🈑」なども Unicode の文字で来る
 *
 * 番組の記述子で読むのは、MH-短形式イベント (0xF001)・MH-拡張形式イベント (0xF002)・MH-コンテント (0x8012)・
 * 映像コンポーネント (0x8010)・MH-音声コンポーネント (0x8014)・コンテンツコピー制御 (0x8038)。
 * シリーズの記述子は来ていないので読まない (`series` を付けない。「この表は言っていない」)
 */

import { ascii, joinBytes, u16 } from "./bytes.js";
import {
  type EitEvent,
  type EitSection,
  EpgReader,
  parseBcdDuration,
  parseMjdTime,
  PresentFollowing,
} from "./eit.js";
import { mmtDescriptors, MmtTableStream, mmtText } from "./mmt-si.js";
import { isCopyNever } from "./psi.js";

const MH_PF_ACTUAL = 0x8b;
const MH_SCHEDULE_MIN = 0x8c;
const MH_SCHEDULE_MAX = 0x9b;
/** TS の EIT の番号 (p/f 0x4E、予定 0x50〜0x5F) */
const TS_PF_ACTUAL = 0x4e;
const TS_SCHEDULE_MIN = 0x50;
/** TS の詳細の表の始まり。これより後ろの表は基本の記述子 (コピー制御など) を載せない */
const TS_SCHEDULE_EXTENDED = 0x58;

const DESC_SHORT_EVENT = 0xf001;
const DESC_EXTENDED_EVENT = 0xf002;
const DESC_CONTENT = 0x8012;
const DESC_VIDEO_COMPONENT = 0x8010;
const DESC_AUDIO_COMPONENT = 0x8014;
const DESC_CONTENT_COPY_CONTROL = 0x8038;

/** MH-EIT の table_id を TS の EIT の番号に。番組表でなければ null */
function tsTableId(tableId: number): number | null {
  if (tableId === MH_PF_ACTUAL) return TS_PF_ACTUAL;
  if (tableId >= MH_SCHEDULE_MIN && tableId <= MH_SCHEDULE_MAX)
    return TS_SCHEDULE_MIN + (tableId - MH_SCHEDULE_MIN);
  return null;
}

/** video_resolution (4 ビット) の走査線の数。0 は未定義 */
const LINES: Record<number, number> = {
  1: 180,
  2: 240,
  3: 480,
  4: 720,
  5: 1080,
  6: 2160,
  7: 4320,
};

/** sampling_rate (3 ビット)。TS の音声コンポーネント記述子と同じ符号 */
const SAMPLING_RATE: Record<number, number> = {
  1: 16000,
  2: 22050,
  3: 24000,
  5: 32000,
  6: 44100,
  7: 48000,
};

const lang = (data: Uint8Array, at: number) => ascii(data, at, 3).toLowerCase();

/**
 * 番組の記述子を読んで埋める。**拡張形式イベントは項目ごとに、バイトのまま繋いでから文字にする。**
 * UTF-8 の 1 文字が記述子の切れ目をまたぐことがあり、部分ごとに文字にすると、またいだ字が U+FFFD になる。
 * 見出しが空の項目は直前の項目の続き (TS の `eit.ts` と同じ決まり)
 */
function readDescriptors(event: EitEvent, body: Uint8Array): void {
  const pending = new Map<string, Uint8Array[][]>();
  let lastHeading = "";

  for (const [tag, data] of mmtDescriptors(body)) {
    switch (tag) {
      case DESC_SHORT_EVENT: {
        // 言語 (3)・番組名の長さ (1)・番組名・説明の長さ (2)・説明
        if (data.length < 4) break;
        const textAt = 4 + data[3]!;
        event.name = mmtText(data.subarray(4, textAt));
        if (textAt + 2 > data.length) break;
        event.description = mmtText(
          data.subarray(textAt + 2, textAt + 2 + u16(data, textAt)),
        );
        break;
      }
      case DESC_EXTENDED_EVENT: {
        // 番号 (1)・言語 (3)・項目の長さ (2)。項目は見出し (長さ 1 バイト) と本文 (長さ 2 バイト) の組
        if (data.length < 6) break;
        const itemsEnd = Math.min(data.length, 6 + u16(data, 4));
        let at = 6;
        while (at + 1 <= itemsEnd) {
          const headingEnd = at + 1 + data[at]!;
          if (headingEnd + 2 > itemsEnd) break;
          const heading = mmtText(data.subarray(at + 1, headingEnd));
          const textEnd = headingEnd + 2 + u16(data, headingEnd);
          const text = data.subarray(headingEnd + 2, textEnd);
          at = textEnd;
          if (heading === "") {
            if (lastHeading === "") continue;
            pending.get(lastHeading)!.at(-1)!.push(text);
            continue;
          }
          const items = pending.get(heading);
          if (items === undefined) pending.set(heading, [[text]]);
          else items.push([text]);
          lastHeading = heading;
        }
        break;
      }
      case DESC_CONTENT: {
        for (let at = 0; at + 2 <= data.length; at += 2)
          event.genres.push({ lv1: data[at]! >> 4, lv2: data[at]! & 0x0f });
        break;
      }
      case DESC_VIDEO_COMPONENT: {
        // video_resolution (4)・アスペクト比 (4)、走査 (1: プログレッシブ)・予約 (2)・コマの速さ (5)
        if (data.length < 2) break;
        const lines = LINES[data[0]! >> 4];
        const progressive = (data[1]! & 0x80) !== 0;
        // 符号化の方式はこの記述子に無い (MPT のアセットの型で分かる)
        event.video = {
          type: null,
          resolution:
            lines === undefined ? null : `${lines}${progressive ? "p" : "i"}`,
        };
        break;
      }
      /*
       * MH-音声コンポーネント記述子。TS の音声コンポーネント記述子と比べて、component_tag が 2 バイトになっている。
       *
       *     [0] reserved(4) stream_content(4)
       *     [1] component_type
       *     [2..3] component_tag
       *     [4] stream_type
       *     [5] simulcast_group_tag
       *     [6] 多言語(1) 主音声(1) 品質(2) 標本化周波数(3) reserved(1)
       *     [7..9]   ISO 639-2
       *     [10..12] ISO 639-2 (多言語のときだけ)
       *     [残り]   text_char (UTF-8)
       */
      case DESC_AUDIO_COMPONENT: {
        if (data.length < 10) break;
        const flags = data[6]!;
        const multiLingual = (flags & 0x80) !== 0;
        const langs = [lang(data, 7)];
        if (multiLingual) langs.push(lang(data, 10));
        const text = mmtText(data.subarray(multiLingual ? 13 : 10)).trim();
        const samplingRate = SAMPLING_RATE[(flags >> 1) & 0x07];
        event.audios.push({
          componentType: data[1]!,
          langs,
          ...(samplingRate === undefined ? {} : { samplingRate }),
          ...(text === "" ? {} : { text }),
          main: (flags & 0x40) !== 0,
        });
        break;
      }
      case DESC_CONTENT_COPY_CONTROL: {
        // 先頭 2 ビットが digital_recording_control_data で、TS のデジタルコピー制御記述子と同じ符号
        event.copyNever = isCopyNever(data);
        break;
      }
      default:
        break;
    }
  }

  for (const [heading, items] of pending)
    event.extended[heading] = items
      .map((parts) => mmtText(joinBytes(parts)))
      .join("");
}

/**
 * MH-EIT のセクションを 1 本読む。table_id は TS の番号に直す。番組表でなければ null。
 * CRC は読む前に確かめてある (`MmtTableStream`) ので、長さの合わない番組の手前まで返す
 */
export function parseMhEit(section: Uint8Array): EitSection | null {
  if (section.length < 18) return null;
  const tableId = tsTableId(section[0]!);
  if (tableId === null) return null;
  const extended = tableId >= TS_SCHEDULE_EXTENDED;
  const lastTableId = tsTableId(section[13]!) ?? tableId;

  const result: EitSection = {
    tableId,
    serviceId: u16(section, 3),
    version: (section[5]! >> 1) & 0x1f,
    sectionNumber: section[6]!,
    lastSectionNumber: section[7]!,
    transportStreamId: u16(section, 8),
    originalNetworkId: u16(section, 10),
    segmentLastSectionNumber: section[12]!,
    lastTableId,
    events: [],
  };

  let at = 14;
  const end = section.length - 4;
  while (at + 12 <= end) {
    const descriptorsLength = u16(section, at + 10) & 0x0fff;
    const body = section.subarray(at + 12, at + 12 + descriptorsLength);
    const event: EitEvent = {
      serviceId: result.serviceId,
      transportStreamId: result.transportStreamId,
      originalNetworkId: result.originalNetworkId,
      eventId: u16(section, at),
      startAt: parseMjdTime(section, at + 2),
      duration: parseBcdDuration(section, at + 7),
      runningStatus: (section[at + 10]! >> 5) & 0x07,
      isFree: (section[at + 10]! & 0x10) === 0,
      name: "",
      description: "",
      extended: {},
      genres: [],
      audios: [],
      video: null,
      copyNever: extended ? null : false,
      // B-CAS の契約確認は使わない
      ...(extended ? {} : { contractVerification: null }),
    };
    at += 12 + descriptorsLength;
    if (body.length < descriptorsLength) break;
    readDescriptors(event, body);
    result.events.push(event);
  }
  return result;
}

/**
 * 流れてくる TLV のバイト列から番組表を溜める。**読み方のほかは TS の `EpgReader` と同じ**
 * (揃ったかの数え方、別の表で来るものの混ぜ方、p/f の「いま」)。
 *
 * MH-EIT は自分の TLV のストリームの局のぶんだけが来る (実機のケーブルの BS4K で確かめた)。
 * TS の `other` (ほかの TS の局の番組表) に当たるものは無い
 */
export class MmtEpgReader extends EpgReader {
  private readonly tables = new MmtTableStream();

  /** @param now いまの時刻。過ぎた時間帯の予定を待たないのに使う (`ScheduleProgress`) */
  constructor(now: () => number = Date.now) {
    super(now);
  }

  /** 任意の長さの TLV のバイト列を渡す。番組が 1 つでも増えたら true */
  override feed(chunk: Uint8Array): boolean {
    let added = false;
    for (const { table } of this.tables.feed(chunk)) {
      const section = parseMhEit(table);
      if (section !== null && this.add(section)) added = true;
    }
    return added;
  }
}

/**
 * **1 局の「いま」と「次」(MH-EIT[p/f]) を追う。** TS の `PresentFollowing` の 4K の放送 (MMT/TLV) 版で、
 * 違うのは読み方だけ (覚え方と、変わったかの比べ方は同じ)。ライブで番組の切り替わりを知るのに使う
 */
export class MmtPresentFollowing extends PresentFollowing {
  private readonly tables = new MmtTableStream();

  /** 任意の長さの TLV のバイト列を渡す。**いまか次のどちらかが変わったら true** (最初に読めたときも true) */
  feed(chunk: Uint8Array): boolean {
    let changed = false;
    for (const { table } of this.tables.feed(chunk)) {
      // 予定 (0x8C〜) は読まずに捨てる。同じ並びに流れてくる
      if (table[0] !== MH_PF_ACTUAL || table.length < 18) continue;
      if (u16(table, 3) !== this.serviceId) continue;
      if (this.hold(parseMhEit(table))) changed = true;
    }
    return changed;
  }
}
