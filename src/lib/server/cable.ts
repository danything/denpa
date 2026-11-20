/**
 * **ケーブル (CATV。ISDB-C) のチャンネルの一覧を、ケーブル局の NIT から作る。**
 *
 * ケーブル局の自主放送の TS には、そのネットワークの NIT[actual] が流れている。TS ごとにケーブルの分配の記述子 (0x44) で
 * 周波数・多重フレーム型式 (TSMF か)・変調が載るので、衛星 (`satellite.ts`) と同じく、1 つの TS で NIT を読めば回す搬送波が決まる。
 * 113 チャンネルの総当たりより選局が少なく、載っている搬送波は「あるはず」と分かるので、ロックしなければ試し直せる。
 *
 * - NIT が流れているのは自主放送の TS だけ。再送信の BS と地上波の TS には元の NIT (ONID 4・地上波) が流れていて、0x44 は無い。
 *   ReMUX の自主放送のネットワーク ID は 0xFFFE で、ケーブル局どうしで同じ値 (ARIB STD-B10 の付録 N)。ネットワーク ID ではケーブル局を見分けられない
 * - 0x44 の並びは推定 (`psi.CableDelivery`)。推定に合わない値 (周波数が範囲の外・変調が 64QAM と 256QAM のほか) の TS は一覧に入れず、記録に出す
 * - 再送信の TS が NIT に載っていなければ (自分のネットワークの TS しか載っていなければ)、一覧に無いチャンネルは総当たりで探す (`scan.ts`)
 * - NIT は「流している搬送波」で「その家で受信できる搬送波」ではない
 */

import type { Network } from "@danything/arib/psi";

import { hex } from "./ca-observe";
import type { AgentChannel } from "./tuner";

/** 選局表の格子の 1 つ。中心周波数 (kHz) は `first` から 6 MHz おき */
interface Band {
  prefix: "QC" | "QU" | "QV";
  min: number;
  max: number;
  first: number;
}

/**
 * ケーブルの選局表の格子。エージェントの `ChannelTable.cs` の `Q` と同じ中心周波数 (kHz)。
 * C22 と VHF 4〜7 は 6 MHz おきの並びから 2 MHz ずれているので、別の行にしてある。並びは総当たりの順 (`catvChannels`)
 */
const BANDS: readonly Band[] = [
  { prefix: "QC", min: 13, max: 21, first: 111_000 },
  { prefix: "QC", min: 22, max: 22, first: 167_000 },
  { prefix: "QC", min: 23, max: 63, first: 225_000 },
  { prefix: "QU", min: 13, max: 62, first: 473_000 },
  { prefix: "QV", min: 1, max: 3, first: 93_000 },
  { prefix: "QV", min: 4, max: 7, first: 173_000 },
  { prefix: "QV", min: 8, max: 12, first: 195_000 },
];

/** 格子の中心とみなすずれ (kHz)。NIT の周波数は 100 Hz 単位で、格子どうしは 6 MHz 離れている */
const TOLERANCE_KHZ = 500;

/** `QC24`〜`QC27` は 2 MHz ずらして送る地域がある。エージェントがずらした周波数も試す (`ChannelTable.cs`) */
const SHIFTED = { prefix: "QC", min: 24, max: 27, shift: 2_000 } as const;

/** 周波数を直に指す名前 (`QF<kHz>`) で選局できる範囲 (kHz)。エージェントの `ChannelTable.cs` と同じ */
const DIRECT = { min: 90_000, max: 770_000 } as const;

/** 変調の値 (ARIB STD-B10 と有線の告示)。ISDB-C で使うのは 64QAM と 256QAM だけ */
const MODULATIONS: Record<number, string> = { 0x03: "64QAM", 0x05: "256QAM" };

/** 多重フレーム型式番号の TSMF (53 スロット・最大 15 TS) */
const FRAME_TSMF = 0x1;

/** 総当たりで選局するチャンネル (113 本)。TSMF で束ねた 2 つ目からの TS (`QC30:1`) は入らない (`scan.tsmfJobs`) */
export function catvChannels(): string[] {
  const names = (prefix: Band["prefix"]) =>
    BANDS.filter((band) => band.prefix === prefix).flatMap(({ min, max }) =>
      Array.from({ length: max - min + 1 }, (_, i) => `${prefix}${min + i}`),
    );
  return [...names("QC"), ...names("QU"), ...names("QV")];
}

