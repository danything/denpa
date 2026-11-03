/**
 * **どの形式で観るかを決めるのに要る、世帯の設定とリクエストの名前** (docs/stream.md「どの形式で流すか」)。
 *
 * 家の中かは**開いたホスト名**で決める (`#lib/host.ts` の `indoorHost`)。相手の IP では決めない。VPN が
 * アドレスを書き換え、家の中だけの名前が外からも引けることがある。サーバが決めて画面に渡すので、
 * 画面と先回り (`live.warm`) が食い違わない
 */

import { indoorHost } from "../host";
import type { LiveCodec } from "../live";
import {
  autoCodec,
  HIDDEN_CODECS,
  type LiveChoice,
  type LiveFormat,
  readChoice,
} from "../live-choice";
import { liveHevc } from "./live";
import { settings } from "./settings";

/** 観るときの決まり。画面の load と `GET /api/playback/options` が同じものを返す */
interface ViewingOptions {
  /** 開いた名前が家の中か */
  indoor: boolean;
  /** コーデックのメニューから外すもの (世帯の設定。外さないなら空) */
  hidden: (typeof HIDDEN_CODECS)[number][];
  /**
   * ライブで H.265 を出せるか。**ライブのエンコーダが GPU のときだけ** (`live.liveHevc`)。出せなければメニューに並べず、
   * 「自動」でも選ばない
   */
  hevc: boolean;
}

/**
 * リクエストの URL (`event.url`。名前は `Host` か `HOST_HEADER` から) で決める。`hevc` はテストで差し替えるときだけ渡す
 */
export function viewingOptions(url: URL, hevc = liveHevc()): ViewingOptions {
  const current = settings();
  return {
    indoor: indoorHost(url.hostname, current.indoorHosts),
    hidden: current.hideH264Hevc ? [...HIDDEN_CODECS] : [],
    hevc,
  };
}

/** 前回の局と選択の控え (`LAST_COOKIE`)。前の形式 (`codec`・`raw`) は読まない */
interface Kept {
  channelType?: string;
  channel?: string;
  audio?: string;
  choice: LiveChoice;
}

/**
 * cookie を読む。**壊れていても無視するだけ**で、覚えていないときと同じく、自動と一覧の先頭になる。
 * 選択 (`choice`) は局と別に読む (局が一覧から消えても、その端末で出るかの話は残る)
 */
export function readKept(raw: string | undefined, hidden: boolean): Kept {
  if (raw === undefined) return { choice: "auto" };
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const kept: Kept = { choice: readChoice(saved["choice"], hidden) };
    for (const key of ["channelType", "channel", "audio"] as const) {
      const value = saved[key];
      if (typeof value === "string") kept[key] = value;
    }
    return kept;
  } catch {
    return { choice: "auto" };
  }
}

/**
 * **開いたときに先回りする形式** (`live.warm`)。選んだものがあればそれ、自動なら `autoCodec` を、
 * 端末が何でも受け取れるとみて決める (家の中なら MPEG-2、外なら AV1)。外れても画面は自分で決めた形式で
 * リクエストし直すだけで、温めたものは誰も来なければ畳まれる
 */
export function warmFormat(choice: LiveChoice, indoor: boolean): LiveFormat {
  if (choice !== "auto") return choice;
  return (
    autoCodec({
      indoor,
      rawOk: true,
      av1: true,
      // AV1 が先なので、自動で H.265 を温めることは無い。選んだ H.265 を出せなければ H.264 で温める (`live.warm`)
      hevc: true,
      h264: true,
      compat: false,
    }) ?? "h264"
  );
}

/** 開く局と形式 (`live/+page.server.ts` の `start`)。`Tuned` の形で、`codec`・`raw` は先回りする形式 (`warmFormat`) */
interface LiveStart {
  channelType: string;
  channel: string;
  serviceId: number;
  audio?: string;
  codec?: LiveCodec;
  raw?: boolean;
}

/**
 * **どの局を、どの形式で開くか。** 番組表から名指しで来た局 (`asked`。無い番号は使わない) → 前回の局 (`kept`) →
 * 一覧の先頭。音声の控えは同じ局に戻ったときだけ活かす。形式は選択 (`kept.choice`) と家の中か (`indoor`) から
 * (`warmFormat`)。局が無ければ null
 */
export function liveStart(
  channels: readonly { id: number; type: string; channel: string }[],
  asked: number,
  kept: Kept,
  indoor: boolean,
): LiveStart | null {
  const named = channels.find((channel) => channel.id === asked);
  const saved =
    named === undefined
      ? channels.find(
          (channel) =>
            channel.type === kept.channelType &&
            channel.channel === kept.channel,
        )
      : undefined;
  const target = named ?? saved ?? channels[0];
  if (target === undefined) return null;
  const format = warmFormat(kept.choice, indoor);
  return {
    channelType: target.type,
    channel: target.channel,
    serviceId: target.id,
    ...(saved !== undefined && kept.audio !== undefined
      ? { audio: kept.audio }
      : {}),
    ...(format === "raw" ? { raw: true } : { codec: format }),
  };
}
