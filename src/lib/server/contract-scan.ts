import { PACKET, SYNC } from "@danything/arib/psi";
import { ServiceFilter } from "@danything/arib/service-filter";
/**
 * 深夜などの指定時間帯に、チューナーの空きを見計らって契約状態・復号可否を巡回確認する定期スキャナー。
 *
 * 録画や視聴を邪魔しないよう、優先度を最下位 (1) で開き、
 * 録画開始や他のチューナー要求が発生した場合は即座に中断して空き次第再開する。
 */
import { and, asc, eq } from "drizzle-orm";

import type { ChannelType } from "../types";
import {
  freshDecode,
  getActiveCardId,
  getContractSettings,
  isCodeSubscribed,
} from "./contracts";
import { orm } from "./db";
import { activeRecordingIds } from "./recorder";
import { cardContracts, services } from "./schema";
import { cardStatus } from "./scramble";
import { store, stored } from "./settings";
import { getTuners, openChannelStream } from "./tuner";

export interface ScanState {
  /** 現在スキャン中か */
  running: boolean;
  /** 前回完了した日付 (YYYY-MM-DD JST) */
  lastCompletedDate: string | null;
  /** 残り対象チャンネル数 */
  remainingChannels: number;
}

let inFlight = false;
let currentQueue: { channel: string; type: string; serviceIds: number[] }[] =
  [];
let queueDate: string | null = null;

/**
 * 現在時刻 (JST) が start 〜 end の時間枠内にあるか
 */
