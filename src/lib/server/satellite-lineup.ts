/**
 * **BS と CS は、スキャンしなくても放送の一覧から局が入るようにする。**
 *
 * 地上波は地域で顔ぶれが変わるので総当たりで探すしかないが、BS と CS は全国どこでも同じで、
 * 中継器に 1 回合わせて NIT を読めば一覧がそろう (`satellite.ts`)。決まった表を持つ必要は無い
 * (前は標準の表を持っていて、再編のたびに古くなった)。
 *
 * **入れるのは、その種別の局が無いときと、前のバージョンの名前 (`BS15_0`・`CS02`) が残っているとき。**
 * 前の名前はエージェントが選局できないので、上げた最初の起動で作り直す。予約とルールは局の ID
 * (ネットワーク ID とサービス ID) で持っているので、そのまま残る。入れるのは受けられるチューナーがある種別だけ。
 *
 * 読めなかった種別 (アンテナが無い・チューナーが塞がっている) は、`RETRY_AFTER` たってから試し直す
 * (局の一覧は 1 分ごとに読むので、そのたびに選局しない)
 */
import type { ChannelType } from "../types";
import { config } from "./config";
import {
  isLineupName,
  knownNames,
  readLineup,
  type SatelliteType,
} from "./satellite";
import { scanState } from "./scan";
import {
  type AgentChannel,
  getTuners,
  openChannelStream,
  putChannels,
} from "./tuner";

const TYPES: SatelliteType[] = ["BS", "CS"];

/** 読めなかった種別を試し直すまで */
const RETRY_AFTER = 60 * 60_000;

/** 1 中継器を読む上限 (スキャンと同じ) */
const READ_TIMEOUT = 30_000;

/** 最後に試して読めなかった時刻 (種別ごと) */
const failedAt = new Map<SatelliteType, number>();

/** 走っている回。重なった呼び出しは何もしない */
let running: Promise<ChannelType[]> | null = null;

/** その種別を作り直すべきか。局が無いか、前のバージョンの名前が残っている */
export function needsLineup(
  channels: readonly AgentChannel[],
  type: SatelliteType,
): boolean {
  const mine = channels.filter((channel) => channel.type === type);
  return (
    mine.length === 0 || mine.some((channel) => !isLineupName(channel.channel))
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
): Promise<ChannelType[]> {
  if (running !== null) return Promise.resolve([]);
  /*
   * **スキャンの最中は入れない。** スキャンは結果を最後にまとめて預けるので、そこへ割り込むと
   * スキャンの途中で一覧が入れ替わる
   */
  if (scanState().state === "running") return Promise.resolve([]);
  const wanted = TYPES.filter(
    (type) =>
      needsLineup(channels, type) &&
      now - (failedAt.get(type) ?? -Infinity) >= RETRY_AFTER,
  );
  if (wanted.length === 0) return Promise.resolve([]);
  running = fill(channels, wanted, now).finally(() => {
    running = null;
  });
  return running;
}

async function fill(
  channels: readonly AgentChannel[],
  wanted: SatelliteType[],
  now: number,
): Promise<ChannelType[]> {
  const receivable = new Set(
    (await getTuners()).filter((t) => !t.disabled).flatMap((t) => t.types),
  );
  const known = knownNames(channels);
  const filled: ChannelType[] = [];
  for (const type of wanted.filter((type) => receivable.has(type))) {
    const lineup = await readLineup(
      type,
      (channel) =>
        openChannelStream(
          type,
          channel,
          AbortSignal.timeout(READ_TIMEOUT * 4),
          `scan ${channel}`,
          config.priority.scan,
        ),
      { timeout: READ_TIMEOUT, known },
    );
    if (lineup.channels.length === 0) {
      failedAt.set(type, now);
      console.warn(
        `[channels] ${type} の放送の一覧を読めませんでした (${lineup.log.join(" / ")})`,
      );
      continue;
    }
    // スキャンが始まっていたら書かない (スキャンの結果のほうが新しい)
    if (scanState().state === "running") break;
    await putChannels(lineup.channels, [type]);
    failedAt.delete(type);
    filled.push(type);
    console.log(
      `[channels] ${type} の局を放送の一覧から入れました (${lineup.channels.length} TS)`,
    );
  }
  return filled;
}
