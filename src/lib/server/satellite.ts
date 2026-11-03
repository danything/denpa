/**
 * **衛星 (BS・CS) のチャンネルの一覧を、放送の NIT から作る。**
 *
 * 衛星の NIT にはネットワークの全部の TS (TSID・周波数・サービスの一覧) が載っていて、BS はほかの TS の
 * 局名 (SDT[other]) も流れている。市販のテレビと同じく、中継器に 1 回合わせて読めば一覧がそろう。
 * 中継器を 1 つずつ当たる総当たりは要らない (本番の BS は 2 秒で NIT がそろい、10 秒で 26 TS・39 局の名前がそろった)。
 *
 * - **チャンネルの名前は中継器と TSID** (`BS15:16625`)。エージェントは名前だけで選局する (`ChannelTable.cs`)。
 *   相対の番号 (`BS15_0`) は予告なしに詰められることがあり (2025-02)、NIT にも載らないので使わない
 * - **入口は規格の周波数の中継器。** 中継器の周波数は再編でも変わらない。CATV で一部の中継器しか通らない家のために、
 *   候補を 3 つ持つ (`ENTRANCES`)
 * - **CS はネットワークが 2 つ** (6 と 7)。NIT[other] にもう片方の TS と周波数は載るがサービスの一覧が無く、
 *   SDT[other] も自分のネットワークの分だけ (本番で確かめた)。なので、もう片方のネットワークの中継器も 1 つ開く。
 *   NIT[other] は NIT[actual] と別に流れてくるので、そろうまで待つ (待たずに打ち切ると、もう片方のネットワークが丸ごと落ちる)。
 *   読めなかったネットワークは今のチャンネルを残し、欠けた一覧で置き換えない
 *
 * NIT は「放送されているもの」で「その家で受信できるもの」ではない。受信できない中継器が混ざりうる。
 */

import { EpgReader } from "@danything/arib/eit";
import {
  type Network,
  NitReader,
  SdtReader,
  SERVICE_TYPES,
  type ServiceTable,
} from "@danything/arib/psi";

import type { AgentChannel } from "./tuner";

export type SatelliteType = "BS" | "CS";

/**
 * NIT を読みに最初に合わせる中継器。**前から順に、NIT がそろうまで試す。**
 *
 * BS-15 は NHK BS の中継器で、2018 年からの再編でも動いていない。CS-2 はネットワーク 6、CS-4 はネットワーク 7
 * (本番で確かめた)。どれも規格の周波数で、再編で変わるのは中身だけ
 */
const ENTRANCES: Record<SatelliteType, readonly string[]> = {
  BS: ["BS15", "BS01", "BS03"],
  CS: ["CS02", "CS04", "CS08"],
};

/**
 * 中継器の周波数 (kHz。放送の周波数)。BS は奇数で 38.36 MHz 刻み、CS は偶数で 40 MHz 刻み (ARIB STD-B20)。
 * エージェントの選局表 (`ChannelTable.cs`) が使う中間周波数は、これから 10678 MHz を引いたもの
 */
const BAND: Record<
  SatelliteType,
  { first: number; base: number; step: number; max: number }
> = {
  BS: { first: 1, base: 11_727_480, step: 38_360, max: 23 },
  CS: { first: 2, base: 12_291_000, step: 40_000, max: 24 },
};

/** BCD の丸めのぶん。NIT は 10 kHz 単位で書く */
const TOLERANCE = 1_000;

/**
 * 周波数から中継器の番号を出す。**その種別の中継器でなければ null。**
 * BS-7 と BS-17 (4K/8K。ISDB-S3) も null。この構成のチューナーでは受からない
 */
export function transponderOf(
  type: SatelliteType,
  frequency: number,
): number | null {
  const { first, base, step, max } = BAND[type];
  const index = Math.round((frequency - base) / step);
  if (index < 0 || Math.abs(base + index * step - frequency) > TOLERANCE)
    return null;
  const number = first + index * 2;
  if (number > max) return null;
  if (type === "BS" && (number === 7 || number === 17)) return null;
  return number;
}

/** チャンネルの名前。TSID を付ければその TS、付けなければ中継器の先頭の TS (入口) */
export function channelName(
  type: SatelliteType,
  transponder: number,
  transportStreamId?: number,
): string {
  const head = `${type}${String(transponder).padStart(2, "0")}`;
  return transportStreamId === undefined
    ? head
    : `${head}:${transportStreamId}`;
}

