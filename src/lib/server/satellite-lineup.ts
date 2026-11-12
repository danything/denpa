/**
 * **BS と CS は、スキャンしなくても放送の一覧から局が入るようにする。**
 *
 * 地上波は地域で顔ぶれが変わるので総当たりで探すしかないが、BS と CS は全国どこでも同じで、
 * 中継器に 1 回合わせて NIT を読めば一覧がそろう (`satellite.ts`)。決まった表を持つ必要は無い
 * (前は標準の表を持っていて、再編のたびに古くなった)。
 *
 * **入れるのは、その種別の局が無いときと、前のバージョンの名前 (`BS15_0`・`CS02`) が残っているとき。**
 * 前の名前はエージェントが選局できないので、上げた最初の起動で作り直す。エージェントの一覧に無くても、
 * 局の表 (`services`) に前の名前で残っているネットワークがあれば作り直す (NIT から作るようにした最初のバージョンで、CS のネットワーク 7 が
 * 一覧から落ち、局の表にだけ前の名前で残った)。予約とルールは局の ID (ネットワーク ID とサービス ID) で
 * 持っているので、そのまま残る。入れるのは受けられるチューナーがある種別だけ。
 * **人が設定から消した種別は入れない** (`removedSatellites`)。その種別をスキャンし直すまで消えたまま。
 *
 * 読めなかった種別 (アンテナが無い・チューナーが塞がっている) と、CS で読めなかったネットワークがあった回は、
 * `RETRY_AFTER` たってから試し直す (局の一覧は 1 分ごとに読むので、そのたびに選局しない)
 */
import type { ChannelType } from "../types";
import { primaryAgent } from "./agents";
import { orm } from "./db";
import { readFromAir } from "./lineup-follow";
import {
  isLineupName,
  knownNames,
  type Lineup,
  type SatelliteType,
} from "./satellite";
import { scanState } from "./scan";
import { services } from "./schema";
import { store, stored as storedSetting } from "./settings";
import { type AgentChannel, putChannels, tunerList } from "./tuner";

const TYPES: SatelliteType[] = ["BS", "CS"];

/** 設定の表のキー。人が設定から消した衛星の種別 (JSON の並び) */
const REMOVED_KEY = "removedSatellites";

/**
 * **人が設定から消した衛星の種別。放送の一覧から入れ直さない** (`fillSatellites`)。引っ越してアンテナが無くなった、
 * ケーブルをやめたなどで消した種別が、1 分後の取り込みで戻らないようにする。その種別をスキャンすると外れる (`scan.ts`)
 */
export function removedSatellites(): SatelliteType[] {
  try {
    const raw: unknown = JSON.parse(storedSetting(REMOVED_KEY) ?? "[]");
    return TYPES.filter((type) => Array.isArray(raw) && raw.includes(type));
  } catch {
    return [];
  }
}

/** 消した (`removed`) か、スキャンで戻した種別を書く */
export function markRemoved(
  types: readonly SatelliteType[],
  removed: boolean,
): void {
  const before = removedSatellites();
  const after = TYPES.filter((type) =>
    types.includes(type) ? removed : before.includes(type),
  );
  if (after.length !== before.length) store(REMOVED_KEY, JSON.stringify(after));
}

/** 読めなかった種別を試し直すまで */
const RETRY_AFTER = 60 * 60_000;

/** 最後に試して読めなかった時刻 (種別ごと) */
const failedAt = new Map<SatelliteType, number>();

/**
 * 局の表に前の名前で残っていても、放送から無くなったと分かったネットワーク (`種別:ネットワーク ID`)。
 * 局の表の行は消えないので、覚えておかないと 1 時間ごとに選局し続ける。起動し直すと 1 回だけ確かめ直す
 */
const gone = new Set<string>();

/** 無くなったネットワークの行を除く */
const withoutGone = (stored: readonly StoredService[]) =>
  stored.filter((row) => !gone.has(`${row.type}:${row.network_id}`));

/** 走っている回。重なった呼び出しは何もしない */
let running: Promise<ChannelType[]> | null = null;

/** 局の表 (`services`) の 1 行のうち、作り直すかを決めるのに使うところ */
interface StoredService {
  type: string;
  network_id: number;
  /** 上げてから一度も取り込みで見かけていない局は null (`services.transport_stream_id`) */
  transport_stream_id: number | null;
}

/**
 * 局の表に、上げてから一度も取り込みで見かけていない局として残っていて (`transport_stream_id` が null)、エージェントの一覧には無いネットワーク。
 * 一覧から落ちたネットワークで、作り直すときに読みに行く
 */
export function leftoverNetworks(
  channels: readonly AgentChannel[],
  type: SatelliteType,
  stored: readonly StoredService[],
): number[] {
  const present = new Set(
    channels
      .filter((channel) => channel.type === type)
      .map((channel) => channel.networkId),
  );
  return [
    ...new Set(
      stored
        .filter(
          (row) =>
            row.type === type &&
            row.transport_stream_id === null &&
            !present.has(row.network_id),
        )
        .map((row) => row.network_id),
    ),
  ].sort((a, b) => a - b);
}

