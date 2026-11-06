import { PACKET, SYNC } from "@danything/arib/psi";
/**
 * B-CAS カードの有料放送契約確認と実ストリーム復号テスト。
 *
 * EIT の CA契約情報記述子 (0xCB) に含まれる verificationData を B-CAS カード
 * (0x90 0x3C) に渡し、今日および 1 週間後の有効性、および契約有効期限を判別する。
 * また、実際にチューナーを開いて TS パケットのスクランブル制御ビットを検査し、
 * 復号できるかを確認する。
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { agentFetch } from "./agent-client";
import { orm } from "./db";
import { cardContracts, programs, services } from "./schema";
import { type CardStatus, cardStatus } from "./scramble";
import { openChannelStream } from "./tuner";

export interface ConfirmResult {
  ok: boolean;
  code: number;
  error?: string | undefined;
}

export type ContractState = "subscribed" | "unsubscribed" | "expired";

export interface ContractRow {
  cardId: string;
  serviceId: number;
  serviceName: string;
  channel: string;
  type: string;
  state: ContractState;
  code: number | null;
  validUntil: number | null;
  decodeOk: boolean | null;
  checkedAt: number;
}

/** 現在アクティブな B-CAS カードの番号 (16桁) を取得 */
export function getActiveCardId(card: CardStatus): string | null {
  if (card.source === "remote" && card.ids.length > 0) {
    return card.ids[0] ?? null;
  }
  const activeReader = card.readers.find((r) => r.state === "active");
  if (activeReader && activeReader.ids.length > 0) {
    return activeReader.ids[0] ?? null;
  }
  const anyCard = card.readers.find((r) => r.ids.length > 0);
  return anyCard?.ids[0] ?? null;
}

/** Date オブジェクト（または現在）を JST 基準の MJD (修正ユリウス日) に変換 */
export function toMjd(date: Date = new Date()): number {
  const jstMs = date.getTime() + 9 * 3600 * 1000;
  return Math.floor(jstMs / 86_400_000) + 40587;
}

/** MJD から Date (JST 00:00:00 の epoch ms) に変換 */
export function fromMjd(mjd: number): number {
  return (mjd - 40587) * 86_400_000 - 9 * 3600 * 1000;
}

/** 返り値コードから契約有効フラグ（月額TierまたはPPV）が立っているかを判定 */
export function isCodeSubscribed(code: number): boolean {
  // 0x0800: 月額Tier有効, 0x0400: 前払いPPV, 0x0200: 後払いPPV。
  // 上の桁や 0x0100 が立つ値 (実機の 0x8901 など) は契約の答えではないので、契約中とは見ない
  return (code & 0x0e00) !== 0 && (code & 0xf100) === 0;
}

/**
 * B-CAS カードの契約確認コマンド (0x90 0x3C) をエージェント経由で呼び出す。
 */
