/**
 * 録画のデータ放送。**TS から取り出して、サイドカーに置いておく。**
 *
 * ライブは今のカルーセルをそのまま流せばよいが、録画は巻き戻し・番組またぎが
 * あるので、**いつ何が変わったか**を再生位置つきで持っておく必要がある
 * (取り出し方は [ts/data-capture.ts](../ts/data-capture.ts)、写し方は [ts/data-timeline.ts](../ts/data-timeline.ts))。
 *
 * ここは**ファイルの出し入れだけ**。エンコードのついでに元の TS をもう一度デコードして
 * (`saveRecordedBml`)、再生時に読む (`loadRecordedBml`)。中身は 1 行 1 メッセージの
 * JSONL で、サムネイルと同じ**録画の隣**に置く (`metadata.sidecarPaths`)。
 *
 * **録画の TS は 1 局に絞ってある** (実機の録画で PAT のプログラムは 1 つ) ので、
 * ライブのような `ServiceFilter` は要らず、[packages/arib/src/bml.ts](../../../packages/arib/src/bml.ts) の
 * `BmlDecoder` にそのまま流せる。
 */

import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

import type { ResponseMessage } from "@danything/arib/bml-protocol";
import { eq } from "drizzle-orm";

import { autoStarts } from "#lib/ts/data-auto-start.js";
import { DataBroadcastCapture } from "#lib/ts/data-capture.js";
import {
  type PlacedMessage,
  type TimedMessage,
  toPlaybackTimeline,
} from "#lib/ts/data-timeline.js";

import type { Recording } from "../types";
import { orm } from "./db";
import { fillTsHead } from "./recording";
import { openRecording } from "./recording-io";
import { programs, services } from "./schema";

/**
 * **番組情報 (`programInfo`)。描く側はこれで局の番号を得る。** `arib-dc://` の名前を
 * デコードする・NVRAM を局ごとに分ける (`src/lib/bml/resources.ts`・`nvram.ts`) ので、無いと
 * 他の局を指す名前と区別できず、覚えるものも局の外へ混ざる。TS からは取り出していない (EIT はデコードしない) ので、
 * ライブと同じく DB から組み立てる (`live.ts` の `programInfo`)。局の番号は
 * `services`、番組は録画の行が持っている。
 *
 * **TS の ID (`transportStreamId`) は null のままにします。** ライブでは放送から
 * 読み取って渡していますが (あちらは TVer リンクが訊いてくる)、**放送のアプリは録画の
 * 再生中に双方向通信を使いません。** テレ朝の TVer リンクは `IsRecorded()` で分かれて
 * 「録画再生中は、このサービスをご利用いただけません」を出す。訊かれないものを
 * 録画の行に足しても、確かめようが無い
 */
function programInfoOf(recording: Recording): ResponseMessage | null {
  const service = orm()
    .select({
      service_id: services.service_id,
      network_id: services.network_id,
    })
    .from(services)
    .where(eq(services.id, recording.service_id))
    .get();
  if (service === undefined) return null;
  const program =
    recording.program_id === null
      ? undefined
      : orm()
          .select({ event_id: programs.event_id })
          .from(programs)
          .where(eq(programs.id, recording.program_id))
          .get();
  return {
    type: "programInfo",
    originalNetworkId: service.network_id,
    networkId: service.network_id,
    transportStreamId: null,
    serviceId: service.service_id,
    eventId: program?.event_id ?? null,
    eventName: recording.name,
    startTimeUnixMillis: recording.start_at,
    durationSeconds: Math.round((recording.end_at - recording.start_at) / 1000),
    indefiniteDuration: false,
  };
}

/**
 * 変化ログの先頭に番組情報を足す。**サイドカーに書くときも、読むときも通す。**
 * 書く側は `event_id` が番組表から消える前に写し取るため (`epg.ts` の
 * `pruneOldPrograms`)、読む側は番組情報を書いていなかった頃のサイドカーのため
 */
export function withProgramInfo(
  timeline: PlacedMessage[],
  recording: Recording,
): PlacedMessage[] {
  if (
    timeline.length === 0 ||
    timeline.some((item) => item.message.type === "programInfo")
  )
    return timeline;
  const info = programInfoOf(recording);
  return info === null ? timeline : [{ at: 0, message: info }, ...timeline];
}

/** 1 回に読む大きさ */
const CHUNK = 1 << 20;