/** 今の書き方 (`BS15:16625`) の名前か。前のバージョンの相対の番号 (`BS15_0`)・TSID の無い CS (`CS02`) は false */
export function isLineupName(name: string): boolean {
  return /^(?:BS|CS)\d{2}:\d{1,5}$/.test(name);
}

/**
 * NIT と SDT から、その種別のチャンネルの一覧を作る。
 *
 * - 読むのは NIT[actual] (自分のネットワークの表) だけ。NIT[other] にはサービスの一覧が無い
 * - 局名は SDT (actual と other) から。放送に名前が無かった局は `known` (前の控えの名前)、それも無ければ
 *   `BS 101` のように種別とサービス ID で埋める (番組表の列見出しを空にしない)
 * - 中継器の周波数として読めない TS (4K/8K・ほかの種別) は入れずに `skipped` に返す
 */
export function lineupFrom(
  type: SatelliteType,
  networks: readonly Network[],
  tables: readonly ServiceTable[],
  known: ReadonlyMap<string, string> = new Map(),
): { channels: AgentChannel[]; skipped: number[] } {
  const names = new Map<string, string>();
  for (const table of tables) {
    for (const service of table.services) {
      if (service.name === "") continue;
      names.set(
        nameKey(
          table.originalNetworkId,
          table.transportStreamId,
          service.serviceId,
        ),
        service.name,
      );
    }
  }

  const channels = new Map<string, AgentChannel>();
  const skipped: number[] = [];
  for (const network of networks) {
    if (network.other) continue;
    for (const ts of network.transportStreams) {
      const transponder =
        ts.delivery?.kind === "satellite"
          ? transponderOf(type, ts.delivery.frequency)
          : null;
      if (transponder === null) {
        skipped.push(ts.transportStreamId);
        continue;
      }
      const channel = channelName(type, transponder, ts.transportStreamId);
      channels.set(channel, {
        type,
        channel,
        networkId: network.networkId,
        transportStreamId: ts.transportStreamId,
        remoteControlKeyId: null,
        services: ts.services
          .filter((service) => SERVICE_TYPES.has(service.serviceType))
          .map((service) => ({
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            name:
              names.get(
                nameKey(
                  ts.originalNetworkId,
                  ts.transportStreamId,
                  service.serviceId,
                ),
              ) ??
              known.get(serviceKeyOf(network.networkId, service.serviceId)) ??
              `${type} ${service.serviceId}`,
          }))
          .sort((a, b) => a.serviceId - b.serviceId),
      });
    }
  }
  return {
    channels: [...channels.values()].sort((a, b) =>
      a.channel.localeCompare(b.channel, "en", { numeric: true }),
    ),
    skipped,
  };
}

const nameKey = (onid: number, tsid: number, sid: number) =>
  `${onid}:${tsid}:${sid}`;

/** 前の控えの局名を引く鍵 (`lineupFrom` の `known`) */
const serviceKeyOf = (networkId: number, serviceId: number) =>
  `${networkId}:${serviceId}`;

/** 前の控えから、局名の表を作る (`lineupFrom` の `known`) */
export function knownNames(
  channels: readonly AgentChannel[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const channel of channels) {
    for (const service of channel.services) {
      if (service.name !== "")
        map.set(
          serviceKeyOf(channel.networkId, service.serviceId),
          service.name,
        );
    }
  }
  return map;
}

/** 1 つの中継器を読んだ結果 */
interface TableRead {
  nit: NitReader;
  sdt: SdtReader;
  /** TS が 1 バイトでも来たか。アンテナの問題と読み取りの問題を分ける手掛かり */
  signal: boolean;
  /** 選局が落ちた理由 (エージェントが返したもの)。無ければ空 */
  error: string;
}

/**
 * 流れてくる TS から NIT と SDT を読む。**自分のネットワークの NIT がそろい、そこに載っているテレビの局の
 * 名前が SDT でそろったら打ち切る。** そろわなくても `timeout` で打ち切る (名前は欠けたまま返す)
 *
 * `other` を渡すと、それに当てはまる NIT[other] がそろうまでも待つ。CS はこれでもう片方のネットワークの
 * 中継器を知る。NIT[actual] と NIT[other] は別々に流れてくるので、actual と局名だけで打ち切ると other を読み落とす
 */