export async function confirmCardContract(
  verificationBase64: string,
  dateMjd: number,
): Promise<ConfirmResult> {
  try {
    const res = await agentFetch("/denpa/card/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verification: verificationBase64,
        date: dateMjd,
      }),
      signal: AbortSignal.timeout(5_000),
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
 * 有料放送局の最新の CA契約情報を B-CAS カードで確認し、card_contracts テーブルを更新する。
 */
export async function checkContracts(): Promise<ContractRow[]> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) {
    throw new Error(
      card.message || "B-CAS カードが認識されていないため契約を確認できません",
    );
  }

  // 有料番組（is_free = false）があり、contract_verification を持っているサービスを抽出
  const paidPrograms = orm()
    .select({
      serviceId: programs.service_id,
      verification: programs.contract_verification,
      startAt: programs.start_at,
    })
    .from(programs)
    .where(
      and(
        eq(programs.is_free, false),
        isNotNull(programs.contract_verification),
      ),
    )
    .orderBy(desc(programs.start_at))
    .all();

  // サービスごとに最新の verification を保持
  const serviceVerifications = new Map<number, string>();
  for (const prog of paidPrograms) {
    if (prog.verification && !serviceVerifications.has(prog.serviceId)) {
      serviceVerifications.set(prog.serviceId, prog.verification);
    }
  }

  if (serviceVerifications.size === 0) {
    return [];
  }

  const serviceIds = [...serviceVerifications.keys()];
  const allServices = orm()
    .select({
      id: services.id,
    })
    .from(services)
    .where(inArray(services.id, serviceIds))
    .all();

  const existingServiceIds = new Set(allServices.map((s) => s.id));

  const now = new Date();
  const todayMjd = toMjd(now);
  const futureMjd = todayMjd + 7;
  const nowMs = Date.now();

  for (const [serviceId, verification] of serviceVerifications) {
    if (!existingServiceIds.has(serviceId)) continue;
    // 1. 本日の判定
    const todayRes = await confirmCardContract(verification, todayMjd);
    if (!todayRes.ok) {
      throw new Error(
        `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${todayRes.error}`,
      );
    }

    let state: ContractState = "unsubscribed";
    const code: number | null = todayRes.code;
    let validUntil: number | null = null;

    if (isCodeSubscribed(todayRes.code)) {
      // 本日有効。1週間後 (MJD + 7) も有効か確認
      const futureRes = await confirmCardContract(verification, futureMjd);
      if (!futureRes.ok) {
        throw new Error(
          `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${futureRes.error}`,
        );
      }
      if (isCodeSubscribed(futureRes.code)) {
        // 1週間以上先まで有効
        state = "subscribed";
      } else {
        // 1週間以内に期限切れ
        state = "expired";
        // 1〜6日後でバイナリサーチして有効期限日を特定
        let low = 1;
        let high = 6;
        let lastValid = 0;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const midRes = await confirmCardContract(
            verification,
            todayMjd + mid,
          );
          if (!midRes.ok) {
            throw new Error(
              `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${midRes.error}`,
            );
          }
          if (isCodeSubscribed(midRes.code)) {
            lastValid = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        validUntil = fromMjd(todayMjd + lastValid + 1); // 期限日の翌日0時JST = 満了日時
      }
    } else {
      // 本日無効。過去30日前を確認して期限切れか未契約かを判別
      const pastRes = await confirmCardContract(verification, todayMjd - 30);
      if (!pastRes.ok) {
        throw new Error(
          `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${pastRes.error}`,
        );
      }
      if (isCodeSubscribed(pastRes.code)) {
        // 過去30日以内に期限切れとなった
        state = "expired";
        // 過去の日付でいつまで有効だったかをバイナリサーチ
        let low = -30;
        let high = -1;
        let lastValid = -30;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const midRes = await confirmCardContract(
            verification,
            todayMjd + mid,
          );
          if (!midRes.ok) {
            throw new Error(
              `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${midRes.error}`,
            );
          }
          if (isCodeSubscribed(midRes.code)) {
            lastValid = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        validUntil = fromMjd(todayMjd + lastValid + 1);
      } else {
        state = "unsubscribed";
      }
    }

    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: serviceId,
        state,
        code,
        valid_until: validUntil,
        decode_ok: null,
        checked_at: nowMs,
      })
      .onConflictDoUpdate({
        target: [cardContracts.card_id, cardContracts.service_id],
        set: {
          state,
          code,
          valid_until: validUntil,
          checked_at: nowMs,
        },
      })
      .run();
  }

  return getContractRows(cardId);
}

/**
 * DB に記録されている契約情報を取得する。
 */
