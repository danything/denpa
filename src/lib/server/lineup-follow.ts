/**
 * **BS と CS の再編に付いていく。** 市販のテレビと同じく、放送の NIT が変わったら受信できるチャンネルを書き換える
 * (スキャンし直さなくてよい)。
 *
 * - **NIT は番組表集めのついでに読む** (`epg-collect.ts`)。衛星はどの中継器にもネットワークの全部の TS が載っているので、
 *   どれを開いても分かる。version が前に確かめたものと同じなら何もしない
 * - **書き換えるのは、同じ version の変わった一覧を 5 分以上あけて 2 回読んでから。** 放送に古い情報が混ざることがある
 *   (2026-08、NHK のアップリンクから古いチャンネル情報が送られ、一部の市販機で 6 局が選局できなくなった)。
 *   1 回読んだだけでは書き換えない
 * - 書き換えるのはそのネットワークのチャンネルだけ (CS はネットワークが 2 つある)
 * - 予約とルールは局の ID (ネットワーク ID とサービス ID) で持っているので、チャンネルの名前が変わっても外れない。
 *   書き換えたあとの新しいチャンネルは「確認中」で、受信できるかは番組表集めが確かめる (`reception.ts`)
 * - 書き換えたら、お知らせの 1 行 (録画・番組表・ライブの上) と通知 (`channels.changed`) で知らせる
 * - **録画が衛星のチャンネルを選局できなかったら、すぐに読み直す** (`refreshLineup`)。再編の切り替えの直後に録画が
 *   始まると、番組表集めが次に中継器を開くまで待てない
 */
import { NitReader, SdtReader } from "@danything/arib/psi";
import { and, desc, gte, isNull, lt } from "drizzle-orm";

import { config } from "./config";
import { now, orm } from "./db";
import { emit } from "./events";
import {
  knownNames,
  lineupFrom,
  readLineup,
  type SatelliteType,
} from "./satellite";
import { channelChanges } from "./schema";
import {
  type AgentChannel,
  getChannels,
  openChannelStream,
  putChannels,
} from "./tuner";
import { notify } from "./webhook";

/** 書き換えを知らせる 1 行を出しておく長さ */
const NOTICE_FOR = 24 * 60 * 60_000;

/** 書き換えの記録を残す長さ */
const KEEP_FOR = 30 * 24 * 60 * 60_000;

/** 録画の失敗で読み直す間隔 (同じ種別)。録画は失敗すると数秒おきに掛け直す */
const REFRESH_EVERY = 10 * 60_000;

/** 1 中継器を読む上限 (スキャンと同じ) */
const READ_TIMEOUT = 30_000;

/** 確かめた version (`種別:ネットワーク ID`)。同じなら読み比べない */
const checked = new Map<string, number>();

/** 変わった一覧を 1 回目に読んだ version と時刻。`CONFIRM_AFTER` たってからもう 1 回読んだら書き換える */
const sighted = new Map<string, { version: number; at: number }>();

/**
 * 2 回目に数えるまでの間。同じ周回で別の中継器を続けて読んでも、2 回とは数えない
 * (放送の古い情報が、どの中継器にも同じように混ざることがある)
 */
const CONFIRM_AFTER = 5 * 60_000;

/** 種別ごとに 1 つずつ比べる。番組表集めの中継器と録画の読み直しが同時に来ても、二重に書き換えない */
const queues = new Map<SatelliteType, Promise<unknown>>();

/** 最後に録画の失敗で読み直した時刻 (種別ごと) */
const refreshedAt = new Map<SatelliteType, number>();

/** 2 つの一覧の違い。局の ID で比べる */
export interface LineupDiff {
  /** 新しく入った局 */
  added: number;
  /** 無くなった局 */
  removed: number;
  /** チャンネルが変わった局 (中継器や TS を移った) */
  moved: number;
  /** チャンネルの顔ぶれが違うか (局は同じでも TSID が変わったなど) */
  changed: boolean;
}

/**
 * 今の一覧 (`current`) と放送の一覧 (`next`) を比べる。テレビの局 (種別 1) の数を数える。
 * チャンネルの名前と、そこに入っている局が全部同じなら違いは無い
 */
export function lineupDiff(
  current: readonly AgentChannel[],
  next: readonly AgentChannel[],
): LineupDiff {
  const where = (list: readonly AgentChannel[]) => {
    const map = new Map<string, string>();
    for (const channel of list) {
      for (const service of channel.services) {
        if (service.serviceType !== 1) continue;
        map.set(`${channel.networkId}:${service.serviceId}`, channel.channel);
      }
    }
    return map;
  };
  const before = where(current);
  const after = where(next);
  let added = 0;
  let removed = 0;
  let moved = 0;
  for (const [service, channel] of after) {
    const was = before.get(service);
    if (was === undefined) added++;
    else if (was !== channel) moved++;
  }
  for (const service of before.keys()) if (!after.has(service)) removed++;
  const shape = (list: readonly AgentChannel[]) =>
    list
      .map(
        (channel) =>
          `${channel.channel}=${channel.services
            .map((service) => service.serviceId)
            .sort((a, b) => a - b)
            .join(",")}`,
      )
      .sort()
      .join(";");
  return { added, removed, moved, changed: shape(current) !== shape(next) };
}

/** お知らせと通知の 1 行 */
export function changeText(type: SatelliteType, diff: LineupDiff): string {
  const parts = [
    diff.added > 0 ? `新しい局 ${diff.added}` : null,
    diff.removed > 0 ? `終わった局 ${diff.removed}` : null,
    diff.moved > 0 ? `移った局 ${diff.moved}` : null,
  ].filter((part) => part !== null);
  return `${type} のチャンネルが放送で変わったため、受信できるチャンネルを書き換えました${
    parts.length === 0 ? "" : ` (${parts.join("、")})`
  }`;
}