/**
 * 周波数 (Hz) から、選局するチャンネルの名前を決める。
 * 格子に合えば今の名前 (`QC27`・`QV9`・`QU20`)、`QC24`〜`QC27` を 2 MHz ずらしたものもその名前、
 * どちらでもなければ周波数を直に指す `QF<kHz>`。選局できる範囲の外なら null
 */
export function cableChannelOf(hertz: number): string | null {
  const khz = hertz / 1000;
  for (const { prefix, min, max, first } of BANDS) {
    const index = Math.round((khz - first) / 6_000);
    if (index < 0 || index > max - min) continue;
    if (Math.abs(first + index * 6_000 - khz) <= TOLERANCE_KHZ)
      return `${prefix}${min + index}`;
  }
  for (let channel = SHIFTED.min; channel <= SHIFTED.max; channel++) {
    const center = 225_000 + 6_000 * (channel - 23) + SHIFTED.shift;
    if (Math.abs(center - khz) <= TOLERANCE_KHZ)
      return `${SHIFTED.prefix}${channel}`;
  }
  const rounded = Math.round(khz);
  if (rounded < DIRECT.min || rounded > DIRECT.max) return null;
  return `QF${rounded}`;
}

/** NIT に載っていた TS の 1 つ */
export interface CableStream {
  transportStreamId: number;
  originalNetworkId: number;
  /** service_list_descriptor に載っていた局 (service_id と種別)。ロックしなかった搬送波の局を入れるのに使う (`listedEntries`) */
  serviceList: { serviceId: number; serviceType: number }[];
}

/** 1 つの搬送波。同じ周波数に TS がいくつも載っていれば TSMF で束ねている */
export interface CableCarrier {
  /** 選局するチャンネルの名前 (`cableChannelOf`)。TSMF の 2 つ目からは `:k` を足す (`lineupJobs`) */
  channel: string;
  /** 周波数 (Hz) */
  frequency: number;
  frameType: number;
  modulation: number;
  symbolRate: number;
  fecOuter: number;
  fecInner: number;
  streams: CableStream[];
}

/** 1 つのネットワークの NIT[actual] から作った一覧 */
export interface CableLineup {
  networkId: number;
  name: string | null;
  version: number;
  carriers: CableCarrier[];
  /** 一覧に入れなかった TS と理由 (記録に出す) */
  skipped: { transportStreamId: number; why: string }[];
  /** 自分のネットワーク以外の ONID (再送信の BS・地上波) の TS も載っていたか。載っていれば総当たりで残りを探さない */
  others: boolean;
  /** NIT のセクションのバイト列。記録に出す */
  sections: Uint8Array[];
}

/**
 * NIT[actual] から、ケーブルの搬送波の一覧を作る。**0x44 の付いた TS が 1 つも無ければ null** (再送信の BS・地上波の NIT)。
 * 推定に合わない値の TS は入れず、`skipped` に理由を書く。入れられる TS が 1 つも無いときも null
 */
export function cableLineupFrom(network: Network): CableLineup | null {
  if (network.other) return null;
  const carriers = new Map<string, CableCarrier>();
  const skipped: CableLineup["skipped"] = [];
  let others = false;
  for (const ts of network.transportStreams) {
    const delivery = ts.delivery;
    if (delivery?.kind !== "cable") continue;
    const channel = cableChannelOf(delivery.frequency);
    const why =
      channel === null
        ? `周波数 ${mhz(delivery.frequency)} MHz は選局できる範囲の外です`
        : MODULATIONS[delivery.modulation] === undefined
          ? `変調 0x${hex2(delivery.modulation)} は ISDB-C の変調ではありません`
          : null;
    if (channel === null || why !== null) {
      skipped.push({ transportStreamId: ts.transportStreamId, why: why! });
      continue;
    }
    if (ts.originalNetworkId !== network.networkId) others = true;
    const carrier = carriers.get(channel) ?? {
      channel,
      frequency: delivery.frequency,
      frameType: delivery.frameType,
      modulation: delivery.modulation,
      symbolRate: delivery.symbolRate,
      fecOuter: delivery.fecOuter,
      fecInner: delivery.fecInner,
      streams: [],
    };
    carrier.streams.push({
      transportStreamId: ts.transportStreamId,
      originalNetworkId: ts.originalNetworkId,
      serviceList: ts.services.map((service) => ({
        serviceId: service.serviceId,
        serviceType: service.serviceType,
      })),
    });
    carriers.set(channel, carrier);
  }
  if (carriers.size === 0) return null;
  return {
    networkId: network.networkId,
    name: network.name ?? null,
    version: network.version,
    carriers: [...carriers.values()].sort((a, b) => a.frequency - b.frequency),
    skipped,
    others,
    sections: network.sections ?? [],
  };
}