export function getContractRows(cardId: string): ContractRow[] {
  const rows = orm()
    .select({
      cardId: cardContracts.card_id,
      serviceId: cardContracts.service_id,
      serviceName: services.name,
      channel: services.channel,
      type: services.type,
      state: cardContracts.state,
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
      decodeOk: cardContracts.decode_ok,
      checkedAt: cardContracts.checked_at,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(eq(cardContracts.card_id, cardId))
    .orderBy(asc(services.type), asc(services.service_id))
    .all();

  return rows.map((r) => ({
    cardId: r.cardId,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    channel: r.channel,
    type: r.type,
    state: r.state,
    code: r.code,
    validUntil: r.validUntil,
    decodeOk: r.decodeOk,
    checkedAt: r.checkedAt,
  }));
}

/**
 * 対象局のストリームを数秒間開いて TS パケットのスクランブルビットを検証し、
 * 復号可否 (decode_ok) を更新する。
 */
export async function testDecode(
  serviceId: number,
): Promise<{ ok: boolean; decodeOk: boolean; error?: string }> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) {
    return {
      ok: false,
      decodeOk: false,
      error: "B-CAS カードが認識されていません",
    };
  }

  const targetService = orm()
    .select({
      id: services.id,
      name: services.name,
      channel: services.channel,
      type: services.type,
    })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();

  if (!targetService) {
    return { ok: false, decodeOk: false, error: "サービスが見つかりません" };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);

  let stream: ReadableStream<Uint8Array> | null = null;
  try {
    // 優先度 5 (スキャン等と同等) でストリームを開く (WantsKeys が有効な live プレフィックス)
    stream = await openChannelStream(
      targetService.type,
      targetService.channel,
      abortController.signal,
      "live test-decode",
      5,
    );

    const reader = stream.getReader();
    let totalPackets = 0;
    let scrambledPackets = 0;
    let leftover = new Uint8Array(0);

    const targetPackets = 2000;

    while (totalPackets < targetPackets) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const buf = new Uint8Array(leftover.length + value.length);
      buf.set(leftover);
      buf.set(value, leftover.length);

      let offset = 0;
      while (offset + PACKET <= buf.length) {
        if (buf[offset] === SYNC) {
          totalPackets++;
          // 4バイト目 (buf[offset + 3]) の上位2ビットが transport_scrambling_control
          if ((buf[offset + 3]! & 0xc0) !== 0) {
            scrambledPackets++;
          }
          offset += PACKET;
        } else {
          // 同期バイトを探す
          offset++;
        }
      }
      leftover = buf.slice(offset);
    }

    try {
      await reader.cancel();
    } catch {
      // 無視
    }

    if (totalPackets < 50) {
      return {
        ok: false,
        decodeOk: false,
        error: "ストリームから十分なパケットを受信できませんでした",
      };
    }

    const ratio = scrambledPackets / totalPackets;
    // 0.5 以下なら復号成功とみなす (正常な復号 TS はスクランブル比率 0)
    const decodeOk = ratio < 0.5;

    // card_contracts を更新
    orm()
      .update(cardContracts)
      .set({
        decode_ok: decodeOk,
        checked_at: Date.now(),
      })
      .where(
        and(
          eq(cardContracts.card_id, cardId),
          eq(cardContracts.service_id, serviceId),
        ),
      )
      .run();

    return { ok: true, decodeOk };
  } catch (err) {
    return {
      ok: false,
      decodeOk: false,
      error: `選局またはストリーム受信に失敗しました: ${err}`,
    };
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }
}

export type ContractWarning = "expired" | "unsubscribed" | null;

/**
 * サービスごとの契約警告状態のマップを取得する。
 * 契約中のカードがあれば警告なし。期限切れのカードがあれば "expired"、未契約のみなら "unsubscribed"。
 */
export function getContractWarningsByService(): Map<
  number,
  "expired" | "unsubscribed"
> {
  const rows = orm()
    .select({
      serviceId: cardContracts.service_id,
      state: cardContracts.state,
    })
    .from(cardContracts)
    .all();

  const byService = new Map<number, ContractState[]>();
  for (const row of rows) {
    const list = byService.get(row.serviceId) ?? [];
    list.push(row.state);
    byService.set(row.serviceId, list);
  }

  const result = new Map<number, "expired" | "unsubscribed">();
  for (const [serviceId, states] of byService) {
    if (states.includes("subscribed")) continue;
    if (states.includes("expired")) {
      result.set(serviceId, "expired");
    } else if (states.includes("unsubscribed")) {
      result.set(serviceId, "unsubscribed");
    }
  }
  return result;
}

/**
 * 対象局・番組の契約警告状態 ("expired" | "unsubscribed" | null) を判定する。
 * 無料番組 (isFree = true) や契約中・未確認の局は null。
 */
export function getContractWarning(
  serviceId: number,
  isFree = false,
): "expired" | "unsubscribed" | null {
  if (isFree) return null;
  const warnings = getContractWarningsByService();
  return warnings.get(serviceId) ?? null;
}
