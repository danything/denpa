import {
  type EmmMessage,
  EmmReceiver,
  PacketStream,
} from "@danything/arib/psi";
import { eq } from "drizzle-orm";

import { agentFetch } from "./agent-client";
import { getActiveCardId } from "./contracts";
import { orm } from "./db";
import { services } from "./schema";
import { cardStatus } from "./scramble";
import { openChannelStream } from "./tuner";

/**
 * B-CAS カードの EMM (個別/共通管理情報) 自動受信・更新パイプライン。
 *
 * 放送波の TS パケットから CAT (PID 0x0001) と EMM を受信し、
 * カード宛てのメッセージをエージェント経由で B-CAS カード (0x90 0x36) に投入して
 * 期限切れの解消や有料放送の契約更新を行う。
 */

export interface EmmResult {
  ok: boolean;
  code: number;
  error?: string | undefined;
}

export interface EmmStreamStats {
  processed: number;
  success: number;
  errors: number;
  /** CAT から見つけた B-CAS の EMM PID (空なら CAT を受け取れていない) */
  emmPids: number[];
}

export interface EmmPipelineResult extends EmmStreamStats {
  cardId: string | null;
  channel?: string | undefined;
}

/** EMM 更新コマンドが正常終了したかを判定する (0x2100: 正常完了) */
export function isEmmSuccess(code: number): boolean {
  return code === 0x2100;
}

/**
 * B-CAS カードの EMM 更新コマンド (0x90 0x36) をエージェント経由で実行する。
 */
export async function sendCardEmm(
  payload: Uint8Array,
  timeoutMs = 5_000,
): Promise<EmmResult> {
  try {
    const base64 = Buffer.from(payload).toString("base64");
    const res = await agentFetch("/denpa/card/emm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emm: base64 }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return {
        ok: false,
        code: 0,
        error: `エージェント応答エラー (${res.status}): ${err}`,
      };
    }

    const data = (await res.json()) as {
      ok?: boolean;
      code?: number;
      error?: string;
    };
    return {
      ok: data.ok === true,
      code: typeof data.code === "number" ? data.code : 0,
      error: data.error,
    };
  } catch (error) {
    return { ok: false, code: 0, error: String(error) };
  }
}

/**
 * TS パケットのバイト列ストリームから CAT/EMM を監視し、
 * 対象の B-CAS カード宛ての EMM メッセージをカードへ送信・更新する。
 */
export async function processEmmStream(
  stream: ReadableStream<Uint8Array>,
  targetCardId?: bigint | string | undefined,
  signal?: AbortSignal | undefined,
  onMessage?: (msg: EmmMessage, result: EmmResult) => void | Promise<void>,
): Promise<EmmStreamStats> {
  const receiver = new EmmReceiver({ targetCardId });
  const packets = new PacketStream();
  const reader = stream.getReader();

  let processed = 0;
  let success = 0;
  let errors = 0;

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done || !value) break;

      for (const packet of packets.feed(value)) {
        const msgs = receiver.feed(packet);
        for (const msg of msgs) {
          processed++;
          const result = await sendCardEmm(msg.payload);
          if (result.ok && isEmmSuccess(result.code)) {
            success++;
          } else {
            errors++;
          }
          if (onMessage) {
            await onMessage(msg, result);
          }
        }
      }
    }
  } catch (error) {
    // 受信の時間切れ (signal) で止めたときの中断は、失敗ではなく正常な終わり方
    if (!signal?.aborted) throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 読み取り中に中断されたときは解放できないことがある
    }
  }

  return { processed, success, errors, emmPids: [...receiver.pids] };
}

/**
 * チューナーを開いて一定時間 EMM を受信し、カードを自動更新する。
 *
 * @param options.channel 受信するチャンネル (例: "BS15_0", "101")
 * @param options.type チューナー種別 ("BS", "GR" 等、デフォルト "BS")
 * @param options.seconds 受信継続秒数 (デフォルト 20 秒)
 * @param options.targetCardId 対象のカード番号 (省略時はアクティブなカード)
 */
export async function receiveEmm(
  options: {
    channel?: string | undefined;
    type?: string | undefined;
    seconds?: number | undefined;
    targetCardId?: bigint | string | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<EmmPipelineResult> {
  const card = await cardStatus();
  const activeId = getActiveCardId(card);
  const targetId = options.targetCardId ?? activeId;

  if (!card.ok || !targetId) {
    throw new Error(
      card.message || "B-CAS カードが認識されていないため EMM を受信できません",
    );
  }

  let channel = options.channel;
  if (!channel) {
    const bsService = orm()
      .select({ channel: services.channel })
      .from(services)
      .where(eq(services.type, "BS"))
      .limit(1)
      .get();
    channel = bsService?.channel ?? "BS15:16625";
  }
  const type = options.type ?? "BS";
  const seconds = options.seconds ?? 20;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), seconds * 1000);

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      abortController.abort();
    });
  }

  let stream: ReadableStream<Uint8Array> | null = null;
  try {
    stream = await openChannelStream(
      type,
      channel,
      abortController.signal,
      "live emm-pipeline",
      1, // 優先度
    );

    const stats = await processEmmStream(
      stream,
      targetId,
      abortController.signal,
    );
    return {
      ...stats,
      cardId: typeof targetId === "string" ? targetId : targetId.toString(10),
      channel,
    };
  } catch (error) {
    // 選局に手間取って時間切れになったときは、何も受け取れなかったものとして返す
    if (options.signal?.aborted || !abortController.signal.aborted) throw error;
    return {
      processed: 0,
      success: 0,
      errors: 0,
      emmPids: [],
      cardId: typeof targetId === "string" ? targetId : targetId.toString(10),
      channel,
    };
  } finally {
    clearTimeout(timeoutId);
    if (stream) {
      try {
        await stream.cancel();
      } catch {
        // すでに閉じている場合は無視
      }
    }
  }
}
