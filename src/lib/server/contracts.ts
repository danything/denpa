import { PACKET, SYNC } from "@danything/arib/psi";
import { ServiceFilter } from "@danything/arib/service-filter";
/**
 * B-CAS カードの有料放送契約確認と実ストリーム復号テスト。
 *
 * EIT の CA契約情報記述子 (0xCB) に含まれる verificationData を B-CAS カード
 * (0x90 0x3C) に渡し、今日および 1 週間後の有効性、および契約有効期限を判別する。
 * また、実際にチューナーを開いて TS パケットのスクランブル制御ビットを検査し、
 * 復号できるかを確認する。
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

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

/**
 * **復号テストで確かめた契約を信じる長さ (31 日)。** 番組表に契約の情報 (0xCB) が無い局はカードに聞けないので、
 * 復号できたことだけが手がかりになる。CS の月額は月ごとに切れるので、確かめてから 1 か月を過ぎたら確かめ直すまで録らない。
 * 録画が復号できずに終わったときは、それを待たずに下げる (`noteStillScrambled`)
 */
export const DECODE_VALID_MS = 31 * 86_400_000;

/** 復号テストで確かめた契約が、まだ信じられる新しさか */
export function freshDecode(
  decodedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  return decodedAt != null && now - decodedAt < DECODE_VALID_MS;
}

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

  // 有料番組を持つ局 (局の表にあるものだけ) と、その局の新しい番組の契約確認情報 (無ければ null)
  const serviceVerifications = new Map<number, string | null>();
  for (const prog of orm()
    .select({
      serviceId: programs.service_id,
      verification: programs.contract_verification,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(eq(programs.is_free, false))
    .orderBy(desc(programs.start_at))
    .all()) {
    if (!serviceVerifications.get(prog.serviceId))
      serviceVerifications.set(prog.serviceId, prog.verification ?? null);
  }
  if (serviceVerifications.size === 0) return [];
  const serviceIds = [...serviceVerifications.keys()];

  // 既存の契約レコード（前回の復号結果等）を取得して保持する
  const existingContracts = orm()
    .select({
      serviceId: cardContracts.service_id,
      state: cardContracts.state,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .where(
      and(
        eq(cardContracts.card_id, cardId),
        inArray(cardContracts.service_id, serviceIds),
      ),
    )
    .all();
  const existingMap = new Map(existingContracts.map((c) => [c.serviceId, c]));

  const now = new Date();
  const todayMjd = toMjd(now);
  const nowMs = Date.now();

  for (const [serviceId, verification] of serviceVerifications) {
    const existing = existingMap.get(serviceId);

    let state: ContractState = "unsubscribed";
    let code: number | null = null;
    let validUntil: number | null = null;

    if (verification) {
      /** その日 (今日からの日数) に観られるか。カードに聞けなければ投げる (今の行を上書きしない) */
      const valid = async (days: number): Promise<boolean> => {
        const res = await confirmCardContract(verification, todayMjd + days);
        if (!res.ok) {
          throw new Error(
            `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${res.error}`,
          );
        }
        if (days === 0) code = res.code;
        return isCodeSubscribed(res.code);
      };
      /** `from` 日目は観られて `to` 日目は観られないとき、観られる最後の日 (2 分探索) */
      const lastValid = async (from: number, to: number): Promise<number> => {
        while (to - from > 1) {
          const mid = Math.floor((from + to) / 2);
          if (await valid(mid)) from = mid;
          else to = mid;
        }
        return from;
      };
      if (await valid(0)) {
        // 今日は観られる。**1 週間以内に切れても契約中のまま**にし、期限の日だけ覚える
        // (期限切れにすると、まだ観られる局が録られなくなる)
        state = "subscribed";
        if (!(await valid(7)))
          // 期限日の翌日 0 時 (JST) が満了
          validUntil = fromMjd(todayMjd + (await lastValid(0, 7)) + 1);
      } else if (await valid(-30)) {
        // 30 日のうちに切れた
        state = "expired";
        validUntil = fromMjd(todayMjd + (await lastValid(-30, 0)) + 1);
      } else {
        state = "unsubscribed";
      }
    } else {
      // 放送波 (EIT) に CA契約情報記述子 (0xCB) が載っていない局 (多くの CS 月額局など)。
      // 復号テストで 31 日以内に復号できていれば契約中とみなす (`DECODE_VALID_MS`)
      state =
        existing?.decodeOk === true && freshDecode(existing.decodedAt, nowMs)
          ? "subscribed"
          : "unsubscribed";
    }

    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: serviceId,
        state,
        code,
        valid_until: validUntil,
        decode_ok: existing?.decodeOk ?? null,
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
  return orm()
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
}

/**
 * 復号テストの結果を `card_contracts` に書く。
 *
 * **カードが答えた行 (`code` あり) は状態を変えない。** カードが期限切れと答えた局を、
 * 復号できたことで契約中に戻すと、定期の確認まで録ってしまう (カードの答えを信じる)
 */
function recordDecode(
  cardId: string,
  serviceId: number,
  decodeOk: boolean,
): void {
  const now = Date.now();
  orm()
    .insert(cardContracts)
    .values({
      card_id: cardId,
      service_id: serviceId,
      state: decodeOk ? "subscribed" : "unsubscribed",
      code: null,
      valid_until: null,
      decode_ok: decodeOk,
      decoded_at: decodeOk ? now : null,
      checked_at: now,
    })
    .onConflictDoUpdate({
      target: [cardContracts.card_id, cardContracts.service_id],
      set: {
        decode_ok: decodeOk,
        decoded_at: decodeOk ? now : null,
        ...(decodeOk
          ? {
              state: sql`CASE WHEN ${cardContracts.code} IS NULL THEN 'subscribed' ELSE ${cardContracts.state} END`,
            }
          : {}),
        checked_at: now,
      },
    })
    .run();
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
      arib: services.service_id,
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

  /*
   * **いまその局で流れている番組が有料のときだけ確かめる。** 無料の時間帯は契約が無くても
   * スクランブルが掛かっていないので、復号できたように見えて契約中と取り違える
   */
  const nowMs = Date.now();
  const airing = orm()
    .select({ isFree: programs.is_free })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        lte(programs.start_at, nowMs),
        gt(programs.end_at, nowMs),
      ),
    )
    .get();
  if (airing === undefined || airing.isFree) {
    return {
      ok: false,
      decodeOk: false,
      error:
        airing === undefined
          ? "いま流れている番組が番組表に無いため、復号を確かめられません"
          : "いまは無料の番組を流しているため、復号を確かめられません。有料の番組の間にもう一度試してください",
    };
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
    /*
     * **その局のパケットだけを数える** (`ServiceFilter`)。物理チャンネルには同じ中継器のほかの局も入っていて、
     * スクランブルの無い局のパケットまで数えると、復号できなくても割合が下がる
     */
    const filter = new ServiceFilter(targetService.arib);
    let totalPackets = 0;
    let scrambledPackets = 0;

    const targetPackets = 2000;

    while (totalPackets < targetPackets) {
      // 15 秒で打ち切ったら、それまでに数えたぶんで判定する
      const next = await reader.read().catch((error: unknown) => {
        if (abortController.signal.aborted)
          return { done: true, value: undefined };
        throw error;
      });
      const { done, value } = next;
      if (done || !value) break;

      const own = filter.filter(value);
      for (let offset = 0; offset + PACKET <= own.length; offset += PACKET) {
        if (own[offset] !== SYNC) continue;
        // ペイロードの無いパケットはスクランブルの対象にならない
        if ((own[offset + 3]! & 0x10) === 0) continue;
        totalPackets++;
        // 4 バイト目の上位 2 ビットが transport_scrambling_control
        if ((own[offset + 3]! & 0xc0) !== 0) scrambledPackets++;
      }
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

    recordDecode(cardId, serviceId, decodeOk);

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
 * 局の契約の警告 (予約・番組の詳しく・番組表のバッジ)。無料の番組と、契約中のカードがある局・確かめていない局は null。
 * どのカードにも契約が無ければ、期限切れのカードがあれば "expired"、無ければ "unsubscribed"
 */
export function getContractWarning(
  serviceId: number,
  isFree = false,
): ContractWarning {
  if (isFree) return null;
  const states = orm()
    .select({ state: cardContracts.state })
    .from(cardContracts)
    .where(eq(cardContracts.service_id, serviceId))
    .all()
    .map((row) => row.state);
  if (states.length === 0 || states.includes("subscribed")) return null;
  return states.includes("expired") ? "expired" : "unsubscribed";
}

/** まとめて復号テストした 1 局ぶんの結果 */
export interface DecodeTestResult {
  serviceId: number;
  ok: boolean;
  decodeOk: boolean;
  error?: string | undefined;
}

/** 一括テストで、1 局あたりに数えるパケット数の上限 (個別テストと同じ) */
const BATCH_TARGET_PACKETS = 2000;

/** 一括テストで、1 つの物理チャンネルを開いておく上限 (個別テストと同じ) */
const BATCH_TIMEOUT_MS = 15_000;

/** 一括テストの対象 (同じ物理チャンネルの局を 1 回の選局でまとめて数える) */
interface DecodeCandidate {
  serviceId: number;
  arib: number;
  channel: string;
  type: string;
}

/**
 * カードが答えていない局をまとめて復号テストする。
 *
 * **同じ物理チャンネルの局は 1 回の選局で済ませる。** 1 局ずつ `testDecode` を呼ぶと、
 * 同じ中継器の局の数だけ選局と待ち時間が増えてしまうため。
 * 対象は `code` が無い行 (番組表に 0xCB が無い局など) のうち、まだ新しく復号を確かめていない局だけ。
 * いま無料の番組を流している局は、スクランブルが掛からず契約と取り違えるので対象外。
 */
export async function testDecodeUnconfirmed(): Promise<{
  cardId: string;
  results: DecodeTestResult[];
}> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) {
    throw new Error(
      card.message || "B-CAS カードが認識されていないため契約を確認できません",
    );
  }

  const nowMs = Date.now();
  const rows = orm()
    .select({
      serviceId: services.id,
      arib: services.service_id,
      channel: services.channel,
      type: services.type,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(and(eq(cardContracts.card_id, cardId), isNull(cardContracts.code)))
    .orderBy(
      asc(services.type),
      asc(services.channel),
      asc(services.service_id),
    )
    .all();

  /*
   * いま有料の番組を流している局だけを対象にする。無料の時間帯はスクランブルが掛かっていないので、
   * 復号できたように見えて契約中と取り違える (個別テストと同じ理由)
   */
  const airing = new Map<number, boolean>();
  for (const program of orm()
    .select({ serviceId: programs.service_id, isFree: programs.is_free })
    .from(programs)
    .where(and(lte(programs.start_at, nowMs), gt(programs.end_at, nowMs)))
    .all()) {
    airing.set(
      program.serviceId,
      (airing.get(program.serviceId) ?? false) || !program.isFree,
    );
  }

  const results: DecodeTestResult[] = [];
  const candidates: DecodeCandidate[] = [];
  for (const row of rows) {
    // 31 日のあいだに復号できている局は、確かめ直さない
    if (row.decodeOk === true && freshDecode(row.decodedAt, nowMs)) continue;
    if (airing.get(row.serviceId) !== true) {
      results.push({
        serviceId: row.serviceId,
        ok: false,
        decodeOk: false,
        error: "いま有料の番組を流していないため、復号を確かめられません",
      });
      continue;
    }
    candidates.push(row);
  }

  const groups = new Map<string, DecodeCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.type}\u0000${candidate.channel}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  for (const group of groups.values()) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), BATCH_TIMEOUT_MS);
    const filters = group.map((candidate) => ({
      candidate,
      filter: new ServiceFilter(candidate.arib),
      total: 0,
      scrambled: 0,
    }));

    try {
      const stream = await openChannelStream(
        group[0]!.type,
        group[0]!.channel,
        abortController.signal,
        "live test-decode",
        5,
      );
      const reader = stream.getReader();
      try {
        while (filters.some((f) => f.total < BATCH_TARGET_PACKETS)) {
          const next = await reader.read().catch((error: unknown) => {
            if (abortController.signal.aborted)
              return { done: true, value: undefined };
            throw error;
          });
          const { done, value } = next;
          if (done || !value) break;

          for (const f of filters) {
            const own = f.filter.filter(value);
            for (
              let offset = 0;
              offset + PACKET <= own.length;
              offset += PACKET
            ) {
              if (own[offset] !== SYNC) continue;
              // ペイロードの無いパケットはスクランブルの対象にならない
              if ((own[offset + 3]! & 0x10) === 0) continue;
              f.total++;
              // 4 バイト目の上位 2 ビットが transport_scrambling_control
              if ((own[offset + 3]! & 0xc0) !== 0) f.scrambled++;
            }
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // 無視
        }
      }

      for (const f of filters) {
        if (f.total < 50) {
          results.push({
            serviceId: f.candidate.serviceId,
            ok: false,
            decodeOk: false,
            error: "ストリームから十分なパケットを受信できませんでした",
          });
          continue;
        }
        const decodeOk = f.scrambled / f.total < 0.5;
        recordDecode(cardId, f.candidate.serviceId, decodeOk);
        results.push({
          serviceId: f.candidate.serviceId,
          ok: true,
          decodeOk,
        });
      }
    } catch (err) {
      for (const f of filters) {
        results.push({
          serviceId: f.candidate.serviceId,
          ok: false,
          decodeOk: false,
          error: `選局またはストリーム受信に失敗しました: ${err}`,
        });
      }
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }
  }

  return { cardId, results };
}

/**
 * **有料放送を自動予約してよい局** (`rules.PaidAllowed`)。どれかのカードで契約中と確かめた局だけ。
 *
 * 未契約・期限切れの局と、まだ確かめていない局 (確かめる前・カードが無い・番組表に 0xCB が無く
 * 復号も試していない) は録らない。録ってもスクランブルのままで観られないため。
 * 設定の「無料放送だけ録る」はこれに置き換えた。カードを持たない人は、今までの既定 (無料だけ) と同じになる。
 * カードに聞けない局 (番組表に 0xCB が無い) は、復号テストから 31 日のあいだだけ (`DECODE_VALID_MS`)。
 * 1 回の当てはめで 1 回だけ読む (呼ぶ側が関数を使い回す)
 */
export function paidAllowed(now = Date.now()): (serviceId: number) => boolean {
  const subscribed = new Set(
    orm()
      .select({
        serviceId: cardContracts.service_id,
        code: cardContracts.code,
        decodedAt: cardContracts.decoded_at,
      })
      .from(cardContracts)
      .where(eq(cardContracts.state, "subscribed"))
      .all()
      .filter((row) => row.code !== null || freshDecode(row.decodedAt, now))
      .map((row) => row.serviceId),
  );
  return (serviceId) => subscribed.has(serviceId);
}

/**
 * **有料の番組の録画が、復号し直しても掛かったまま終わった。** 復号テストで契約中としていた局を未契約に下げる
 * (`encoder.ts`)。契約が切れたあとも 31 日待たずに、次の回から録らなくなる。
 *
 * 下げるのは、カードに聞けない局 (`code` が無い行) だけ。カードが契約中と答えた局は、掛かったままの理由が
 * ほかにある (ECM が流れていない など) ので、カードの答えを信じる (次の定期の確認で確かめ直す)
 */
export function noteStillScrambled(serviceId: number): void {
  orm()
    .update(cardContracts)
    .set({
      state: "unsubscribed",
      decode_ok: false,
      decoded_at: null,
      checked_at: Date.now(),
    })
    .where(
      and(
        eq(cardContracts.service_id, serviceId),
        eq(cardContracts.state, "subscribed"),
        isNull(cardContracts.code),
      ),
    )
    .run();
}
