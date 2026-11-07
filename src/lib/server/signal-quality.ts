import { PACKET, packetPid, PacketStream } from "@danything/arib/psi";

import type { ChannelType } from "../types";
import { config } from "./config";
import { chunks } from "./stream";
import {
  getTuners,
  openChannelStream,
  type StreamUse,
  type TunerSignal,
} from "./tuner";

/**
 * 測る長さ (ms)。最初のパケットが届いてから数える (選局にかかる時間を速さに入れない)。
 * エージェントが C/N を読む間隔 (5 秒) と同じにして、終わるまでに 1 回は読まれるようにする
 */
const MEASURE = 5_000;
/** パケットが届かないときに諦めるまで (ms)。選局で同期を待つ 5 秒と、測る長さを足したぶんより長く */
const GIVE_UP = 15_000;

/** 受信品質の測定結果 */
export interface SignalQuality {
  /** 受け取ったパケットの数 */
  packets: number;
  /** 誤りの印 (transport_error_indicator) が立っていたパケットの数 */
  errors: number;
  /** 連続性カウンタの飛びから数えた、欠けたパケットの数 */
  drops: number;
  /** 受け取った速さ (Mbps) */
  mbps: number;
  /** 測っている間のチューナーの受信の状態と C/N。機材が測れなければ null (docs/tuners.md「信号レベル」) */
  signal: TunerSignal | null;
}

/** TS のパケットを数え、誤りと欠けを数える */
export class PacketCheck {
  packets = 0;
  errors = 0;
  drops = 0;
  private readonly stream = new PacketStream();
  /** PID ごとの、前のパケットの連続性カウンタ */
  private readonly last = new Map<number, number>();

  feed(chunk: Uint8Array): void {
    for (const packet of this.stream.feed(chunk)) {
      this.packets++;
      const pid = packetPid(packet);
      // 誤りのあるパケットは PID もカウンタも当てにならない。その PID は次のパケットから数え直す
      if ((packet[1]! & 0x80) !== 0) {
        this.errors++;
        this.last.delete(pid);
        continue;
      }
      // NULL パケットのカウンタは意味を持たない
      if (pid === 0x1fff) continue;
      const control = packet[3]! >> 4;
      // ペイロードの無いパケットはカウンタを進めない
      if ((control & 0x1) === 0) continue;
      const cc = packet[3]! & 0x0f;
      // discontinuity_indicator が立っていれば、カウンタは飛んでよい
      const reset =
        (control & 0x2) !== 0 && packet[4]! > 0 && (packet[5]! & 0x80) !== 0;
      const prev = reset ? undefined : this.last.get(pid);
      // 同じ値は 2 度送り (規格で 1 回まで許されている)
      if (prev !== undefined && cc !== prev)
        this.drops += (cc - prev - 1) & 0x0f;
      this.last.set(pid, cc);
    }
  }
}

/**
 * チャンネルを選局し、受けた TS の誤り・欠け・速さと、チューナーの C/N を測る。
 *
 * **スキャンと同じ順でチューナーを取る** (録画・ライブ視聴・番組表をいますぐ集める処理からは取り上げない。
 * 名乗りの先頭が `scan` なので、エージェントはカードに聞かずに流す)。
 * 選局できなければ `openChannelStream` の失敗をそのまま投げる。届いたパケットが無ければ `packets` が 0
 */
export async function measureSignal(
  type: ChannelType,
  channel: string,
  signal: AbortSignal,
): Promise<SignalQuality> {
  const use: StreamUse = `scan quality ${channel}`;
  const done = new AbortController();
  const stop = AbortSignal.any([
    signal,
    done.signal,
    AbortSignal.timeout(GIVE_UP),
  ]);
  const check = new PacketCheck();
  let started = 0;
  let ms = 0;
  try {
    const stream = await openChannelStream(
      type,
      channel,
      stop,
      use,
      config.priority.scan,
    );
    // C/N はチューナーを持っている間に読む (エージェントは使用中のチューナーの値だけを返す)。届かなくても読む
    const tuned = Bun.sleep(MEASURE)
      .then(getTuners)
      .then(
        (tuners) =>
          tuners.find((tuner) => tuner.users.some((user) => user.use === use))
            ?.signal ?? null,
        () => null,
      );
    try {
      for await (const chunk of chunks(stream)) {
        started ||= Date.now();
        check.feed(chunk);
        ms = Date.now() - started;
        if (ms >= MEASURE) break;
      }
    } catch (error) {
      // 時間切れと、画面を閉じたとき。読めたぶんで返す
      if (!stop.aborted) throw error;
    }
    const { packets, errors, drops } = check;
    return {
      packets,
      errors,
      drops,
      mbps: ms > 0 ? (packets * PACKET * 8) / ms / 1000 : 0,
      signal: await tuned,
    };
  } finally {
    done.abort();
  }
}