/**
 * 一覧から、選局するチャンネルの名前を並べる。TSMF で TS が N 個載っている搬送波は `名前`・`名前:1`…`名前:N-1`。
 * 何本目がどの TSID かは NIT に無い (TSMF のヘッダーにある) ので、選局して読んだ TS で決まる
 */
export function lineupJobs(lineup: CableLineup): string[] {
  return lineup.carriers.flatMap((carrier) => [
    carrier.channel,
    ...Array.from(
      { length: Math.max(carrier.streams.length, 1) - 1 },
      (_, i) => `${carrier.channel}:${i + 1}`,
    ),
  ]);
}

/**
 * **NIT の一覧に無いチャンネルのうち、総当たりの残りとして列の後ろに戻すもの** (`scan.ts` の `adoptCable`)。
 * `pulled` は列から抜いた総当たりの CATV、`seen` は列に入れた・回したチャンネル。
 * 再送信の TS が NIT に載っていなければ全部戻す。載っていれば、前の控え (`previous`) にあるチャンネルだけ戻す。
 * NIT に載らない搬送波 (BS4K の再送信の QC26 など) を回さずにいると、試し直しにも残すのにも入らず消える
 * (`retryableChannel`・`keepUnlocked` は、回してロックしなかったチャンネルだけを見る)
 */
export function restChannels(
  pulled: readonly string[],
  seen: ReadonlySet<string>,
  others: boolean,
  previous: readonly AgentChannel[],
): string[] {
  const before = new Set(previous.map((entry) => entry.channel));
  return pulled.filter(
    (channel) => !seen.has(channel) && (!others || before.has(channel)),
  );
}

/**
 * 読めたケーブル局の NIT に TS が載っているネットワーク (`original_network_id`)。
 * このネットワークの TS で NIT に載っていないものは、無くなった搬送波とみなす (`retryableChannel`)
 */
export function listedNetworks(lineups: readonly CableLineup[]): Set<number> {
  return new Set(
    lineups.flatMap((lineup) =>
      lineup.carriers.flatMap((carrier) =>
        carrier.streams.map((stream) => stream.originalNetworkId),
      ),
    ),
  );
}

/**
 * **ロックしなかったチャンネルを、試し直して残す搬送波として扱うか。** NIT に載っているチャンネル (`listed`) と、
 * 前の控えにあるチャンネルのうち、NIT に TS が載っていないネットワークのもの。
 * BS4K の再送信の TLV (QC26。ONID 0x000B) は J:COM の NIT に載っておらず、NIT に載っているネットワークでないので、無くなったとはみなさない
 */
export function retryableChannel(
  channel: string,
  listed: ReadonlySet<string>,
  previous: readonly AgentChannel[],
  networks: ReadonlySet<number>,
): boolean {
  if (listed.has(channel)) return true;
  return previous.some(
    (entry) => entry.channel === channel && !networks.has(entry.networkId),
  );
}

/**
 * **NIT に載っているのにロックしなかった TS を、NIT の service_list_descriptor からチャンネルにする。** 作るのは `unlocked` (ロックしなかった、かつ局が見つかっていないチャンネル) だけ。ロックしたのに局が無かったチャンネルは作らない。
 * 局は service_list_descriptor の service_id と種別で、残す種別は `keep` (`psi.SERVICE_TYPES`)。局名は NIT に無いので、
 * 前の控えの名前 (`known`。`${original_network_id}:${service_id}`) か、無ければ仮の名前 (`unnamed`)。
 * 番組表の取得がその TS の SDT[actual] を受信したら、仮の名前を放送の局名にする (`tlv-names.ts`)。局が 1 つも無い TS は作らない
 */
