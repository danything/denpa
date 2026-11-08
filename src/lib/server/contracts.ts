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
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { agentFetch } from "./agent-client";
import { config } from "./config";
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
 * 有料の番組を復号できて録れたら、確かめた日を新しくする (`noteDecoded`)。録画が復号できずに終わったときは、31 日を待たずに下げる (`noteStillScrambled`)
 */
export const DECODE_VALID_MS = 31 * 86_400_000;

/** 復号テストで確かめた契約が、まだ信じられる新しさか */
function freshDecode(
  decodedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  return decodedAt != null && now - decodedAt < DECODE_VALID_MS;
}

/**
 * **ダイアログに出す契約の状態。** `ContractState` に、まだ確かめていない (`unverified`) を足したもの。
 * 行が無い局と、カードが答えておらず (`code` が無い)、新しい復号の結果も無い局が `unverified`。
 * `subscribed` は、`paidAllowed` が録ってよいとする局と同じ
 */
export type ContractStatus = ContractState | "unverified";

export interface ContractRow {
  cardId: string;
  serviceId: number;
  serviceName: string;
  channel: string;
  type: string;
  state: ContractState;
  status: ContractStatus;
  code: number | null;
  validUntil: number | null;
  decodeOk: boolean | null;
  /** 確かめた時刻。行が無い局は null */
  checkedAt: number | null;
}