/**
 * その種別を作り直すべきか。局が無いか、エージェントの一覧に前のバージョンの名前が残っているか、
 * 一覧に無いネットワークの局が、上げてから見かけていないまま局の表に残っている
 */
export function needsLineup(
  channels: readonly AgentChannel[],
  type: SatelliteType,
  stored: readonly StoredService[] = [],
): boolean {
  const mine = channels.filter((channel) => channel.type === type);
  return (
    mine.length === 0 ||
    mine.some((channel) => !isLineupName(channel.channel)) ||
    leftoverNetworks(channels, type, stored).length > 0
  );
}

/**
 * 入れるべきなら入れる。入れた種別を返す (無ければ空)。
 *
 * **見るのは局の一覧を取り込むとき** (runtime.ts の `syncChannels`。起動時と `CHANNEL_SYNC_INTERVAL` ごと)。
 * 局を入れたらエージェントが `channels` を知らせてくるので、取り込み直しと番組表の集め直しはその通知で走る
 */
export function fillSatellites(
  channels: readonly AgentChannel[],
  now = Date.now(),
  stored: readonly StoredService[] = storedServices(),
): Promise<ChannelType[]> {
  if (running !== null) return Promise.resolve([]);
  /*
   * **スキャンの最中は入れない。** スキャンは結果を最後にまとめて預けるので、そこへ割り込むと
   * スキャンの途中で一覧が入れ替わる
   */
  if (scanState().state === "running") return Promise.resolve([]);
  const removed = removedSatellites();
  const wanted = TYPES.filter(
    (type) =>
      !removed.includes(type) &&
      needsLineup(channels, type, withoutGone(stored)) &&
      now - (failedAt.get(type) ?? -Infinity) >= RETRY_AFTER,
  );
  if (wanted.length === 0) return Promise.resolve([]);
  running = fill(channels, withoutGone(stored), wanted, now).finally(() => {
    running = null;
  });
  return running;
}

function storedServices(): StoredService[] {
  return orm()
    .select({
      type: services.type,
      network_id: services.network_id,
      transport_stream_id: services.transport_stream_id,
    })
    .from(services)
    .all();
}

async function fill(
  channels: readonly AgentChannel[],
  stored: readonly StoredService[],
  wanted: SatelliteType[],
  now: number,
): Promise<ChannelType[]> {
  const receivable = new Set(
    (await tunerList(primaryAgent())).tuners
      .filter((t) => !t.disabled)
      .flatMap((t) => t.types),
  );
  const known = knownNames(channels);
  const filled: ChannelType[] = [];
  for (const type of wanted.filter((type) => receivable.has(type))) {
    // `busy` はチューナーが塞がっていて開けなかったか。それだけなら 1 時間待たず、次の取り込みで試し直す
    const { lineup, busy } = await readFromAir(type, {
      known,
      previous: channels,
      expected: leftoverNetworks(channels, type, stored),
    });
    if (lineup.channels.length === 0) {
      if (!busy) failedAt.set(type, now);
      console.warn(
        `[channels] ${type} の放送の一覧を読めませんでした (${lineup.log.join(" / ")})`,
      );
      continue;
    }
    // スキャンが始まっていたら書かない (スキャンの結果のほうが新しい)
    if (scanState().state === "running") break;
    // 読んでいる間に設定から消された種別は書かない
    if (removedSatellites().includes(type)) continue;
    // 預ける先は放送の一覧を読んだエージェント (並びの先頭の 1 台。`lineup-follow.readFromAir`)
    await putChannels(lineup.channels, [type], primaryAgent());
    for (const network of goneNetworks(
      leftoverNetworks(channels, type, stored),
      lineup,
    ))
      gone.add(`${type}:${network}`);
    filled.push(type);
    /*
     * 作り直してもまだ作り直すべきまま (読めなかったネットワークがある) なら、1 時間待ってから試し直す。
     * 1 分ごとに選局し直さない
     */
    const rest = [
      ...channels.filter((channel) => channel.type !== type),
      ...lineup.channels,
    ];
    if (
      !busy &&
      (lineup.missing.length > 0 ||
        needsLineup(rest, type, withoutGone(stored)))
    ) {
      failedAt.set(type, now);
      console.warn(
        `[channels] ${type} の局を放送の一覧から入れましたが、読めなかったネットワークがあります (${lineup.log.join(" / ")})`,
      );
    } else {
      failedAt.delete(type);
      console.log(
        `[channels] ${type} の局を放送の一覧から入れました (${lineup.channels.length} TS)`,
      );
    }
  }
  return filled;
}

/**
 * 局の表に残っていたネットワークのうち、放送から無くなったもの。NIT[other] を読めていて、
 * そこに載っておらず、読めてもいないネットワーク。NIT[other] を読めなければ決めない (空)
 */
export function goneNetworks(
  leftovers: readonly number[],
  lineup: Pick<Lineup, "networks" | "listed">,
): number[] {
  if (lineup.listed.length === 0) return [];
  return leftovers.filter(
    (network) =>
      !lineup.networks.includes(network) && !lineup.listed.includes(network),
  );
}
