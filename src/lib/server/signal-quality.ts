import { config } from "./config";
import { openChannelStream } from "./tuner";

export interface SignalQualityMetrics {
  durationMs: number;
  totalPackets: number;
  errorPackets: number;
  dropPackets: number;
  errorRate: number;
  dropRate: number;
  bitrateMbps: number;
  effectiveBitrateMbps: number;
  /** C/N 比 (dB)。パケット整合性・変調方式からの推定値 */
  cnDb: number | null;
  quality: "excellent" | "good" | "poor" | "bad" | "none";
  qualityLabel: string;
}

export interface SignalQualityResult extends SignalQualityMetrics {
  ok: boolean;
  channel: string;
  type: string;
  error?: string | undefined;
}

/**
 * TS ストリームのパケットを検査して受信品質（エラー、ドロップ、ビットレート）を算出するクラス。
 */
export class TsQualityAnalyzer {
  private totalPackets = 0;
  private errorPackets = 0;
  private dropPackets = 0;
  private nullPackets = 0;
  private lastCcByPid = new Map<number, number>();
  private remainder: Uint8Array | null = null;

  /** チャンクを受け取って TS パケット（188バイト）ごとに解析 */
  feed(chunk: Uint8Array): void {
    let buf: Uint8Array;
    if (this.remainder !== null && this.remainder.length > 0) {
      buf = new Uint8Array(this.remainder.length + chunk.length);
      buf.set(this.remainder, 0);
      buf.set(chunk, this.remainder.length);
      this.remainder = null;
    } else {
      buf = chunk;
    }

    let offset = 0;
    const len = buf.length;

    while (offset + 188 <= len) {
      // TS 同期バイト (0x47) の探索
      if (buf[offset] !== 0x47) {
        let syncIndex = offset + 1;
        while (syncIndex < len && buf[syncIndex] !== 0x47) {
          syncIndex++;
        }
        if (syncIndex >= len) {
          // 残りは同期バイトの手前まで破棄して待機
          break;
        }
        offset = syncIndex;
        if (offset + 188 > len) break;
      }

      this.analyzePacket(buf, offset);
      offset += 188;
    }

    if (offset < len) {
      this.remainder = buf.slice(offset);
    }
  }

  private analyzePacket(buf: Uint8Array, offset: number): void {
    this.totalPackets++;

    // Transport Error Indicator (TEI): 第2バイトの先頭ビット
    const b1 = buf[offset + 1]!;
    const tei = (b1 & 0x80) !== 0;
    if (tei) {
      this.errorPackets++;
    }

    // PID: 13ビット
    const b2 = buf[offset + 2]!;
    const pid = ((b1 & 0x1f) << 8) | b2;

    if (pid === 0x1fff) {
      this.nullPackets++;
      return;
    }

    // Continuity Counter (CC): 第4バイトの下位4ビット
    const b3 = buf[offset + 3]!;
    const adaptationFieldControl = (b3 >> 4) & 0x03;
    const cc = b3 & 0x0f;

    // ペイロードが存在するパケット (0x01 または 0x03) で CC を検証
    const hasPayload = (adaptationFieldControl & 0x01) !== 0;
    if (hasPayload) {
      const prevCc = this.lastCcByPid.get(pid);
      if (prevCc !== undefined) {
        const expectedCc = (prevCc + 1) & 0x0f;
        if (cc !== expectedCc && cc !== prevCc) {
          // パケットドロップを検知
          const lost = (cc - expectedCc + 16) & 0x0f;
          this.dropPackets += lost;
        }
      }
      this.lastCcByPid.set(pid, cc);
    }
  }

  /** 計測時間からメトリクスを算出 */
  metrics(durationMs: number, type = "GR"): SignalQualityMetrics {
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
    let qualityLabel = "受信良好";
    let cnDb: number | null = null;

    const isSat = type === "BS" || type === "CS";

    if (total < 50) {
      quality = "none";
      qualityLabel = "電波なし / 受信不可";
      cnDb = null;
    } else if (dropRate > 0.05 || errorRate > 0.05) {
      quality = "bad";
      qualityLabel = "電波状態不良 (乱れ大)";
      cnDb = isSat ? 8.5 : 17.0;
    } else if (dropRate > 0.01 || errorRate > 0.01) {
      quality = "poor";
      qualityLabel = "注意 (ドロップ・誤りあり)";
      cnDb = isSat ? 10.5 : 19.5;
    } else if (dropRate > 0 || errorRate > 0) {
      quality = "poor";
      qualityLabel = "注意 (わずかにドロップあり)";
      cnDb = isSat ? 12.0 : 21.0;
    } else {
      quality = "excellent";
      qualityLabel = "受信良好 (ドロップなし)";
      cnDb = isSat ? 16.5 : 28.5;
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
      cnDb,
      quality,
      qualityLabel,
    };
  }
}

/**
 * 指定のチャンネルを選局し、短時間 (約2〜3秒) TS パケットを読み込んで電波受信品質を測定する。
 */
export async function measureChannelSignal(
  type: string,
  channel: string,
  measureMs = 2500,
): Promise<SignalQualityResult> {
  const abortController = new AbortController();
  const analyzer = new TsQualityAnalyzer();
  const startTime = Date.now();

  const timeout = setTimeout(() => {
    abortController.abort();
  }, measureMs + 1000);

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await openChannelStream(
      type,
      channel,
      abortController.signal,
      `scan quality ${channel}`,
      config.priority.epg,
    );
  } catch (err) {
    clearTimeout(timeout);
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
      cnDb: null,
      quality: "none",
      qualityLabel: "チューナー確保失敗",
      error: `選局に失敗しました: ${msg}`,
    };
  }

  const reader = stream.getReader();
  try {
    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= measureMs) {
        break;
      }
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      analyzer.feed(value);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.warn(`[signal-quality] 読み込み中にエラー: ${err}`);
    }
  } finally {
    clearTimeout(timeout);
    try {
      await reader.cancel();
    } catch {
      // 無視
    }
    abortController.abort();
  }

  const durationMs = Date.now() - startTime;
  const metrics = analyzer.metrics(durationMs, type);

  return {
    ok: metrics.quality !== "none",
    channel,
    type,
    ...metrics,
    cnDb: metrics.cnDb,
  };
}
