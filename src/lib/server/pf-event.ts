import { type EitEvent, PresentFollowing } from "@danything/arib/eit";
import { parseMhEit } from "@danything/arib/mh-eit";
import { MmtTableStream } from "@danything/arib/mmt-si";
import { PacketStream } from "@danything/arib/psi";

import type { Transport } from "../types";

/**
 * 録り始めてから、その番組の EIT[p/f] が届くまで待つ上限。
 *
 * p/f は数秒おきに繰り返し流れる (ARIB TR-B14 では自 TS の p/f は 2 秒に 1 回以上)。届かない局で
 * 待ち続けないよう、最初の塊が届いてからこの長さで打ち切る。打ち切っても録画は続ける
 */
const PF_WAIT = 15_000;

/** p/f[actual] の table_id (TS の番号。MH-EIT も `parseMhEit` がこの番号に直す) */
const TABLE_PF_ACTUAL = 0x4e;

/**
 * **録っている番組の EIT[p/f] を 1 回だけ読む** (`recorder.ts`)。
 *
 * 開始マージンのうちは前の番組が「いま」(section 0) で、録る番組は「次」(section 1) に載る。
 * どちらでも event_id が合えばそれを返す。番組表 (schedule) は数日前の内容のことがあり、
 * 局によっては話数を放送の直前の p/f にしか載せない (docs/data.md「同じ回は最初の放送だけ」)。
 * 4K の局 (TLV) は MH-EIT[p/f] を読む (読み方は `@danything/arib/mh-eit`。ほかは同じ)
 */
export class PfEvent {
  private readonly packets = new PacketStream();
  private readonly pf: PresentFollowing;
  private readonly tables: MmtTableStream | null;
  /** 打ち切る時刻。最初の塊が届いたときに決める (選局に掛かった時間は数えない) */
  private deadline: number | null = null;

  /**
   * @param serviceId 放送が名乗っている service_id
   * @param eventId 録っている番組の event_id
   * @param transport 伝送の形式 (`services.transport`)。`tlv` なら塊は TLV のバイト列
   */
  constructor(
    private readonly serviceId: number,
    private readonly eventId: number,
    transport: Transport = "ts",
    private readonly wait = PF_WAIT,
    private readonly clock: () => number = Date.now,
  ) {
    this.pf = new PresentFollowing(serviceId);
    this.tables = transport === "tlv" ? new MmtTableStream() : null;
  }

  /**
   * 塊を 1 つ (長さは任意)。番組が届けばそれを、上限を過ぎれば `"timeout"` を、まだなら null を返す
   */
  feed(chunk: Uint8Array): EitEvent | "timeout" | null {
    this.deadline ??= this.clock() + this.wait;
    const found =
      this.tables === null ? this.fromTs(chunk) : this.fromTlv(chunk);
    if (found !== null) return found;
    return this.clock() >= this.deadline ? "timeout" : null;
  }

  private fromTs(chunk: Uint8Array): EitEvent | null {
    let changed = false;
    for (const packet of this.packets.feed(chunk))
      if (this.pf.feedPacket(packet)) changed = true;
    if (!changed) return null;
    for (const event of [this.pf.present, this.pf.following])
      if (event !== null && event.eventId === this.eventId) return event;
    return null;
  }

  /** MH-EIT[p/f] (`MmtTableStream` が信号から取り出した表) から、その局の「いま」と「次」を探す */
  private fromTlv(chunk: Uint8Array): EitEvent | null {
    for (const { table } of this.tables!.feed(chunk)) {
      const section = parseMhEit(table);
      if (
        section === null ||
        section.tableId !== TABLE_PF_ACTUAL ||
        section.serviceId !== this.serviceId ||
        section.sectionNumber > 1
      )
        continue;
      const event = section.events.find((e) => e.eventId === this.eventId);
      if (event !== undefined) return event;
    }
    return null;
  }
}
