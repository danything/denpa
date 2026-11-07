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
import { store, stored } from "./settings";
import { openChannelStream } from "./tuner";

export interface ConfirmResult {
  ok: boolean;
  code: number;
  error?: string | undefined;
}

export type ContractState =
  "subscribed" | "unsubscribed" | "expired" | "unknown";

export type ContractSource = "eit_ca" | "decode" | "manual";

export type ContractProviderId = "wowow" | "japanet" | "skyperfect" | "other";

export interface ContractProviderInfo {
  id: ContractProviderId;
  name: string;
}

export const CONTRACT_PROVIDERS: Record<
  ContractProviderId,
  ContractProviderInfo
> = {
  wowow: { id: "wowow", name: "WOWOW" },
  japanet: { id: "japanet", name: "BS10 (ジャパネット)" },
  skyperfect: { id: "skyperfect", name: "スカパー！" },
  other: { id: "other", name: "その他" },
};

/**
 * サービス ID (内部ID: networkId * 100000 + serviceId) から ARIB サービス番号を抽出する
 */
function getAribServiceId(internalId: number): number {
  return internalId % 100000;
}

/**
 * サービス ID や種別から契約管理事業者 (WOWOW / ジャパネット / スカパー！ 等) を判別する。
 */
export function getContractProvider(
  internalId: number,
  type?: string,
  name?: string,
): ContractProviderInfo {
  const serviceId = getAribServiceId(internalId);
  if (
    serviceId === 191 ||
    serviceId === 192 ||
    serviceId === 193 ||
    (name && name.includes("WOWOW") && !name.includes("プラス"))
  ) {
    return CONTRACT_PROVIDERS.wowow;
  }
  if (
    serviceId === 201 ||
    (name && (name.includes("BS10") || name.includes("スターチャンネル")))
  ) {
    return CONTRACT_PROVIDERS.japanet;
  }
  // BSの有料局は 234 以降。CSはすべてスカパー。
  if (type === "CS" || (type === "BS" && serviceId >= 234)) {
    return CONTRACT_PROVIDERS.skyperfect;
  }
  return CONTRACT_PROVIDERS.other;
}

export interface ContractSettings {
  /** 契約期限・予告の案内表示モード */
  modalMode: "modal" | "banner" | "none";
  /** 契約意志のある局 (内部サービスID の配列)。null なら全有料局を対象とする */
  intendedServiceIds: number[] | null;
  /** 深夜などの定期復号スキャンを有効にするか */
  periodicScanEnabled: boolean;
  /** 定期スキャン開始時刻 (HH:MM、例: "03:00") */
  periodicScanStart: string;
  /** 定期スキャン終了時刻 (HH:MM、例: "06:00") */
  periodicScanEnd: string;
}

export function getContractSettings(): ContractSettings {
  const modalRaw = stored("contract_modal_mode");
  const intendedRaw = stored("contract_intended_services");
  const periodicRaw = stored("contract_periodic_scan_enabled");
  const scanStart = stored("contract_periodic_scan_start") || "03:00";
  const scanEnd = stored("contract_periodic_scan_end") || "06:00";

  let intendedServiceIds: number[] | null = null;
  if (intendedRaw) {
    try {
      const parsed = JSON.parse(intendedRaw);
      if (Array.isArray(parsed)) {
        intendedServiceIds = parsed.map(Number);
      }
    } catch {
      intendedServiceIds = null;
    }
  }

  return {
    modalMode:
      modalRaw === "banner" || modalRaw === "none" ? modalRaw : "modal",
    intendedServiceIds,
    periodicScanEnabled: periodicRaw === "1" || periodicRaw === "true",
    periodicScanStart: scanStart,
    periodicScanEnd: scanEnd,
  };
}

