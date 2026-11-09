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
/**
 * エージェントが C/N を読む間隔 (ms。agent の `TunerSignal.Every`) に、読み終わるまでの 1 秒を足したもの。
 * エージェントは選局と関係ない時刻に 5 秒ごとに読むので、選局からこれだけ待てば 1 回は読まれている
 */
const SIGNAL_READ = 5_000 + 1_000;
/** C/N を 1 回読むのを待つ上限 (ms)。エージェントは覚えている値を返すだけなので、ふだんはすぐ返る */
const READ_LIMIT = 2_000;
/** パケットが届かないときに諦めるまで (ms)。選局で同期を待つ 5 秒と、測る長さを足したぶんより長く */
const GIVE_UP = 15_000;

/**
 * 名乗りが `use` の利用者がいるチューナーの受信の状態と C/N。読めなければ null。
 * `stop` が立つか `READ_LIMIT` を過ぎたら待たずに null を返す (エージェントが遅くても、チューナーを放すのを遅らせない)
 */
async function readSignal(
  use: StreamUse,
  stop: AbortSignal,
): Promise<TunerSignal | null> {
  if (stop.aborted) return null;
  const limit = AbortSignal.any([stop, AbortSignal.timeout(READ_LIMIT)]);
  const gaveUp = new Promise<null>((resolve) =>
    limit.addEventListener("abort", () => resolve(null), { once: true }),
  );
  try {
    const tuners = await Promise.race([getTuners(), gaveUp]);
    return (
      tuners?.find((tuner) => tuner.users.some((user) => user.use === use))
        ?.signal ?? null
    );
  } catch {
    return null;
  }
}

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
 * **スキャンと同じ順でチューナーを取る** (録画・ライブ視聴・番組表をいますぐ集める処理・スキャンからは取り上げない。
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
  let tuned: Promise<TunerSignal | null> = Promise.resolve(null);
  /** 測り終えたか。測り終える前にストリームが終わったら、読む間隔を待たずに返す */
  let measured = false;
  /** 読む間隔が過ぎて読めた値 (ストリームが先に終わったときに使う) */
  let early: TunerSignal | null = null;
  try {
    const stream = await openChannelStream(
      type,
      channel,
      stop,
      use,
      config.priority.scan,
    );
    /*
     * C/N はチューナーを持っている間に読む (エージェントは使用中のチューナーの値だけを返す)。
     * パケットが届かずに測り終わらないときのために、読む間隔が過ぎたら一度読んでおく
     */
    tuned = Bun.sleep(SIGNAL_READ)
      .then(() => readSignal(use, stop))
      .then((value) => (early = value));
    for await (const chunk of chunks(stream)) {
      started ||= Date.now();
      check.feed(chunk);
      ms = Date.now() - started;
      if (ms >= MEASURE) {
        /*
         * 測り終えたら、ループを抜けてチューナーを放す前に読む。抜けるとストリームが閉じ、
         * エージェントはそのチューナーの C/N を返さなくなる。最初のパケットから MEASURE 経っているので、
         * 選局からは読む間隔より長い。ここで読んだ値を使い、パケットが届かないときの読みは待たない
         * (まだ走っていなければ、チューナーを放したあとに走って null になるだけ)
         */
        tuned = readSignal(use, stop);
        await tuned;
        measured = true;
        break;
      }
    }
  } catch (error) {
    // 時間切れと、画面を閉じたとき。読めたぶんで返す
    if (!stop.aborted) throw error;
  }
  try {
    const { packets, errors, drops } = check;
    return {
      packets,
      errors,
      drops,
      mbps: ms > 0 ? (packets * PACKET * 8) / ms / 1000 : 0,
      // 画面を閉じたなら、読み終わるのを待たない。測り終える前にストリームが終わったなら、チューナーはもう放しているので
      // 読む間隔 (SIGNAL_READ) を待っても値は返らない。それまでに読めた値を使う
      signal: signal.aborted ? null : measured ? await tuned : early,
    };
  } finally {
    done.abort();
  }
}