export function listedEntries(
  lineups: readonly CableLineup[],
  unlocked: (channel: string) => boolean,
  known: ReadonlyMap<string, string>,
  keep: ReadonlySet<number>,
  unnamed: (serviceId: number) => string,
): AgentChannel[] {
  const entries: AgentChannel[] = [];
  for (const lineup of lineups) {
    for (const carrier of lineup.carriers) {
      carrier.streams.forEach((stream, index) => {
        const channel =
          index === 0 ? carrier.channel : `${carrier.channel}:${index}`;
        if (!unlocked(channel)) return;
        const services = stream.serviceList
          .filter((service) => keep.has(service.serviceType))
          .map((service) => ({
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            name:
              known.get(`${stream.originalNetworkId}:${service.serviceId}`) ??
              unnamed(service.serviceId),
            // ケーブルの NIT に部分受信記述子が残るかは確かめていない。スキャンで読んだ局と同じく、部分受信でないと書く (`schema.importedService`)
            partialReception: false,
          }))
          .sort((a, b) => a.serviceId - b.serviceId);
        if (services.length === 0) return;
        entries.push({
          type: "CATV",
          channel,
          networkId: stream.originalNetworkId,
          transportStreamId: stream.transportStreamId,
          remoteControlKeyId: null,
          services,
        });
      });
    }
  }
  return entries;
}

/** 記録に出す NIT のバイト列の上限 (バイト)。セクションは 1 つ 1024 バイトまでで、これを超えるぶんは省く */
export const RAW_LIMIT = 1024;

/** 記録の 1 行に出すバイト数 */
const RAW_LINE = 64;

/** 一覧の中身を、記録の行にする。NIT のバイト列 (16 進) も `RAW_LIMIT` まで出す */
export function describeLineup(
  lineup: CableLineup,
  entrance: string,
): string[] {
  const streams = lineup.carriers.reduce(
    (sum, carrier) => sum + carrier.streams.length,
    0,
  );
  const lines = [
    `${entrance}: ケーブルのネットワーク ${hex(lineup.networkId)}${
      lineup.name === null ? " " : `「${lineup.name}」`
    }の NIT (version ${lineup.version}) を読みました。搬送波 ${lineup.carriers.length}・TS ${streams}`,
  ];
  for (const carrier of lineup.carriers) {
    const tsmf =
      carrier.frameType === FRAME_TSMF
        ? "TSMF"
        : carrier.frameType === 0xf
          ? "TS 1 つ"
          : `多重フレーム型式 0x${carrier.frameType.toString(16).toUpperCase()}`;
    lines.push(
      `  ${carrier.channel}  ${mhz(carrier.frequency)} MHz  ${MODULATIONS[carrier.modulation] ?? `変調 0x${hex2(carrier.modulation)}`}  ${(carrier.symbolRate / 1_000_000).toFixed(4)} Msps  ${carrier.fecOuter === 0x2 ? "RS(204,188)" : `外符号 0x${carrier.fecOuter.toString(16)}`}  ${tsmf}  ${carrier.streams
        .map(
          (ts) =>
            `TS ${hex(ts.transportStreamId)} (ONID ${hex(ts.originalNetworkId)}、${ts.serviceList.length} 局)`,
        )
        .join("・")}`,
    );
  }
  for (const { transportStreamId, why } of lineup.skipped)
    lines.push(`  TS ${hex(transportStreamId)} を入れませんでした: ${why}`);
  lines.push(
    lineup.others
      ? "  再送信の TS (ほかの ONID) も載っています"
      : "  載っているのは自分のネットワークの TS だけです",
  );
  lines.push(...rawLines(lineup.sections));
  return lines;
}

/** NIT のバイト列を、`RAW_LIMIT` バイトまで 16 進で並べる */
function rawLines(sections: readonly Uint8Array[]): string[] {
  const lines: string[] = [];
  let left = RAW_LIMIT;
  for (const [index, section] of sections.entries()) {
    const shown = section.subarray(0, left);
    left -= shown.length;
    for (let at = 0; at < shown.length; at += RAW_LINE) {
      lines.push(
        `  NIT のセクション ${index} (${section.length} バイト) +${at}: ${[
          ...shown.subarray(at, at + RAW_LINE),
        ]
          .map(hex2)
          .join("")}`,
      );
    }
    if (shown.length < section.length) {
      lines.push(
        `  NIT の残りの ${section.length - shown.length} バイトは省きました`,
      );
    }
    if (left <= 0) break;
  }
  return lines;
}

