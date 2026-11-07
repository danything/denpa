import { PacketStream } from "@danything/arib/psi";

import { config } from "./config";
import type { TunerSignal } from "./tuner";
import { getTuners, openChannelStream } from "./tuner";

export interface SignalQualityMetrics {
  durationMs: number;
  totalPackets: number;
  errorPackets: number;
  dropPackets: number;
  errorRate: number;
  dropRate: number;
  bitrateMbps: number;
  effectiveBitrateMbps: number;
  quality: "excellent" | "good" | "poor" | "bad" | "none";
  qualityLabel: string;
}

export interface SignalQualityResult extends SignalQualityMetrics {
  ok: boolean;
  channel: string;
  type: string;
  error?: string | undefined;
  /** チューナーから得られた受信状態と C/N (上流 #2281。機材が返せる場合) */
  tunerSignal?: TunerSignal | null | undefined;
}

/**
 * TS ストリームのパケットを検査して受信品質（エラー、ドロップ、ビットレート）を算出するクラス。
 * パケット境界の同期と切り出しには `@danything/arib/psi` の PacketStream を利用する。
 */
export class TsQualityAnalyzer {
  private readonly stream = new PacketStream();
  private totalPackets = 0;
  private errorPackets = 0;
  private dropPackets = 0;
  private nullPackets = 0;
  private readonly lastCcByPid = new Map<number, number>();

  /** チャンクを受け取って TS パケット（188 バイト）ごとに解析 */
  feed(chunk: Uint8Array): void {
    for (const packet of this.stream.feed(chunk)) {
      this.analyzePacket(packet);
    }
  }

  private analyzePacket(packet: Uint8Array): void {
    this.totalPackets++;

    // Transport Error Indicator (TEI): 第 2 バイトの最上位ビット
    const b1 = packet[1]!;
    const tei = (b1 & 0x80) !== 0;
    if (tei) {
      this.errorPackets++;
      // TEI パケットは PID や CC がビット化けしているため、連続性追跡をリセット
      const b2 = packet[2]!;
      const pid = ((b1 & 0x1f) << 8) | b2;
      this.lastCcByPid.delete(pid);
      return;
    }

    // PID: 13 ビット
    const b2 = packet[2]!;
    const pid = ((b1 & 0x1f) << 8) | b2;

    if (pid === 0x1fff) {
      this.nullPackets++;
      return;
    }

    // adaptation_field_control (bit 5-4) と continuity_counter (bit 3-0)
    const b3 = packet[3]!;
    const adaptationFieldControl = (b3 >> 4) & 0x03;
    const cc = b3 & 0x0f;

    // アダプテーションフィールド内の discontinuity_indicator を確認
    let discontinuity = false;
    const hasAdaptation = (adaptationFieldControl & 0x02) !== 0;
    if (hasAdaptation) {
      const afLen = packet[4] ?? 0;
      if (afLen > 0 && packet.length >= 6) {
        // 第 6 バイトの最上位ビットが discontinuity_indicator
        discontinuity = (packet[5]! & 0x80) !== 0;
      }
    }

    if (discontinuity) {
      // AF のみのパケットを含め、discontinuity_indicator が立った場合は連続性をリセット
      this.lastCcByPid.delete(pid);
      return;
    }

    // ペイロードが存在するパケット (0x01 または 0x03) で CC を検証
    const hasPayload = (adaptationFieldControl & 0x01) !== 0;
    if (hasPayload) {
      const prevCc = this.lastCcByPid.get(pid);
      if (prevCc !== undefined) {
        const expectedCc = (prevCc + 1) & 0x0f;
        if (cc !== expectedCc && cc !== prevCc) {
          // 不連続をパケットドロップとして検知
          const lost = (cc - expectedCc + 16) & 0x0f;
          this.dropPackets += lost;
        }
      }
      this.lastCcByPid.set(pid, cc);
    }
  }