export function saveContractSettings(
  patch: Partial<ContractSettings>,
): ContractSettings {
  if (patch.modalMode !== undefined) {
    store("contract_modal_mode", patch.modalMode);
  }
  if (patch.intendedServiceIds !== undefined) {
    store(
      "contract_intended_services",
      patch.intendedServiceIds === null
        ? ""
        : JSON.stringify(patch.intendedServiceIds),
    );
  }
  if (patch.periodicScanEnabled !== undefined) {
    store(
      "contract_periodic_scan_enabled",
      patch.periodicScanEnabled ? "1" : "0",
    );
  }
  if (patch.periodicScanStart !== undefined) {
    store("contract_periodic_scan_start", patch.periodicScanStart);
  }
  if (patch.periodicScanEnd !== undefined) {
    store("contract_periodic_scan_end", patch.periodicScanEnd);
  }
  return getContractSettings();
}

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
  source: ContractSource | null;
  manualState: "subscribed" | "unsubscribed" | "unknown" | null;
  code: number | null;
  validUntil: number | null;
  decodeOk: boolean | null;
  checkedAt: number;
  /** この局で利用可能な契約確認方式 */
  availableMethods?: ContractSource[];
  /** 契約管理事業者 */
  providerId: ContractProviderId;
  providerName: string;
  /** 契約意志の対象局か (ユーザーが監視・録画対象に選択しているか) */
  isIntended: boolean;
}

export interface EvaluationInput {
  manualState?: "subscribed" | "unsubscribed" | "unknown" | null | undefined;
  code?: number | null | undefined;
  validUntil?: number | null | undefined;
  decodeOk?: boolean | null | undefined;
  decodedAt?: number | null | undefined;
  hasEitCa?: boolean | undefined;
}

export interface EvaluationResult {
  state: ContractState;
  source: ContractSource | null;
}

/**
 * 契約確認方式の抽象化と優先順位判定を行うチェッカー。
 *
 * 優先順位:
 * 1. 手動設定 (manual): ユーザーが明示的に契約中/未契約/未確認に設定したもの
 * 2. カード確認 (eit_ca): EIT の 0xCB 記述子と B-CAS カード (0x90 0x3C)
 * 3. 実ストリーム復号テスト (decode): TS パケットのスクランブルビット検査
 * 4. 未確認 (unknown): いずれも確かめられていない
 */