export function isWithinScanWindow(
  nowMs: number,
  startStr: string,
  endStr: string,
): boolean {
  const jstDate = new Date(nowMs + 9 * 3600_000);
  const currentMinutes = jstDate.getUTCHours() * 60 + jstDate.getUTCMinutes();

  const [sh, sm] = startStr.split(":").map(Number);
  const [eh, em] = endStr.split(":").map(Number);
  if (
    sh === undefined ||
    sm === undefined ||
    eh === undefined ||
    em === undefined ||
    Number.isNaN(sh) ||
    Number.isNaN(sm) ||
    Number.isNaN(eh) ||
    Number.isNaN(em)
  ) {
    return false;
  }
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // 日をまたぐ場合 (例: 23:00 〜 04:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * 今日の日付 (YYYY-MM-DD JST) を取得する
 */
export function getJstDateString(nowMs: number): string {
  const d = new Date(nowMs + 9 * 3600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * チューナーが空いているか (録画中ではなく、BS/CS を受信できる空きがあるか)
 */
export async function isTunerAvailableForScan(): Promise<boolean> {
  // 1. 録画中なら絶対に邪魔しない
  if (activeRecordingIds().length > 0) {
    return false;
  }

  // 2. エージェントのチューナー一覧で、BS または CS を扱えるチューナーに空きがあるか
  try {
    const tuners = await getTuners();
    const satTuners = tuners.filter(
      (t) => !t.disabled && (t.types.includes("BS") || t.types.includes("CS")),
    );
    if (satTuners.length === 0) return false;

    // 録画 (>=10) やライブ (>=9) の利用者がいるチューナーは避ける
    const freeTuners = satTuners.filter(
      (t) => t.users.length === 0 || t.users.every((u) => u.priority < 9),
    );
    return freeTuners.length > 0;
  } catch {
    return false;
  }
}

/**
 * 定期スキャンの対象キューを構築する
 */
export function buildScanQueue(
  cardId: string,
  intendedServiceIds: number[] | null,
  nowMs = Date.now(),
): { channel: string; type: string; serviceIds: number[] }[] {
  const rows = orm()
    .select({
      serviceId: services.id,
      channel: services.channel,
      type: services.type,
      code: cardContracts.code,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(eq(cardContracts.card_id, cardId))
    .orderBy(
      asc(services.type),
      asc(services.channel),
      asc(services.service_id),
    )
    .all();

  const intendedSet =
    intendedServiceIds !== null ? new Set(intendedServiceIds) : null;

  // チャンネル (中継器) ごとにグルーピング
  const groupMap = new Map<
    string,
    { channel: string; type: string; serviceIds: number[] }
  >();

  for (const row of rows) {
    // 契約意志リストがある場合、対象外ならスキップ
    if (intendedSet && !intendedSet.has(row.serviceId)) continue;

    // カード契約済み (code あり) かつ有効期限内、あるいは直近で復号成功済みならスキップ
    if (row.code !== null && isCodeSubscribed(row.code)) continue;
    if (row.decodeOk === true && freshDecode(row.decodedAt, nowMs)) continue;

    const key = `${row.type}\u0000${row.channel}`;
    let entry = groupMap.get(key);
    if (!entry) {
      entry = { channel: row.channel, type: row.type, serviceIds: [] };
      groupMap.set(key, entry);
    }
    entry.serviceIds.push(row.serviceId);
  }

  return Array.from(groupMap.values());
}

/**
 * 1 つの中継器 (チャンネル) の復号テストを実施する
 */
async function scanSingleChannel(
  channelInfo: { channel: string; type: string; serviceIds: number[] },
  cardId: string,
  nowMs: number,
): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);

  const channelServices = orm()
    .select({
      id: services.id,
      arib: services.service_id,
    })
    .from(services)
    .where(
      and(
        eq(services.channel, channelInfo.channel),
        eq(services.type, channelInfo.type as ChannelType),
      ),
    )
    .all()
    .filter((s) => channelInfo.serviceIds.includes(s.id));

  const filters = channelServices.map((s) => ({
    serviceId: s.id,
    filter: new ServiceFilter(s.arib),
    total: 0,
    scrambled: 0,
  }));

  try {
    // 優先度 1 (最下位) で開くことで、録画・視聴が入れば即時譲り合う
    const stream = await openChannelStream(
      channelInfo.type,
      channelInfo.channel,
      abortController.signal,
      "live contract-scan",
      1,
    );
    const reader = stream.getReader();
    try {
      while (filters.some((f) => f.total < 1500)) {
        // 途中で録画が始まったら即座に中断
        if (activeRecordingIds().length > 0) {
          abortController.abort();
          break;
        }

        const next = await reader.read().catch(() => ({
          done: true,
          value: undefined,
        }));
        if (next.done || !next.value) break;

        for (const f of filters) {
          if (f.total >= 1500) continue;
          const own = f.filter.filter(next.value);
          for (
            let offset = 0;
            offset + PACKET <= own.length;
            offset += PACKET
          ) {
            if (own[offset] !== SYNC) continue;
            // ペイロードの無いパケットはスクランブルの対象外
            if ((own[offset + 3]! & 0x10) === 0) continue;
            f.total++;
            // 4 バイト目の上位 2 ビットが transport_scrambling_control
            if ((own[offset + 3]! & 0xc0) !== 0) f.scrambled++;
          }
        }
      }
    } finally {
      reader.releaseLock();
      await stream.cancel().catch(() => {});
    }

    // 結果を DB に反映
    for (const f of filters) {
      if (f.total >= 50) {
        const decodeOk = f.scrambled === 0;
        orm()
          .update(cardContracts)
          .set({
            decode_ok: decodeOk,
            decoded_at: decodeOk ? nowMs : null,
            state: decodeOk ? "subscribed" : "unsubscribed",
            source: "decode",
            checked_at: nowMs,
          })
          .where(
            and(
              eq(cardContracts.card_id, cardId),
              eq(cardContracts.service_id, f.serviceId),
            ),
          )
          .run();
      }
    }
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }
}

/**
 * 定期スキャンの 1 ステップ (タイマーループから毎分呼ばれる)
 */
export async function tickPeriodicContractScan(
  nowMs = Date.now(),
): Promise<void> {
  const settings = getContractSettings();
  if (!settings.periodicScanEnabled) {
    currentQueue = [];
    return;
  }

  // 時間枠内かどうか
  if (
    !isWithinScanWindow(
      nowMs,
      settings.periodicScanStart,
      settings.periodicScanEnd,
    )
  ) {
    currentQueue = [];
    return;
  }

  const todayStr = getJstDateString(nowMs);
  const lastCompleted = stored("contract_periodic_scan_last_date");
  if (lastCompleted === todayStr) {
    // 本日分はすでに完了している
    return;
  }

  if (inFlight) return;

  // チューナーが空いているか
  if (!(await isTunerAvailableForScan())) {
    return;
  }

  inFlight = true;
  try {
    const card = await cardStatus();
    const cardId = getActiveCardId(card);
    if (!card.ok || !cardId) return;

    // 日付が変わっていればキューをリセット
    if (queueDate !== todayStr) {
      currentQueue = buildScanQueue(cardId, settings.intendedServiceIds, nowMs);
      queueDate = todayStr;
    }

    if (currentQueue.length === 0) {
      // 全局完了
      store("contract_periodic_scan_last_date", todayStr);
      return;
    }

    // 先頭の 1 チャンネルを取り出して処理
    const nextChannel = currentQueue.shift();
    if (nextChannel) {
      await scanSingleChannel(nextChannel, cardId, nowMs);
    }

    if (currentQueue.length === 0) {
      store("contract_periodic_scan_last_date", todayStr);
    }
  } catch (err) {
    console.warn(`[contract-scan] スキャン中にエラーが発生しました: ${err}`);
  } finally {
    inFlight = false;
  }
}