/** 行から、ダイアログに出す状態を決める (`ContractStatus`) */
export function contractStatus(
  row: {
    state: ContractState;
    code: number | null;
    decodeOk: boolean | null;
    decodedAt: number | null;
  },
  now = Date.now(),
): ContractStatus {
  // カードが答えた局は、その答えのまま
  if (row.code !== null) return row.state;
  if (row.state === "subscribed" && freshDecode(row.decodedAt, now))
    return "subscribed";
  // 復号を試して掛かったままだった局は未契約。31 日を過ぎた結果しか無い局と、試していない局は確かめていない
  return row.decodeOk === false ? "unsubscribed" : "unverified";
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
 * カードの契約の一覧 (設定のダイアログ)。card_contracts の行に、番組表に有料の番組があって行がまだ無い局を
 * 「確かめていない」として足す。並びは種別、局の番号の順
 */
export function getContractRows(
  cardId: string,
  now = Date.now(),
): ContractRow[] {
  const rows: (ContractRow & { arib: number })[] = orm()
    .select({
      cardId: cardContracts.card_id,
      serviceId: cardContracts.service_id,
      serviceName: services.name,
      channel: services.channel,
      type: services.type,
      arib: services.service_id,
      state: cardContracts.state,
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
      checkedAt: cardContracts.checked_at,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(eq(cardContracts.card_id, cardId))
    .all()
    .map(({ decodedAt, ...row }) => ({
      ...row,
      status: contractStatus({ ...row, decodedAt }, now),
    }));
  const known = new Set(rows.map((row) => row.serviceId));
  const missing = orm()
    .selectDistinct({
      serviceId: services.id,
      serviceName: services.name,
      channel: services.channel,
      type: services.type,
      arib: services.service_id,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(eq(programs.is_free, false))
    .all()
    .filter((service) => !known.has(service.serviceId));
  for (const service of missing)
    rows.push({
      cardId,
      ...service,
      state: "unsubscribed",
      status: "unverified",
      code: null,
      validUntil: null,
      decodeOk: null,
      checkedAt: null,
    });
  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.arib - b.arib;
  });
  return rows.map((entry) => {
    const { arib: _, ...row } = entry;
    return row;
  });
}

/** 復号を確かめた 1 局の結果。`ok` が false なら確かめられなかった (`error` に理由) */
export interface DecodeResult {
  ok: boolean;
  decodeOk: boolean;
  error?: string;
}

/** 復号を確かめる局 (`services` の行) */
interface DecodeTarget {
  id: number;
  arib: number;
  type: string;
  channel: string;
}

/** 局ごとにパケットを数える長さ。これだけ数えたら、15 秒を待たずに判定する */
const DECODE_PACKETS = 2000;

/**
 * **同じ物理チャンネルの局を 1 つの組にまとめる** (`testDecodeUnverified`)。1 つの組は 1 回の選局で確かめる。
 * 組と組の中の並びは、渡した順
 */
export function groupByChannel<T extends { type: string; channel: string }>(
  targets: T[],
): T[][] {
  const groups = new Map<string, T[]>();
  for (const target of targets) {
    const key = `${target.type} ${target.channel}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [target]);
    else group.push(target);
  }
  return [...groups.values()];
}

/**
 * **いまその局で流れている番組が有料のときだけ確かめる。** 無料の時間帯は契約が無くても
 * スクランブルが掛かっていないので、復号できたように見えて契約中と取り違える。確かめられないときはその理由
 */
function notPaidNow(serviceId: number, now: number): string | null {
  const airing = orm()
    .select({ isFree: programs.is_free })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        lte(programs.start_at, now),
        gt(programs.end_at, now),
      ),
    )
    .get();
  if (airing === undefined)
    return "いま流れている番組が番組表に無いため、復号を確かめられません";
  if (airing.isFree)
    return "いまは無料の番組を流しているため、復号を確かめられません。有料の番組の間にもう一度試してください";
  return null;
}

/**
 * 対象局のストリームを数秒間開いて TS パケットのスクランブルビットを検証し、
 * 復号可否 (decode_ok) を更新する。
 */
export async function testDecode(serviceId: number): Promise<DecodeResult> {
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
      channel: services.channel,
      type: services.type,
    })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();

  if (!targetService) {
    return { ok: false, decodeOk: false, error: "サービスが見つかりません" };
  }

  const notPaid = notPaidNow(serviceId, Date.now());
  if (notPaid !== null) return { ok: false, decodeOk: false, error: notPaid };

  const results = await decodeOnChannel(cardId, [targetService]);
  return (
    results.get(serviceId) ?? {
      ok: false,
      decodeOk: false,
      error: "復号を確かめられませんでした",
    }
  );
}

/** `testDecodeUnverified` が動いている間 */
let decodingUnverified = false;

/**
 * **確かめていない有料の局を、物理チャンネルごとに 1 回の選局でまとめて確かめる** (設定のダイアログ)。
 * 対象は `getContractRows` で「確かめていない」(`unverified`) の局のうち、いま有料の番組を流している局。
 * ほかの局は確かめずに、理由を付けて返す。チャンネルは 1 つずつ順に選局する (チューナーを 1 台しか使わない)
 */
export async function testDecodeUnverified(): Promise<
  | { ok: true; results: Map<number, DecodeResult> }
  | { ok: false; error: string }
> {
  // 別のタブから重ねて押されたら断る (同じチャンネルを 2 回選局してチューナーを取り合う)
  if (decodingUnverified)
    return { ok: false, error: "ほかの画面でまとめて確かめています" };
  decodingUnverified = true;
  try {
    return await decodeUnverified();
  } finally {
    decodingUnverified = false;
  }
}

async function decodeUnverified(): Promise<
  | { ok: true; results: Map<number, DecodeResult> }
  | { ok: false; error: string }
> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId)
    return { ok: false, error: "B-CAS カードが認識されていません" };

  const now = Date.now();
  const unverified = new Set(
    getContractRows(cardId, now)
      .filter((row) => row.status === "unverified")
      .map((row) => row.serviceId),
  );
  const results = new Map<number, DecodeResult>();
  if (unverified.size === 0) return { ok: true, results };
  const targets: DecodeTarget[] = [];
  for (const target of orm()
    .select({
      id: services.id,
      arib: services.service_id,
      channel: services.channel,
      type: services.type,
    })
    .from(services)
    .where(inArray(services.id, [...unverified]))
    .all()) {
    const notPaid = notPaidNow(target.id, now);
    if (notPaid === null) targets.push(target);
    else results.set(target.id, { ok: false, decodeOk: false, error: notPaid });
  }
  for (const group of groupByChannel(targets))
    for (const [id, result] of await decodeOnChannel(cardId, group))
      results.set(id, result);
  return { ok: true, results };
}

/**
 * **1 つの物理チャンネルを 1 回だけ選局し、その中の局ごとに復号できるかを確かめて card_contracts に書く。**
 * `targets` は同じチャンネルの局 (`groupByChannel`)。選局に失敗したら、どの局も確かめられなかったことにする
 */
async function decodeOnChannel(
  cardId: string,
  targets: DecodeTarget[],
): Promise<Map<number, DecodeResult>> {
  const results = new Map<number, DecodeResult>();
  const first = targets[0];
  if (first === undefined) return results;

  /*
   * **局ごとに、その局のパケットだけを数える** (`ServiceFilter`)。物理チャンネルには同じ中継器のほかの局も入っていて、
   * スクランブルの無い局のパケットまで数えると、復号できなくても割合が下がる
   */
  const counts = targets.map((target) => ({
    target,
    filter: new ServiceFilter(target.arib),
    total: 0,
    scrambled: 0,
  }));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);

  try {
    // スキャンと同じ優先度でストリームを開く (WantsKeys が有効な live プレフィックス)
    const stream = await openChannelStream(
      first.type,
      first.channel,
      abortController.signal,
      "live test-decode",
      config.priority.scan,
    );

    const reader = stream.getReader();
    while (counts.some((count) => count.total < DECODE_PACKETS)) {
      // 15 秒で打ち切ったら、それまでに数えたぶんで判定する
      const next = await reader.read().catch((error: unknown) => {
        if (abortController.signal.aborted)
          return { done: true, value: undefined };
        throw error;
      });
      const { done, value } = next;
      if (done || !value) break;

      for (const count of counts) {
        const own = count.filter.filter(value);
        for (let offset = 0; offset + PACKET <= own.length; offset += PACKET) {
          if (own[offset] !== SYNC) continue;
          // ペイロードの無いパケットはスクランブルの対象にならない
          if ((own[offset + 3]! & 0x10) === 0) continue;
          count.total++;
          // 4 バイト目の上位 2 ビットが transport_scrambling_control
          if ((own[offset + 3]! & 0xc0) !== 0) count.scrambled++;
        }
      }
    }

    try {
      await reader.cancel();
    } catch {
      // 無視
    }
  } catch (err) {
    for (const target of targets)
      results.set(target.id, {
        ok: false,
        decodeOk: false,
        error: `選局またはストリーム受信に失敗しました: ${err}`,
      });
    return results;
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }

  // 書くのは受け終えてから (書けなかったときに、選局の失敗と取り違えない)
  for (const { target, total, scrambled } of counts) {
    if (total < 50) {
      results.set(target.id, {
        ok: false,
        decodeOk: false,
        error: "ストリームから十分なパケットを受信できませんでした",
      });
      continue;
    }
    // 0.5 未満なら復号成功とみなす (正常な復号 TS はスクランブル比率 0)
    const decodeOk = scrambled / total < 0.5;
    saveDecode(cardId, target.id, decodeOk);
    results.set(target.id, { ok: true, decodeOk });
  }
  return results;
}

/**
 * 復号を確かめた結果を card_contracts に書く (`decodeOnChannel`、`noteDecoded`)。復号できたら契約中にする
 */
function saveDecode(
  cardId: string,
  serviceId: number,
  decodeOk: boolean,
  now = Date.now(),
): void {
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
        // **カードが答えた行 (code がある) は状態を変えない。** カードが期限切れと答えた局を、
        // 復号できたことで契約中に戻すと、定期の確認まで録ってしまう (カードの答えを信じる)
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
 * **有料の番組を復号できて録れた。** その局を、復号テストで確かめたときと同じく契約中にする (`encoder.ts`。`noteStillScrambled` の反対)。
 * 番組表に契約の情報 (0xCB) が無い局は、手で予約した録画でも契約中になり、録り続けている間は 31 日 (`DECODE_VALID_MS`) を過ぎても録られなくならない。
 *
 * 書くのは、いま使っているカードの行。カードが読めないときは書かない (どのカードで観られたか分からない)。
 * カードが答えた行 (`code` がある) の状態は変えない (`saveDecode`)
 */
export async function noteDecoded(serviceId: number): Promise<void> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) return;
  saveDecode(cardId, serviceId, true);
}

/**
 * **有料放送を自動予約してよい局** (`rules.PaidAllowed`)。どれかのカードで契約中と確かめた局だけ。
 *
 * 未契約・期限切れの局と、まだ確かめていない局 (確かめる前・カードが無い・番組表に 0xCB が無く
 * 復号も試していない) は録らない。録ってもスクランブルのままで観られないため。
 * 設定の「無料放送だけ録る」はこれに置き換えた。カードを持たない人は、今までの既定 (無料だけ) と同じになる。
 * カードに聞けない局 (番組表に 0xCB が無い) は、復号テストか有料の番組を復号できた録画から 31 日のあいだだけ (`DECODE_VALID_MS`)。
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
