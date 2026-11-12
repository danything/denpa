/**
 * B-CAS カードの有料放送の契約を確かめる。
 *
 * EIT の CA 契約情報記述子 (0xCB) にある verificationData を B-CAS カードに渡し (0x90 0x3C)、
 * 今日と 1 週間後に観られるかと、契約の期限を調べる。記述子の無い局は、チューナーで受けて
 * TS パケットのスクランブル制御ビットを数え、復号できるかを確かめる。
 */

import { PACKET } from "@danything/arib/psi";
import { ServiceFilter } from "@danything/arib/service-filter";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { NO_CHANNEL, serviceAgent, serviceChannel } from "./agent-channels";
import { fetchAgent } from "./agent-client";
import { type Agent, primaryAgent } from "./agents";
import { config } from "./config";
import { orm } from "./db";
import { cardContracts, programs, services } from "./schema";
import {
  type CardStatus,
  cardStatus,
  mediaPids,
  ScrambleCount,
} from "./scramble";
import { openChannelStream } from "./tuner";

interface ConfirmResult {
  ok: boolean;
  code: number;
  error?: string | undefined;
}

type ContractState = "subscribed" | "unsubscribed" | "expired";

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
  /** 局を選局するチャンネル (`agent-channels.serviceChannel`)。エージェントの控えに無ければ null */
  channel: string | null;
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

/** いま使っている B-CAS カードの番号 (16 桁)。鍵を配る相手のカード、使用中のリーダー、カードのあるリーダーの順に探す */
export function getActiveCardId(card: CardStatus): string | null {
  if (card.source === "remote" && card.ids.length > 0)
    return card.ids[0] ?? null;
  const reader =
    card.readers.find((r) => r.state === "active" && r.ids.length > 0) ??
    card.readers.find((r) => r.ids.length > 0);
  return reader?.ids[0] ?? null;
}

const NO_CARD = "B-CAS カードが認識されていません";

