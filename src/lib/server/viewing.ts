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
import { parseRung, type Rung } from "../rungs";
import { liveHevc, parsePlayable, rungCodec } from "./live";
import { settings } from "./settings";

/** 観るときの決まり。画面の load と `GET /api/playback/options` が同じものを返す */
interface ViewingOptions {
  /** 開いた名前が家の中か */
  indoor: boolean;
  /** コーデックのメニューから外すもの (いつも H.264 と H.265。テレビのアプリがこれを読んでメニューから外す) */
  hidden: (typeof HIDDEN_CODECS)[number][];
  /**
   * ライブで H.265 を出せるか。**ライブのエンコーダが GPU のときだけ** (`live.liveHevc`)。出せなければ「自動」で選ばない
   */
  hevc: boolean;
}

/**
 * リクエストの URL (`event.url`。名前は `Host` か `HOST_HEADER` から) で決める。`hevc` はテストで差し替えるときだけ渡す
 */
export function viewingOptions(url: URL, hevc = liveHevc()): ViewingOptions {
  return { indoor: indoorOf(url), hidden: [...HIDDEN_CODECS], hevc };
}

/** リクエストの URL の名前が家の中か (`#lib/host.ts` の `indoorHost`。世帯の設定の「家の中の名前」も見る) */
export function indoorOf(url: URL): boolean {
  return indoorHost(url.hostname, settings().indoorHosts);
}

/*
 * ---------------------------------------------------------------------------
 * **`codec=auto` (テレビのアプリ向け)。** 端末は再生できる形式 (`?playable=`) を送り、サーバが「自動」の順
 * (`autoOrder`) で選んで、応答ヘッダ `X-Denpa-Codec` で返す。順番を端末に持たせない (docs/api.md「形式をサーバに選ばせる」)
 * ---------------------------------------------------------------------------
 */

/**
 * `?playable=` (`,` 区切り。`raw` / `av1` / `hevc` / `h264`) を読む。**省けば H.264 だけ** (どの端末でも再生できる)。
 * 知らない値は捨て、重なりはまとめる。並びの順は使わない。何も残らなければ null (呼ぶ側が 406 にする)
 */
export function parseFormats(value: string | null): LiveFormat[] | null {
  if (value === null) return ["h264"];
  const known = value
    .split(",")
    .map((item) => item.trim())
    .filter(
      (item): item is LiveFormat =>
        item === "raw" || item === "av1" || item === "hevc" || item === "h264",
    );
  return known.length === 0 ? null : [...new Set(known)];
}

/** ライブと追っかけのどちらか。**追っかけは段 0 では H.265 を出さない** (段を下げるときは `rungCodec` が選ぶ。WebSocket の `chase` と同じ) */
type AutoScene = "live" | "chase";

/**
 * **`codec=auto` で流す形式。** 段 0 は `autoCodec` (家の中なら MPEG-2 → H.264 → AV1 → H.265、外なら AV1 → H.265 → H.264) で、
 * 端末が再生できて (`formats`)、その場面で出せる最初のもの。H.265 はライブで、エンコーダが GPU のとき (`hevc`) だけ。
 * 段を下げるなら、今までどおり `rungCodec` (`raw` は並びから外す)。選べなければ null。
 * `hevc` と `pick` はテストで差し替えるときだけ渡す
 */
export function autoFormat(o: {
  scene: AutoScene;
  formats: readonly LiveFormat[];
  indoor: boolean;
  rung: Rung;
  hevc?: boolean;
  pick?: Parameters<typeof rungCodec>[2];
}): LiveFormat | null {
  if (o.rung !== 0) {
    const codecs = o.formats.filter(
      (format): format is LiveCodec => format !== "raw",
    );
    // `rungCodec` は何も合わなければ H.264 を返す。端末が H.264 を再生できないと言っていれば選ばない
    const codec = rungCodec(codecs, true, o.pick);
    return codecs.includes(codec) ? codec : null;
  }
  const has = (format: LiveFormat) => o.formats.includes(format);
  return autoCodec({
    indoor: o.indoor,
    rawOk: has("raw"),
    av1: has("av1"),
    hevc: o.scene === "live" && has("hevc") && (o.hevc ?? liveHevc()),
    h264: has("h264"),
    compat: false,
  });
}

/**
 * **HTTP の `live`・`chase` が流す形式と段** (`?codec=`・`?rung=`・`?playable=`)。音声だけ (`?audio=only`) は呼ぶ側が先に見る。
 *
 * - `codec=auto` … `autoFormat`。選べなければ null (呼ぶ側が 406「再生できる形式がありません」にする)
 * - `codec=h264` (省いたとき・知らない値も) / `av1` / `raw`、ライブなら `hevc` も … そのまま。H.265 を出せなければ H.264 にする
 *   (応答ヘッダで分かる。WebSocket の `tune` と同じ)。段を下げるならコーデックは `rungCodec` が `?playable=` から選ぶ
 * - `raw` は段を下げない
 *
 * `hevc` と `pick` はテストで差し替えるときだけ渡す
 */
export function askedFormat(
  url: URL,
  scene: AutoScene,
  test: { hevc?: boolean; pick?: Parameters<typeof rungCodec>[2] } = {},
): { codec: LiveFormat; rung: Rung } | null {
  const query = url.searchParams;
  const asked = query.get("codec");
  if (asked === "auto") {
    const formats = parseFormats(query.get("playable"));
    if (formats === null) return null;
    const rung = parseRung(query.get("rung"));
    const codec = autoFormat({
      scene,
      formats,
      indoor: indoorOf(url),
      rung,
      ...test,
    });
    return codec === null ? null : { codec, rung: codec === "raw" ? 0 : rung };
  }
  const hevc = scene === "live" && asked === "hevc";
  const plain: LiveFormat =
    asked === "av1" || asked === "raw"
      ? asked
      : hevc && (test.hevc ?? liveHevc())
        ? "hevc"
        : "h264";
  if (plain === "raw") return { codec: "raw", rung: 0 };
  const rung = parseRung(query.get("rung"));
  return {
    codec:
      rung === 0
        ? plain
        : rungCodec(
            parsePlayable(query.get("playable"), plain),
            true,
            test.pick,
          ),
    rung,
  };
}

/**
 * **HTTP のライブの音声だけ** (`?audio=only`)。音声だけでなければ null (`askedFormat` で読む)。
 * 段 (`?rung=`) はそのまま返す。画面の WebSocket の `codec: "audio"` と同じく、音声のビットレートだけを下げる (`live.audioArgs`)
 */
export function liveAudioOnly(url: URL): { codec: "audio"; rung: Rung } | null {
  const query = url.searchParams;
  if (query.get("audio") !== "only") return null;
  return { codec: "audio", rung: parseRung(query.get("rung")) };
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
export function readKept(raw: string | undefined): Kept {
  if (raw === undefined) return { choice: "auto" };
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const kept: Kept = { choice: readChoice(saved["choice"]) };
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
 * 端末が何でも受け取れるとみて決める (家の中なら MPEG-2、外なら AV1)。外れたら画面は自分で決めた形式で
 * リクエストし、先回りしたものはそのリクエストがチューナーを使えた時点で畳む (`live.ts` の `dropWarm`)
 */
export function warmFormat(choice: LiveChoice, indoor: boolean): LiveFormat {
  if (choice !== "auto") return choice;
  return (
    autoCodec({
      indoor,
      rawOk: true,
      // どれも受け取れるとみるので、家の中は MPEG-2、外は AV1 が先に当たる (H.265・H.264 まで下りない)
      av1: true,
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