/** 控えに書く一覧 (`settings` の `cableLineup:<エージェント>`) */
export interface StoredCableLineup {
  /** NIT を読めたチャンネル。次のスキャンで先に開く */
  entrance: string;
  networks: {
    networkId: number;
    version: number;
    carriers: { channel: string; transportStreamIds: number[] }[];
  }[];
}

/** 控えに書く形式にする */
export function toStored(
  entrance: string,
  lineups: readonly CableLineup[],
): StoredCableLineup {
  return {
    entrance,
    networks: lineups.map((lineup) => ({
      networkId: lineup.networkId,
      version: lineup.version,
      carriers: lineup.carriers.map((carrier) => ({
        channel: carrier.channel,
        transportStreamIds: carrier.streams.map((ts) => ts.transportStreamId),
      })),
    })),
  };
}

/** 控えを読む。形式が違えば null */
export function parseStored(raw: string | undefined): StoredCableLineup | null {
  if (raw === undefined || raw === "") return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredCableLineup>;
    if (typeof value.entrance !== "string" || !Array.isArray(value.networks))
      return null;
    return value as StoredCableLineup;
  } catch {
    return null;
  }
}

/** 前の控えと比べて、増えた搬送波と無くなった搬送波を記録の行にする。前の控えが無ければ空 */
export function lineupChanges(
  before: StoredCableLineup | null,
  after: StoredCableLineup,
): string[] {
  if (before === null) return [];
  const channels = (stored: StoredCableLineup) =>
    new Set(
      stored.networks.flatMap((network) =>
        network.carriers.map((carrier) => carrier.channel),
      ),
    );
  const old = channels(before);
  const now = channels(after);
  const added = [...now].filter((channel) => !old.has(channel));
  const removed = [...old].filter((channel) => !now.has(channel));
  const lines: string[] = [];
  if (added.length > 0)
    lines.push(`CATV: 前のスキャンから搬送波が増えました: ${added.join("、")}`);
  if (removed.length > 0)
    lines.push(
      `CATV: 前のスキャンから搬送波が無くなりました: ${removed.join("、")}`,
    );
  return lines;
}

/**
 * NIT を読みに先に開くチャンネルの順。控えの入口 → 前の控えの自主放送らしいチャンネル (ネットワーク ID が衛星・地上波でないもの) →
 * 残りは総当たりの順。`channels` (総当たりの一覧) にあるものだけを並べ替え、数は変えない。
 * TSMF の 2 つ目からの TS (`QC30:1`) は総当たりの一覧に無いので、入口がそれなら搬送波 (`QC30`) を先に開く (開けば TSMF の TS も列に入る)
 */
export function entranceOrder(
  channels: readonly string[],
  stored: StoredCableLineup | null,
  previous: readonly AgentChannel[],
): string[] {
  const first = [
    ...(stored === null ? [] : [stored.entrance.split(":")[0]!]),
    ...previous
      .filter(
        (entry) =>
          entry.type === "CATV" &&
          !entry.channel.includes(":") &&
          !broadcastNetwork(entry.networkId),
      )
      .map((entry) => entry.channel),
  ];
  const known = new Set(channels);
  const head = [...new Set(first)].filter((channel) => known.has(channel));
  const picked = new Set(head);
  return [...head, ...channels.filter((channel) => !picked.has(channel))];
}

/** 衛星 (BS・CS・BS4K) か地上波のネットワーク ID か (ARIB STD-B10 の付録 N)。再送信の TS には自主放送の NIT が流れていない */
function broadcastNetwork(networkId: number): boolean {
  return networkId <= 0x000b || (networkId >= 0x7880 && networkId <= 0x7fe8);
}

const hex2 = (value: number) =>
  value.toString(16).toUpperCase().padStart(2, "0");
const mhz = (hertz: number) => (hertz / 1_000_000).toFixed(4);