/** いま使っているカードの番号。カードが読めなければ null */
async function usableCardId(): Promise<string | null> {
  const card = await cardStatus();
  return (card.ok && getActiveCardId(card)) || null;
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
 * B-CAS カードの契約確認コマンド (0x90 0x3C) をエージェント経由で呼び出す。`agent` を渡さなければ並びの先頭のエージェント。
 */
export async function confirmCardContract(
  verificationBase64: string,
  dateMjd: number,
  agent?: Agent,
): Promise<ConfirmResult> {
  try {
    const res = await fetchAgent(
      agent ?? primaryAgent(),
      "/denpa/card/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verification: verificationBase64,
          date: dateMjd,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
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

  // 前に復号を確かめた結果 (番組表に契約の情報が無い局は、これで決める)
  const existingContracts = orm()
    .select({
      serviceId: cardContracts.service_id,
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

  const nowMs = Date.now();
  const todayMjd = toMjd(new Date(nowMs));

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
      channel: serviceChannel(),
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
      channel: serviceChannel(),
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
interface DecodeResult {
  ok: boolean;
  decodeOk: boolean;
  error?: string;
}

/** 復号を確かめる局を読む `services` の列 */
const DECODE_TARGET = {
  id: services.id,
  arib: services.service_id,
  type: services.type,
  channel: serviceChannel(),
  agent: serviceAgent(),
};

/** 復号を確かめる局 (`DECODE_TARGET` で読んだ行) */
interface DecodeTarget {
  id: number;
  arib: number;
  type: string;
  channel: string | null;
  /** `channel` を控えに持つエージェント (`agent-channels.serviceAgent`)。契約を確かめる選局はここへ送る (振り分けない) */
  agent: number | null;
}

/** 局ごとにパケットを数える長さ。これだけ数えたら、15 秒を待たずに判定する */
const DECODE_PACKETS = 2000;

/**
 * **同じ物理チャンネルの局を 1 つの組にまとめる** (`testDecodeUnverified`)。1 つの組は 1 回の選局で確かめる。
 * 組と組の中の並びは、渡した順
 */
export function groupByChannel<
  T extends { type: string; channel: string | null },
>(targets: T[]): T[][] {
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
  const cardId = await usableCardId();
  if (cardId === null) return { ok: false, decodeOk: false, error: NO_CARD };

  const targetService = orm()
    .select(DECODE_TARGET)
    .from(services)
    .where(eq(services.id, serviceId))
    .get();
  if (!targetService)
    return { ok: false, decodeOk: false, error: "局が見つかりません" };

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

/** まとめて確かめた結果。局ごとの結果か、まとめて確かめられなかった理由 */
type DecodeAll =
  | { ok: true; results: Map<number, DecodeResult> }
  | { ok: false; error: string };

/** `testDecodeUnverified` が動いている間 */
let decodingUnverified = false;

/**
 * **確かめていない有料の局を、物理チャンネルごとに 1 回の選局でまとめて確かめる** (設定のダイアログ)。
 * 対象は `getContractRows` で「確かめていない」(`unverified`) の局のうち、いま有料の番組を流している局。
 * ほかの局は確かめずに、理由を付けて返す。チャンネルは 1 つずつ順に選局する (チューナーを 1 台しか使わない)
 */
export async function testDecodeUnverified(): Promise<DecodeAll> {
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

async function decodeUnverified(): Promise<DecodeAll> {
  const cardId = await usableCardId();
  if (cardId === null) return { ok: false, error: NO_CARD };

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
    .select(DECODE_TARGET)
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
  const channel = first.channel;
  const agent = first.agent;
  if (channel === null || agent === null) {
    for (const target of targets)
      results.set(target.id, { ok: false, decodeOk: false, error: NO_CHANNEL });
    return results;
  }

  /*
   * **局ごとに、その局のパケットだけを数える** (`ServiceFilter`)。物理チャンネルには同じ中継器のほかの局も入っていて、
   * スクランブルの無い局のパケットまで数えると、復号できなくても割合が下がる
   */
  const counts = targets.map((target) => ({
    target,
    filter: new ServiceFilter(target.arib),
    count: new ScrambleCount(DECODE_PACKETS),
  }));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);

  try {
    // スキャンと同じ優先度でストリームを開く (WantsKeys が有効な live プレフィックス)
    const stream = await openChannelStream(
      first.type,
      [{ agent, channel }],
      abortController.signal,
      "live test-decode",
      config.priority.scan,
    );

    const reader = stream.getReader();
    while (counts.some(({ count }) => !count.full)) {
      // 15 秒で打ち切ったら、それまでに数えたぶんで判定する
      const next = await reader.read().catch((error: unknown) => {
        if (abortController.signal.aborted)
          return { done: true, value: undefined };
        throw error;
      });
      const { done, value } = next;
      if (done || !value) break;

      for (const { filter, count } of counts) {
        const own = filter.filter(value);
        const media = mediaPids(filter.streams);
        for (let offset = 0; offset + PACKET <= own.length; offset += PACKET)
          count.feed(own.subarray(offset, offset + PACKET), media);
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
  for (const {
    target,
    count: { total, scrambled },
  } of counts) {
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
 * 復号を確かめた結果を card_contracts に書く (`decodeOnChannel`、`noteDecoded`)。
 *
 * **カードに聞けない行 (`code` が無い) の状態は、復号の結果で決める** (できたら契約中、できなければ未契約)。新しく作る行も
 * 前からある行も同じ。録画が復号し直しても掛かったままだったときに未契約に下げる (`noteStillScrambled`) のと同じ物差し
 */
function saveDecode(
  cardId: string,
  serviceId: number,
  decodeOk: boolean,
  now = Date.now(),
): void {
  const state: ContractState = decodeOk ? "subscribed" : "unsubscribed";
  orm()
    .insert(cardContracts)
    .values({
      card_id: cardId,
      service_id: serviceId,
      state,
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
        state: sql`CASE WHEN ${cardContracts.code} IS NULL THEN ${state} ELSE ${cardContracts.state} END`,
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
  const cardId = await usableCardId();
  if (cardId !== null) saveDecode(cardId, serviceId, true);
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
 * **手で予約した有料の番組が、スクランブルのまま録れるかもしれないときの通知の文** (番組表・検索の「予約」)。
 * 予約は断らない (手で録ると決めたのは人なので)。録ってよい局 (`paidAllowed`) でなければ、理由を付けた文を返す。
 * 無料の番組と、番組表に無い番組は null
 */
export function reserveWarning(
  programId: number,
  now = Date.now(),
): string | null {
  const program = orm()
    .select({ serviceId: programs.service_id, isFree: programs.is_free })
    .from(programs)
    .where(eq(programs.id, programId))
    .get();
  if (program === undefined || program.isFree) return null;
  if (paidAllowed(now)(program.serviceId)) return null;
  // カードが複数あれば、期限切れ → 未契約 → 確かめていない の順に強いほうを出す
  const statuses = serviceContracts(program.serviceId, now);
  const tail = "録画がスクランブルのまま残ることがあります";
  if (statuses.has("expired"))
    return `予約しました。この局は契約の期限が切れているため、${tail}`;
  if (statuses.has("unsubscribed"))
    return `予約しました。この局は未契約のため、${tail}`;
  // 行が無い、カードに聞けず復号の結果も無いか古い
  return `予約しました。この局の契約を確かめていないため、${tail}。設定の「受信」にある「有料契約を確認」で確かめられます`;
}

/** 局の契約の状態 (カードごと)。決め方はダイアログと同じ (`contractStatus`)。行が無ければ空 */
function serviceContracts(
  serviceId: number,
  now = Date.now(),
): Set<ContractStatus> {
  return new Set(
    orm()
      .select({
        state: cardContracts.state,
        code: cardContracts.code,
        decodeOk: cardContracts.decode_ok,
        decodedAt: cardContracts.decoded_at,
      })
      .from(cardContracts)
      .where(eq(cardContracts.service_id, serviceId))
      .all()
      .map((row) => contractStatus(row, now)),
  );
}

/**
 * **ライブで局の映像・音声がスクランブルされたまま届いたときの文** (`live.ts`)。
 *
 * エージェントは、カードが鍵を返さなかった (未契約の) ES をスクランブルされたまま流す。カードを読めないときも同じ形で届くので、
 * 先にカードの状態で分ける。読めているなら、残る理由は契約。期限切れと分かっている局はそう言い、契約中と確かめた局は
 * カードが鍵を返さなかったことだけを言う。それ以外 (未契約・確かめていない・行が無い) は契約されていないと言う。
 * B-CAS 以外の方式の局は、選局する前に断っている (`services.decodable`)
 *
 * @param cardReadable エージェントがカードを読めているか (`CardStatus.ok`)
 * @param statuses その局の契約の状態 (`serviceContracts`)
 */
export function scrambledLiveMessage(
  cardReadable: boolean,
  statuses: ReadonlySet<ContractStatus>,
): string {
  const tail = "スクランブルを復号できませんでした";
  if (!cardReadable) return `B-CAS カードを読めないため、${tail}`;
  if (statuses.has("expired"))
    return `この局は契約の期限が切れているため、${tail}`;
  if (statuses.size > 0 && [...statuses].every((s) => s === "subscribed"))
    return `カードが鍵を返さないため、${tail}`;
  return `この局は契約されていないため、${tail}`;
}

/** `scrambledLiveMessage` を、いまのカードと契約の状態で */
export async function scrambledLiveNotice(serviceId: number): Promise<string> {
  const card = await cardStatus();
  return scrambledLiveMessage(card.ok, serviceContracts(serviceId));
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