export async function readTables(
  stream: ReadableStream<Uint8Array>,
  timeout: number,
  abort?: AbortSignal,
  /** 同じストリームから番組表も取得する (スキャンのついで) */
  epg?: EpgReader,
  other?: (network: Network) => boolean,
): Promise<TableRead> {
  const nit = new NitReader();
  const sdt = new SdtReader();
  const source = stream.getReader();
  let signal = false;
  let error = "";

  let stop = (): void => {};
  const deadline = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const timer = setTimeout(stop, timeout);
  timer.unref?.();
  abort?.addEventListener("abort", stop, { once: true });

  const read = (async () => {
    for (;;) {
      const { done, value } = await source.read();
      if (done || value === undefined) return;
      signal ||= value.byteLength > 0;
      epg?.feed(value);
      // 両方に渡す (`||` でつなぐと、NIT が変わった回に SDT を読み落とす)
      const network = nit.feed(value);
      const names = sdt.feed(value);
      if ((network || names) && settled(nit, sdt, other)) return;
    }
  })().catch((reason: unknown) => {
    error = String(reason).trim().split("\n").at(-1)?.trim() ?? "";
  });

  await Promise.race([read, deadline]);
  clearTimeout(timer);
  abort?.removeEventListener("abort", stop);
  await source.cancel().catch(() => undefined);
  return { nit, sdt, signal, error };
}

/** 自分のネットワークの NIT がそろい、テレビの局の名前が全部そろったか (`other` があれば、その NIT[other] も) */
function settled(
  nit: NitReader,
  sdt: SdtReader,
  other?: (network: Network) => boolean,
): boolean {
  const network = nit.actual;
  if (network === null) return false;
  if (
    other !== undefined &&
    !nit.networks().some((candidate) => candidate.other && other(candidate))
  )
    return false;
  const named = new Set<string>();
  for (const table of sdt.tables()) {
    for (const service of table.services) {
      if (service.name !== "")
        named.add(
          nameKey(
            table.originalNetworkId,
            table.transportStreamId,
            service.serviceId,
          ),
        );
    }
  }
  return network.transportStreams.every((ts) =>
    ts.services
      .filter((service) => service.serviceType === 0x01)
      .every((service) =>
        named.has(
          nameKey(
            ts.originalNetworkId,
            ts.transportStreamId,
            service.serviceId,
          ),
        ),
      ),
  );
}

/** 一覧を作り終えたときの結果 */
export interface Lineup {
  channels: AgentChannel[];
  /** 経過を 1 行ずつ。スキャンのログに出す */
  log: string[];
  /** 読めたネットワーク。1 つも無ければ一覧は作れていない */
  networks: number[];
  /**
   * あるはずなのに読めなかったネットワーク (CS)。前の控えにそのネットワークのチャンネルがあれば、
   * `channels` にそのまま残してある。呼ぶ側は間をあけて読み直す
   */
  missing: number[];
  /** NIT[other] に載っていた、その種別の中継器を持つネットワーク (CS)。NIT[other] を読めなければ空 */
  listed: number[];
}

/** そのネットワークの、その種別の中継器を 1 つ (入口に使う)。載っていなければ null */
function firstTransponder(
  type: SatelliteType,
  network: Network,
): number | null {
  for (const ts of network.transportStreams) {
    if (ts.delivery?.kind !== "satellite") continue;
    const transponder = transponderOf(type, ts.delivery.frequency);
    if (transponder !== null) return transponder;
  }
  return null;
}

/**
 * **その種別の一覧を、入口から NIT を読んで作る。**
 *
 * `open` は中継器を開く (チューナーの空き待ちは呼ぶ側)。BS は入口を 1 つ読めば足りる。CS は、読んだ NIT[other] に
 * 載っているまだ読んでいないネットワークの中継器を、ネットワークごとに 1 つ開く。NIT[other] を読めなかったときは、
 * 残りの入口も開く (CS-2 と CS-4 はネットワークが違う)。
 *
 * **CS は、ネットワークが欠けた一覧を返さない。** 読めなかったネットワークは `missing` に入れ、`previous` (今の控え)
 * にあったそのネットワークのチャンネルを残す。NIT[other] を読めて、そこに載っていないネットワークは無くなったものとして残さない。
 * 1 つもネットワークが読めなければ、`networks` が空の結果を返す (呼ぶ側は控えを書き換えない)
 */