/**
 * 番組表集めで読んだ NIT と SDT を、今の一覧と比べる。**変わっていて、同じものを間をあけて 2 回読んだら書き換える。**
 * 書き換えたら true。同じ種別は 1 つずつ比べる
 */
export function followLineup(
  type: SatelliteType,
  nit: NitReader,
  sdt: SdtReader,
  at = Date.now(),
): Promise<boolean> {
  const run = (queues.get(type) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => compare(type, nit, sdt, at));
  queues.set(type, run);
  return run;
}

async function compare(
  type: SatelliteType,
  nit: NitReader,
  sdt: SdtReader,
  at: number,
): Promise<boolean> {
  const network = nit.actual;
  if (network === null) return false;
  const key = `${type}:${network.networkId}`;
  if (checked.get(key) === network.version) return false;

  const all = await getChannels();
  const mine = all.filter((channel) => channel.type === type);
  const next = lineupFrom(
    type,
    [network],
    sdt.tables(),
    knownNames(all),
  ).channels;
  // 読めた TS が 1 つも無い表は使わない (読み違えで全部消さない)
  if (next.length === 0) return false;
  const current = mine.filter(
    (channel) => channel.networkId === network.networkId,
  );
  const diff = lineupDiff(current, next);
  if (!diff.changed) {
    checked.set(key, network.version);
    sighted.delete(key);
    return false;
  }
  const first = sighted.get(key);
  if (first?.version !== network.version) {
    sighted.set(key, { version: network.version, at });
    console.log(
      `[channels] ${type} の放送の一覧が変わっています (ネットワーク ${network.networkId}、version ${network.version})。もう一度読んで確かめてから書き換えます`,
    );
    return false;
  }
  if (at - first.at < CONFIRM_AFTER) return false;

  await putChannels(
    [
      ...mine.filter((channel) => channel.networkId !== network.networkId),
      ...next,
    ],
    [type],
  );
  checked.set(key, network.version);
  sighted.delete(key);
  record(type, changeText(type, diff));
  return true;
}

/** 書き換えを残して知らせる */
function record(type: SatelliteType, text: string): void {
  const at = now();
  orm()
    .delete(channelChanges)
    .where(lt(channelChanges.at, at - KEEP_FOR))
    .run();
  orm().insert(channelChanges).values({ type, text, at }).run();
  console.log(`[channels] ${text}`);
  notify({ event: "channels.changed", text });
  emit("services");
}

/**
 * **録画が衛星のチャンネルを選局できなかったときに、放送の一覧を読み直す。** 入口の中継器を開いて読み、
 * 変わっていれば `followLineup` と同じ決まりで書き換える (同じ version を 2 回読んでから)。
 * 同じ種別は `REFRESH_EVERY` に 1 回まで
 */
export async function refreshLineup(
  type: SatelliteType,
  at = Date.now(),
): Promise<void> {
  if (at - (refreshedAt.get(type) ?? -Infinity) < REFRESH_EVERY) return;
  refreshedAt.set(type, at);
  await readLineup(
    type,
    (channel) =>
      openChannelStream(
        type,
        channel,
        AbortSignal.timeout(READ_TIMEOUT * 4),
        `scan ${channel}`,
        config.priority.scan,
      ),
    {
      timeout: READ_TIMEOUT,
      onTables: (nit, sdt) => followLineup(type, nit, sdt),
    },
  );
}

/** お知らせの 1 行。書き換えてから `NOTICE_FOR` の間で、設定の「受信」をまだ開いていないもの */
export function lineupNotice(at = now()): string | null {
  const row = orm()
    .select({ text: channelChanges.text })
    .from(channelChanges)
    .where(
      and(
        gte(channelChanges.at, at - NOTICE_FOR),
        isNull(channelChanges.seen_at),
      ),
    )
    .orderBy(desc(channelChanges.at))
    .get();
  return row?.text ?? null;
}

/** 設定の「受信」を開いた。お知らせを消す */
export function seenLineupChanges(at = now()): void {
  orm()
    .update(channelChanges)
    .set({ seen_at: at })
    .where(isNull(channelChanges.seen_at))
    .run();
}

/** 番組表集めが中継器を読むついでに、放送の一覧を読む長さ (BS の SDT[other] は 10 秒ほどでそろう) */
const WATCH_FOR = 20_000;

/**
 * **番組表集めのついでに放送の一覧を読む** (`epg-collect.ts`)。開いてから `WATCH_FOR` の間だけ NIT と SDT を読み、
 * 閉じたら `followLineup` で今の一覧と比べる
 */
export class LineupWatch {
  readonly nit = new NitReader();
  readonly sdt = new SdtReader();
  private readonly until = Date.now() + WATCH_FOR;

  constructor(private readonly type: SatelliteType) {}

  feed(chunk: Uint8Array): void {
    if (Date.now() > this.until) return;
    this.nit.feed(chunk);
    this.sdt.feed(chunk);
  }

  /** 読んだ一覧を今の一覧と比べる。失敗しても番組表集めは止めない */
  follow(): void {
    if (this.nit.actual === null) return;
    void followLineup(this.type, this.nit, this.sdt).catch((error: unknown) => {
      console.warn(
        `[channels] ${this.type} の放送の一覧と見比べられませんでした: ${error}`,
      );
    });
  }
}