export const ContractChecker = {
  /**
   * 優先順位ルールに従って局の契約状態と判定元を決定する。
   */
  evaluate(input: EvaluationInput, nowMs = Date.now()): EvaluationResult {
    // 1. 手動設定
    if (input.manualState != null) {
      return {
        state: input.manualState,
        source: "manual",
      };
    }

    // 2. カード確認 (0x3C コード)
    if (input.code !== null && input.code !== undefined) {
      if (isCodeSubscribed(input.code)) {
        return { state: "subscribed", source: "eit_ca" };
      }
      if (
        input.validUntil !== null &&
        input.validUntil !== undefined &&
        input.validUntil < nowMs
      ) {
        return { state: "expired", source: "eit_ca" };
      }
      return { state: "unsubscribed", source: "eit_ca" };
    }

    // 3. 復号テスト (decode)
    if (input.decodeOk === true) {
      if (freshDecode(input.decodedAt, nowMs)) {
        return { state: "subscribed", source: "decode" };
      }
      // 31 日を経過した場合は契約中とみなさず未確認
      return { state: "unknown", source: "decode" };
    }
    if (input.decodeOk === false) {
      return { state: "unsubscribed", source: "decode" };
    }

    // 4. 未確認
    return {
      state: "unknown",
      source: input.hasEitCa ? "eit_ca" : null,
    };
  },

  /**
   * 局ごとに利用可能な契約確認方式を返す。
   */
  getAvailableMethods(hasEitCa: boolean): ContractSource[] {
    const methods: ContractSource[] = [];
    if (hasEitCa) {
      methods.push("eit_ca");
    }
    methods.push("decode");
    methods.push("manual");
    return methods;
  },
};

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

  // 既存の契約レコード（前回の復号結果や手動設定等）を取得して保持する
  const existingContracts = orm()
    .select({
      serviceId: cardContracts.service_id,
      state: cardContracts.state,
      manualState: cardContracts.manual_state,
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
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
        // 今日は観られる。1 週間以内に切れても契約中のままにし、期限の日だけ覚える
        if (!(await valid(7)))
          // 期限日の翌日 0 時 (JST) が満了
          validUntil = fromMjd(todayMjd + (await lastValid(0, 7)) + 1);
      } else if (await valid(-30)) {
        // 30 日のうちに切れた
        validUntil = fromMjd(todayMjd + (await lastValid(-30, 0)) + 1);
      }
    }

    const evaluated = ContractChecker.evaluate(
      {
        manualState: existing?.manualState,
        code,
        validUntil,
        decodeOk: existing?.decodeOk,
        decodedAt: existing?.decodedAt,
        hasEitCa: Boolean(verification),
      },
      nowMs,
    );

    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: serviceId,
        state: evaluated.state,
        source: evaluated.source,
        manual_state: existing?.manualState ?? null,
        code,
        valid_until: validUntil,
        decode_ok: existing?.decodeOk ?? null,
        decoded_at: existing?.decodedAt ?? null,
        checked_at: nowMs,
      })
      .onConflictDoUpdate({
        target: [cardContracts.card_id, cardContracts.service_id],
        set: {
          state: evaluated.state,
          source: evaluated.source,
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
  const contractSettings = getContractSettings();

  // 0xCB (CA 契約情報) を持つ有料局の一覧を取得
  const servicesWithEitCa = new Set(
    orm()
      .select({ serviceId: programs.service_id })
      .from(programs)
      .where(
        and(
          eq(programs.is_free, false),
          sql`${programs.contract_verification} IS NOT NULL`,
        ),
      )
      .all()
      .map((p) => p.serviceId),
  );

  const rawRows = orm()
    .select({
      cardId: cardContracts.card_id,
      serviceId: cardContracts.service_id,
      serviceName: services.name,
      channel: services.channel,
      type: services.type,
      state: cardContracts.state,
      source: cardContracts.source,
      manualState: cardContracts.manual_state,
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

  let rows: ContractRow[] = rawRows.map((row) => {
    const provider = getContractProvider(
      row.serviceId,
      row.type,
      row.serviceName,
    );
    const isIntended =
      contractSettings.intendedServiceIds === null
        ? true
        : contractSettings.intendedServiceIds.includes(row.serviceId);
    return {
      ...row,
      availableMethods: ContractChecker.getAvailableMethods(
        servicesWithEitCa.has(row.serviceId),
      ),
      providerId: provider.id,
      providerName: provider.name,
      isIntended,
    };
  });

  // 1. WOWOW の 3 局連動同期 (同一の直契約)
  // WOWOW の代表局 (プライム/ライブ/シネマ) でカード確認 (eit_ca) ができている場合、
  // 手動設定や独自のコードが無い他の WOWOW 局も同一契約として同期する
  const wowowRep = rows.find(
    (r) =>
      r.providerId === "wowow" &&
      r.source === "eit_ca" &&
      (r.code !== null || r.validUntil !== null),
  );
  if (wowowRep) {
    rows = rows.map((r) => {
      if (r.providerId === "wowow" && r.manualState == null && r.code == null) {
        return {
          ...r,
          state: wowowRep.state,
          source: "eit_ca",
          validUntil: wowowRep.validUntil,
        };
      }
      return r;
    });
  }

  // 2. スカパー！の一括同期 (contractSettings.skyperfectSync が true の場合)
  // スカパー！の代表局 (スカチャン1 等) でカード契約が確認できている場合、
  // 手動設定されていない他のスカパー局も同一の契約状態・期限とみなす
  if (contractSettings.skyperfectSync) {
    const skyRep = rows.find(
      (r) =>
        r.providerId === "skyperfect" &&
        r.source === "eit_ca" &&
        (r.code !== null || r.validUntil !== null),
    );
    if (skyRep) {
      rows = rows.map((r) => {
        if (
          r.providerId === "skyperfect" &&
          r.manualState == null &&
          r.code == null
        ) {
          return {
            ...r,
            state: skyRep.state,
            source: "eit_ca",
            validUntil: skyRep.validUntil,
          };
        }
        return r;
      });
    }
  }

  return rows;
}

/**
 * 復号テストの結果を `card_contracts` に書く。
 *
 * 優先順位ルールに従い、手動設定がある行やカード確認コードがある行は
 * その状態を維持し、復号テスト結果 (decode_ok, decoded_at) のみを更新する。
 */
function recordDecode(
  cardId: string,
  serviceId: number,
  decodeOk: boolean,
): void {
  const now = Date.now();
  const existing = orm()
    .select({
      state: cardContracts.state,
      source: cardContracts.source,
      manualState: cardContracts.manual_state,
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
    })
    .from(cardContracts)
    .where(
      and(
        eq(cardContracts.card_id, cardId),
        eq(cardContracts.service_id, serviceId),
      ),
    )
    .get();

  const countRes = orm()
    .select({ count: sql<number>`count(*)` })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        eq(programs.is_free, false),
        sql`${programs.contract_verification} IS NOT NULL`,
      ),
    )
    .get();
  const hasEitCa = (countRes?.count ?? 0) > 0;

  let state: ContractState;
  let source: ContractSource | null;

  if (existing?.manualState != null) {
    state = existing.manualState;
    source = "manual";
  } else if (existing?.code !== null && existing?.code !== undefined) {
    // カードが答えた行 (code あり) は状態を変えない (カードの答えを信じる)
    state = existing.state;
    source = existing.source ?? "eit_ca";
  } else {
    const evaluated = ContractChecker.evaluate(
      {
        decodeOk,
        decodedAt: decodeOk ? now : null,
        hasEitCa,
      },
      now,
    );
    state = evaluated.state;
    source = evaluated.source;
  }

  orm()
    .insert(cardContracts)
    .values({
      card_id: cardId,
      service_id: serviceId,
      state,
      source,
      manual_state: existing?.manualState ?? null,
      code: existing?.code ?? null,
      valid_until: existing?.validUntil ?? null,
      decode_ok: decodeOk,
      decoded_at: decodeOk ? now : null,
      checked_at: now,
    })
    .onConflictDoUpdate({
      target: [cardContracts.card_id, cardContracts.service_id],
      set: {
        state,
        source,
        decode_ok: decodeOk,
        decoded_at: decodeOk ? now : null,
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
  const settings = getContractSettings();
  // 契約意志リストが設定されており、対象外となっている有料局は警告を出さない
  if (
    settings.intendedServiceIds !== null &&
    !settings.intendedServiceIds.includes(serviceId)
  ) {
    return null;
  }
  if (paidAllowed()(serviceId)) return null;
  const states = orm()
    .select({ state: cardContracts.state })
    .from(cardContracts)
    .where(eq(cardContracts.service_id, serviceId))
    .all()
    .map((row) => row.state);
  if (states.length === 0 || states.includes("subscribed")) return null;
  return states.includes("expired") ? "expired" : "unsubscribed";
}

export interface ContractNotice {
  providerId: ContractProviderId;
  providerName: string;
  mode: "modal" | "banner";
  channels: {
    serviceId: number;
    name: string;
    validUntil: number;
  }[];
}

/**
 * 1 週間以内に契約期限が切れる局を事業者ごとにまとめた案内情報を取得する。
 * contract_modal_mode が "none" の場合は空配列を返す。
 */
export function getExpiringContractNotices(now = Date.now()): ContractNotice[] {
  const settings = getContractSettings();
  if (settings.modalMode === "none") return [];

  const oneWeekLater = now + 7 * 86_400_000;
  const rows = orm()
    .select({
      serviceId: cardContracts.service_id,
      name: services.name,
      type: services.type,
      validUntil: cardContracts.valid_until,
      state: cardContracts.state,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(
      and(
        sql`${cardContracts.valid_until} IS NOT NULL`,
        gt(cardContracts.valid_until, now),
        lte(cardContracts.valid_until, oneWeekLater),
      ),
    )
    .all();

  // 契約意志リストがある場合、対象外の局は除外
  const intendedSet =
    settings.intendedServiceIds !== null
      ? new Set(settings.intendedServiceIds)
      : null;

  const providerMap = new Map<
    ContractProviderId,
    {
      providerName: string;
      channels: { serviceId: number; name: string; validUntil: number }[];
    }
  >();

  for (const row of rows) {
    if (intendedSet && !intendedSet.has(row.serviceId)) continue;
    if (row.validUntil === null) continue;

    const provider = getContractProvider(row.serviceId, row.type, row.name);
    let entry = providerMap.get(provider.id);
    if (!entry) {
      entry = { providerName: provider.name, channels: [] };
      providerMap.set(provider.id, entry);
    }
    if (!entry.channels.some((c) => c.serviceId === row.serviceId)) {
      entry.channels.push({
        serviceId: row.serviceId,
        name: row.name,
        validUntil: row.validUntil,
      });
    }
  }

  const notices: ContractNotice[] = [];
  for (const [providerId, data] of providerMap.entries()) {
    if (data.channels.length > 0) {
      notices.push({
        providerId,
        providerName: data.providerName,
        mode: settings.modalMode,
        channels: data.channels,
      });
    }
  }
  return notices;
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
 * 手動設定で契約中 (`manualState === 'subscribed'`) にされた局も契約中として許可する。
 * 1 回の当てはめで 1 回だけ読む (呼ぶ側が関数を使い回す)
 */
export function paidAllowed(now = Date.now()): (serviceId: number) => boolean {
  const contractSettings = getContractSettings();
  const rows = orm()
    .select({
      serviceId: cardContracts.service_id,
      manualState: cardContracts.manual_state,
      state: cardContracts.state,
      code: cardContracts.code,
      decodedAt: cardContracts.decoded_at,
      serviceType: services.type,
      serviceName: services.name,
    })
    .from(cardContracts)
    .leftJoin(services, eq(services.id, cardContracts.service_id))
    .where(eq(cardContracts.state, "subscribed"))
    .all();

  const subscribed = new Set<number>();
  let wowowSubscribed = false;
  let skyperfectSubscribed = false;

  for (const row of rows) {
    if (row.manualState === "unsubscribed") continue;
    const isDirectlyAllowed =
      row.manualState === "subscribed" ||
      row.code !== null ||
      freshDecode(row.decodedAt, now);

    if (isDirectlyAllowed) {
      subscribed.add(row.serviceId);
      const provider = getContractProvider(
        row.serviceId,
        row.serviceType ?? undefined,
        row.serviceName ?? undefined,
      );
      if (provider.id === "wowow") {
        wowowSubscribed = true;
      }
      if (
        provider.id === "skyperfect" &&
        (row.code !== null || freshDecode(row.decodedAt, now))
      ) {
        skyperfectSubscribed = true;
      }
    }
  }

  // WOWOW 連動 または スカパー！一括同期
  if (wowowSubscribed || skyperfectSubscribed) {
    const candidateServices = orm()
      .select({
        id: services.id,
        type: services.type,
        name: services.name,
      })
      .from(services)
      .where(inArray(services.type, ["BS", "CS"]))
      .all();

    const manualUnsubscribed = new Set(
      orm()
        .select({ serviceId: cardContracts.service_id })
        .from(cardContracts)
        .where(eq(cardContracts.manual_state, "unsubscribed"))
        .all()
        .map((r) => r.serviceId),
    );

    if (wowowSubscribed) {
      for (const s of candidateServices) {
        if (manualUnsubscribed.has(s.id)) continue;
        if (getContractProvider(s.id, s.type, s.name).id === "wowow") {
          subscribed.add(s.id);
        }
      }
    }

    if (skyperfectSubscribed) {
      for (const s of candidateServices) {
        if (manualUnsubscribed.has(s.id)) continue;
        if (getContractProvider(s.id, s.type, s.name).id === "skyperfect") {
          subscribed.add(s.id);
        }
      }
    }
  }

  // 契約意志リスト (intendedServiceIds) が明示されている場合、
  // 契約意志のない局は録画許可の対象外にする
  if (contractSettings.intendedServiceIds !== null) {
    const intendedSet = new Set(contractSettings.intendedServiceIds);
    for (const sid of Array.from(subscribed)) {
      if (!intendedSet.has(sid)) {
        subscribed.delete(sid);
      }
    }
  }

  return (serviceId) => subscribed.has(serviceId);
}

/**
 * **有料の番組の録画が、復号し直しても掛かったまま終わった。** 復号テストで契約中としていた局を未契約に下げる
 * (`encoder.ts`)。契約が切れたあとも 31 日待たずに、次の回から録らなくなる。
 *
 * 下げるのは、カードに聞けない局 (`code` が無い行) かつ手動設定されていない行だけ。
 * 手動設定された行やカードが契約中と答えた局は勝手に下げない。
 */
export function noteStillScrambled(serviceId: number): void {
  orm()
    .update(cardContracts)
    .set({
      state: "unsubscribed",
      source: "decode",
      decode_ok: false,
      decoded_at: null,
      checked_at: Date.now(),
    })
    .where(
      and(
        eq(cardContracts.service_id, serviceId),
        eq(cardContracts.state, "subscribed"),
        isNull(cardContracts.code),
        isNull(cardContracts.manual_state),
      ),
    )
    .run();
}

/**
 * 対象局の契約状態を手動設定 (manual override) または解除する。
 *
 * manualState に null を指定すると手動設定が解除され、自動判定 (カード確認または復号テスト) の結果に戻る。
 */
export async function setManualContract(
  serviceId: number,
  manualState: "subscribed" | "unsubscribed" | "unknown" | null,
): Promise<{
  ok: boolean;
  row?: ContractRow | undefined;
  error?: string | undefined;
}> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) {
    return {
      ok: false,
      error: "B-CAS カードが認識されていません",
    };
  }

  const targetService = orm()
    .select({ id: services.id })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();

  if (!targetService) {
    return {
      ok: false,
      error: `局が見つかりません (serviceId: ${serviceId})`,
    };
  }

  const existing = orm()
    .select({
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .where(
      and(
        eq(cardContracts.card_id, cardId),
        eq(cardContracts.service_id, serviceId),
      ),
    )
    .get();

  const countRes = orm()
    .select({ count: sql<number>`count(*)` })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        eq(programs.is_free, false),
        sql`${programs.contract_verification} IS NOT NULL`,
      ),
    )
    .get();
  const hasEitCa = (countRes?.count ?? 0) > 0;

  const now = Date.now();
  const evaluated = ContractChecker.evaluate(
    {
      manualState,
      code: existing?.code,
      validUntil: existing?.validUntil,
      decodeOk: existing?.decodeOk,
      decodedAt: existing?.decodedAt,
      hasEitCa,
    },
    now,
  );

  orm()
    .insert(cardContracts)
    .values({
      card_id: cardId,
      service_id: serviceId,
      state: evaluated.state,
      source: evaluated.source,
      manual_state: manualState,
      code: existing?.code ?? null,
      valid_until: existing?.validUntil ?? null,
      decode_ok: existing?.decodeOk ?? null,
      decoded_at: existing?.decodedAt ?? null,
      checked_at: now,
    })
    .onConflictDoUpdate({
      target: [cardContracts.card_id, cardContracts.service_id],
      set: {
        state: evaluated.state,
        source: evaluated.source,
        manual_state: manualState,
        checked_at: now,
      },
    })
    .run();

  const rows = getContractRows(cardId);
  const row = rows.find((r) => r.serviceId === serviceId);
  return { ok: true, row };
}