/**
 * TS を 1MB ずつ読んでデコードする。**丸ごと抱えない** (録画は数 GB になる) し、
 * **読む間もイベントループを止めない** (チャンクごとに await)。
 *
 * 前は同期の `readSync` で回していて、10GB の録画 (2 時間の映画) では
 * イベントループが数分止まり、その間 `/api/health` が返せず、Kubernetes の
 * 生存確認 (1 秒で 3 回) に落ちて SIGTERM → 再起動 → エンコードのやり直し、
 * を **1 周 2 時間で 5 回** 繰り返した (2026-08-17 実機)。エンコードそのものは
 * 終わっていて、最後のこの一手で全部を捨てていた
 */
async function capture(
  path: string,
): Promise<{ timeline: TimedMessage[]; head: number | null }> {
  const found = new DataBroadcastCapture();
  const file = await openRecording(path);
  try {
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK, null);
      if (bytesRead <= 0) break;
      found.feed(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return { timeline: found.result(), head: found.head };
}

/**
 * 録画のデータ放送を取り出して、サイドカーに書く。
 *
 * 時刻は**エンコードしたものの再生位置**で書く (観る画面の物差し。`playbackPlan` の `axis`)。
 * 基準は元の TS の先頭 (`DataBroadcastCapture.head`) で、番組の始まり (`start_at`) ではない。
 * 測った先頭は、録画の行の `ts_head` が空なら書く (`recording.fillTsHead`。実況のコメントを合わせるのに使う)
 *
 * @param tsPath 元の TS (放送の実時刻 (TDT) が続いている)
 * @param sidecarPath 書き先 (`metadata.sidecarPaths` の `dataBroadcast`)
 * @param recording 録画の行。番組情報に使う
 * @param skip エンコードで元の TS の先頭から捨てた秒 (録画の行に書く `encode_skip` と同じもの)
 * @returns 書いた変化の数。**0 なら書かない** (データ放送を持たない録画)
 */
export async function saveRecordedBml(
  tsPath: string,
  sidecarPath: string,
  recording: Recording,
  skip: number,
): Promise<number> {
  const { timeline, head } = await capture(tsPath);
  // 先頭の放送時刻は実況のコメントにも使う。録っている間に測れていなければここで書く (データ放送の有る無しに関わらず)
  if (head !== null) fillTsHead(recording.id, head);
  /*
   * **描けるモジュールが 1 つも無ければ書かない。** データ放送の載っていない局でも
   * `pmt` は必ず 1 つ出る (timeline は空にならない) ので、それだけでは持たせない。
   * 実際に画面になるのは `moduleDownloaded`。無ければサイドカーを作らない
   */
  if (!timeline.some((item) => item.message.type === "moduleDownloaded"))
    return 0;
  // TDT を一度も見ていなければ、どの変化も時刻を持たない (先頭の 0 に並ぶ) ので基準は使われない
  const placed = withProgramInfo(
    toPlaybackTimeline(timeline, head ?? 0, { kept: null, skip }),
    recording,
  );
  writeFileSync(
    sidecarPath,
    `${placed.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
  return placed.length;
}

/** 変化ログの 1 行が PMT か。中身は JSON にする前に文字で絞る (モジュールの行は base64 で大きく、引用符を含まない) */
const PMT_LINE = '"type":"pmt"';

/**
 * **録画の入口の部品に自動起動の指定があるか** (`ts/data-auto-start.ts` の `autoStarts`)。観る画面は、データ放送を
 * 自動で受信する端末でこれが true のときだけ、開く前から変化ログを取得する (`components/player/data-receive.ts`)。
 *
 * 変化ログの PMT の行だけを JSON にして見る。録画の途中で番組が替わって指定が付いたり外れたりしても、どこかの PMT に
 * 指定があれば true (再生位置で分けない)。行を先頭から読み、指定のある PMT が見つかったところでやめる。
 * PMT はふつう先頭近くにあるが、指定が無い録画はファイルを最後まで読む (読むのはサーバの中だけで、端末へは送らない)
 *
 * @returns サイドカーが無ければ false
 */
export async function recordedAutoStart(sidecarPath: string): Promise<boolean> {
  if (!existsSync(sidecarPath)) return false;
  const lines = createInterface({
    input: createReadStream(sidecarPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      if (!line.includes(PMT_LINE)) continue;
      const { message } = JSON.parse(line) as PlacedMessage;
      if (message.type === "pmt" && autoStarts(message.components)) return true;
    }
    return false;
  } finally {
    lines.close();
  }
}

/** サイドカーを読む。無ければ空 (データ放送を持たない録画・古い録画) */
export function loadRecordedBml(sidecarPath: string): PlacedMessage[] {
  if (!existsSync(sidecarPath)) return [];
  return readFileSync(sidecarPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PlacedMessage);
}
