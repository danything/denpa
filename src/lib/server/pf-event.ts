import { type EitEvent, PresentFollowing } from "@danything/arib/eit";
import { PacketStream } from "@danything/arib/psi";

/**
 * 録り始めてから、その番組の EIT[p/f] が届くまで待つ上限。
 *
 * p/f は数秒おきに繰り返し流れる (ARIB TR-B14 では自 TS の p/f は 2 秒に 1 回以上)。届かない局で
 * 待ち続けないよう、最初の塊が届いてからこの長さで打ち切る。打ち切っても録画は続ける
 */
const PF_WAIT = 15_000;

/**
 * **録っている番組の EIT[p/f] を 1 回だけ読む** (`recorder.ts`)。
 *
 * 開始マージンのうちは前の番組が「いま」(section 0) で、録る番組は「次」(section 1) に載る。
 * どちらでも event_id が合えばそれを返す。番組表 (schedule) は数日前の内容のことがあり、
 * 局によっては話数を放送の直前の p/f にしか載せない (docs/data.md「同じ回は最初の放送だけ」)
 */
export class PfEvent {
  private readonly packets = new PacketStream();
  private readonly pf: PresentFollowing;
  /** 打ち切る時刻。最初の塊が届いたときに決める (選局に掛かった時間は数えない) */
  private deadline: number | null = null;

  /**
   * @param serviceId 放送が名乗っている service_id
   * @param eventId 録っている番組の event_id
   */
  constructor(
    serviceId: number,
    private readonly eventId: number,
    private readonly wait = PF_WAIT,
    private readonly clock: () => number = Date.now,
  ) {
    this.pf = new PresentFollowing(serviceId);
  }

  /**
   * TS の塊を 1 つ (長さは任意)。番組が届けばそれを、上限を過ぎれば `"timeout"` を、まだなら null を返す
   */
  feed(chunk: Uint8Array): EitEvent | "timeout" | null {
    this.deadline ??= this.clock() + this.wait;
    let changed = false;
    for (const packet of this.packets.feed(chunk))
      if (this.pf.feedPacket(packet)) changed = true;
    if (changed) {
      for (const event of [this.pf.present, this.pf.following])
        if (event !== null && event.eventId === this.eventId) return event;
    }
    return this.clock() >= this.deadline ? "timeout" : null;
  }
}