  /** 計測時間 (ms) からメトリクスを算出 */
  metrics(durationMs: number): SignalQualityMetrics {
    const total = this.totalPackets;
    const errors = this.errorPackets;
    const drops = this.dropPackets;
    const nulls = this.nullPackets;
    const seconds = Math.max(0.1, durationMs / 1000);

    const totalBits = total * 188 * 8;
    const effectiveBits = (total - nulls) * 188 * 8;

    const bitrateMbps = Number((totalBits / seconds / 1_000_000).toFixed(2));
    const effectiveBitrateMbps = Number(
      (effectiveBits / seconds / 1_000_000).toFixed(2),
    );

    const errorRate = total > 0 ? Number((errors / total).toFixed(4)) : 0;
    const dropRate =
      total + drops > 0 ? Number((drops / (total + drops)).toFixed(4)) : 0;

    let quality: SignalQualityMetrics["quality"] = "excellent";
    let qualityLabel = "受信良好 (ドロップなし)";

    if (total < 50) {
      quality = "none";
      qualityLabel = "電波なし・受信不可";
    } else if (dropRate > 0.05 || errorRate > 0.05) {
      quality = "bad";
      qualityLabel = "電波状態不良 (乱れ大)";
    } else if (dropRate > 0.005 || errorRate > 0.005) {
      quality = "poor";
      qualityLabel = "注意 (ドロップ・誤りあり)";
    } else if (dropRate > 0 || errorRate > 0) {
      quality = "good";
      qualityLabel = "良好 (ごく軽微なドロップあり)";
    } else {
      quality = "excellent";
      qualityLabel = "受信良好 (ドロップなし)";
    }

    return {
      durationMs,
      totalPackets: total,
      errorPackets: errors,
      dropPackets: drops,
      errorRate,
      dropRate,
      bitrateMbps,
      effectiveBitrateMbps,
      quality,
      qualityLabel,
    };
  }
}

/**
 * 指定のチャンネルを選局し、TS パケットの受信品質（誤り率・ドロップ数・ビットレート）を測定する。
 * 最初のパケットが届いた時点から実効測定を開始し、選局待機時間がビットレート算出を歪めないようにする。
 * 全体上限タイマー (8 秒) により無受信時のハングを防止する。
 */
export async function measureChannelSignal(
  type: string,
  channel: string,
  measureMs = 2500,
  signal?: AbortSignal,
): Promise<SignalQualityResult> {
  const abortController = new AbortController();

  // 外部からの AbortSignal (ユーザーの画面離脱・閉じる操作) と連動
  const onParentAbort = () => abortController.abort();
  if (signal?.aborted) {
    abortController.abort();
  } else if (signal) {
    signal.addEventListener("abort", onParentAbort, { once: true });
  }

  // 選局および無受信時のハングを防ぐ全体タイムアウト (8 秒)
  const totalTimeout = setTimeout(() => {
    abortController.abort();
  }, 8_000);

  let stream: ReadableStream<Uint8Array>;
  try {
    // ユーザー操作の測定のためインタラクティブ優先度 (epgNow: 8) で開く
    stream = await openChannelStream(
      type,
      channel,
      abortController.signal,
      `scan quality ${channel}`,
      config.priority.epgNow,
    );
  } catch (err) {
    clearTimeout(totalTimeout);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      channel,
      type,
      durationMs: 0,
      totalPackets: 0,
      errorPackets: 0,
      dropPackets: 0,
      errorRate: 0,
      dropRate: 0,
      bitrateMbps: 0,
      effectiveBitrateMbps: 0,
      quality: "none",
      qualityLabel: "チューナー確保失敗",
      error: `選局に失敗しました: ${msg}`,
    };
  }

  const reader = stream.getReader();
  const analyzer = new TsQualityAnalyzer();
  let startTime = 0;
  let durationMs = 0;
  let tunerSignal: TunerSignal | null = null;
  let fetchTunerSignal: Promise<void> | null = null;

  // abort 時に保留中の reader.read() を即座に解放
  const abortReader = () => {
    void reader.cancel().catch(() => {});
  };
  abortController.signal.addEventListener("abort", abortReader, { once: true });

  try {
    while (!abortController.signal.aborted) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }

      // 最初のパケットが到着した瞬間を測定時間の起点にする
      if (startTime === 0) {
        startTime = Date.now();
        // パケット受信開始後、チューナーエージェントから C/N・同期状態を取得 (上流 #2281)
        fetchTunerSignal = getTuners()
          .then((tuners) => {
            const matched = tuners.find(
              (t) => t.channel?.type === type && t.channel?.channel === channel,
            );
            if (matched?.signal) {
              tunerSignal = matched.signal;
            }
          })
          .catch(() => {});
      }

      analyzer.feed(value);

      const elapsed = Date.now() - startTime;
      if (elapsed >= measureMs) {
        durationMs = elapsed;
        break;
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.warn(`[signal-quality] 読み込み中にエラー: ${err}`);
    }
  } finally {
    clearTimeout(totalTimeout);
    abortController.signal.removeEventListener("abort", abortReader);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    try {
      await reader.cancel();
    } catch {
      // 無視
    }
    abortController.abort();
  }

  if (fetchTunerSignal !== null) {
    try {
      await Promise.race([
        fetchTunerSignal,
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    } catch {
      // 無視
    }
  }

  if (startTime > 0 && durationMs === 0) {
    durationMs = Math.max(1, Date.now() - startTime);
  }

  const metrics = analyzer.metrics(durationMs);

  return {
    ok: metrics.quality !== "none",
    channel,
    type,
    tunerSignal,
    ...metrics,
  };
}