export async function readLineup(
  type: SatelliteType,
  open: (channel: string) => Promise<ReadableStream<Uint8Array>>,
  options: {
    timeout: number;
    abort?: AbortSignal;
    known?: ReadonlyMap<string, string>;
    /** 今の控えのチャンネル。CS で読めなかったネットワークのぶんを残す */
    previous?: readonly AgentChannel[];
    /** 控えのほかに、あるはずのネットワーク (CS。NIT[other] を読めなかったときに `missing` を決める) */
    expected?: readonly number[];
    /** 読んだ番組表を渡す先 (スキャンのついで) */
    onEvents?: (epg: EpgReader) => void;
    /** 中継器を 1 つ読むたびに、読んだ NIT と SDT を渡す先 (再編に付いていく。`lineup-follow.ts`) */
    onTables?: (nit: NitReader, sdt: SdtReader) => Promise<unknown>;
  },
): Promise<Lineup> {
  const log: string[] = [];
  const networks = new Map<number, Network>();
  const tables: ServiceTable[] = [];
  /** 次に開く中継器。入口の候補から始め、CS はほかのネットワークの中継器を足す */
  const queue: { channel: string; network: number | null }[] = ENTRANCES[
    type
  ].map((channel) => ({ channel, network: null }));
  const tried = new Set<string>();
  /** NIT[other] に載っていた、その種別の中継器を持つネットワーク (CS) */
  const listed = new Set<number>();
  const several = type === "CS";
  /** NIT[other] を読めたか (CS)。読めていなければ、まだ読んでいないネットワークがあるかもしれない */
  const sawOther = () => listed.size > 0;
  /** CS で、まだ読みたいネットワークがあるか */
  const wanting = () =>
    several &&
    (!sawOther() || [...listed].some((network) => !networks.has(network)));
  const otherOfType = several
    ? (network: Network) => firstTransponder(type, network) !== null
    : undefined;

  while (queue.length > 0 && options.abort?.aborted !== true) {
    const job = queue.shift()!;
    // 入口は 1 つ読めたら残りは要らない (CS は、まだ読みたいネットワークがあれば開く)。
    // ネットワークを指した中継器は、そのネットワークがまだのときだけ
    if (job.network === null && networks.size > 0 && !wanting()) continue;
    if (job.network !== null && networks.has(job.network)) continue;
    if (tried.has(job.channel)) continue;
    tried.add(job.channel);

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await open(job.channel);
    } catch (error) {
      log.push(`${job.channel}: ${error}`);
      continue;
    }
    const epg = new EpgReader();
    const read = await readTables(
      stream,
      options.timeout,
      options.abort,
      epg,
      otherOfType,
    );
    const network = read.nit.actual;
    if (network === null) {
      log.push(
        `${job.channel}: ${
          !read.signal
            ? "受信できませんでした"
            : "受信はできましたが、放送の一覧 (NIT) を読み取れません"
        }${read.error === "" ? "" : ` (${read.error})`}`,
      );
      continue;
    }
    options.onEvents?.(epg);
    await options.onTables?.(read.nit, read.sdt);
    networks.set(network.networkId, network);
    tables.push(...read.sdt.tables());
    log.push(
      `${job.channel}: ネットワーク ${network.networkId} の ${network.transportStreams.length} TS を読みました`,
    );

    if (!several) continue;
    for (const other of read.nit.networks()) {
      if (!other.other) continue;
      const transponder = firstTransponder(type, other);
      if (transponder === null) continue;
      listed.add(other.networkId);
      if (networks.has(other.networkId)) continue;
      // 残りの入口より先に開く (目的のネットワークが分かっている)
      queue.unshift({
        channel: channelName(type, transponder),
        network: other.networkId,
      });
    }
  }

  const { channels, skipped } = lineupFrom(
    type,
    [...networks.values()],
    tables,
    options.known,
  );
  if (skipped.length > 0)
    log.push(
      `${type} の中継器として読めない TS を入れませんでした (TSID ${skipped.join(", ")})`,
    );

  const previous = (options.previous ?? []).filter(
    (channel) => channel.type === type,
  );
  const expected = sawOther()
    ? listed
    : new Set([
        ...(options.expected ?? []),
        ...previous.map((channel) => channel.networkId),
      ]);
  const missing = several
    ? [...expected]
        .filter((network) => !networks.has(network))
        .sort((a, b) => a - b)
    : [];
  // 1 つも読めなければ一覧は作れていない (控えを書き換えない)。残すのは読めたネットワークがあるときだけ
  if (networks.size > 0) {
    for (const network of missing) {
      const kept = previous.filter((channel) => channel.networkId === network);
      channels.push(...kept);
      log.push(
        `${type}: ネットワーク ${network} を読めませんでした${
          kept.length === 0
            ? ""
            : `。今のチャンネル (${kept.length} TS) を残します`
        }`,
      );
    }
    channels.sort((a, b) =>
      a.channel.localeCompare(b.channel, "en", { numeric: true }),
    );
  }
  return {
    channels,
    log,
    networks: [...networks.keys()],
    missing,
    listed: [...listed].sort((a, b) => a - b),
  };
}
