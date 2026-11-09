/**
 * 追っかけ再生の入口。**録画中の伸びている元の TS を読み続ける** (issue #16)。
 *
 * チューナーは使わない。電波は録画が既に受けていて、ファイルに書き足されて
 * いる (`recorder.ts`)。ここはそのファイルを追い読みして、ライブ視聴と
 * 同じ経路 (`live.ts` の Session。エンコードするときも元の TS のまま送るときも) に流し込むだけ。何人開いてもチューナー数には
 * 響かず、増えるのは ffmpeg だけ。
 *
 * ## シークはバイト比例で当たりを付ける
 *
 * 元の TS には時間→バイトの索引が無い。放送の TS はレートがほぼ一定なので、
 * 「これまで録れた秒数とファイルの大きさ」からバイト/秒を出して比例で飛ぶ。
 * 188 バイト (TS パケット) に揃えれば、ffmpeg は次のキーフレームから読み直す。
 * シークのたびに ffmpeg ごと立て直す (ライブの選局し直しと同じ流儀)。
 */

import { statSync } from "node:fs";

import { PACKET } from "@danything/arib/psi";

import { lastVideoPts, readHead, sinceHead, tsHead } from "#lib/ts/seek.js";

import type { Recording } from "../types";
import {
  openRecording,
  openRecordingSync,
  type RecordingSyncHandle,
} from "./recording-io";

/** 1 回に読む量。小さすぎると read の回数だけ損する */
const READ_SIZE = 256 * 1024;

/** 書き足されるのを待つ間隔 (ms)。放送は約 2MB/秒なので、これで十分細かい */
const WAIT_MORE = 300;

/** 読む側が詰まっているときに、空くのを待つ間隔 (ms) */
const WAIT_READER = 50;

/**
 * 送り込みの上限。**実時間の倍速まで。**
 *
 * ffmpeg はファイルなら実時間の数倍でエンコードできるが、そのまま流すと観る側の
 * MSE バッファが際限なく太り (30 分の後追いで数百 MB)、ブラウザの持ち分を
 * 超えて追記が断られる。倍速なら「観ている先」は常に伸び続け、しかも
 * 観る側に溜まるのは観た速さとの差だけで済む
 */
const PACE = 2;

interface ChasePlan {
  /** 読み始めるバイト位置 (188 に揃えてある) */
  offset: number;
  /** 実際に始まる再生位置 (秒)。リクエストされた位置を録れている範囲に収めた後 */
  at: number;
  /** いま録れている長さ (秒)。シークバーの右端 */
  recordedSec: number;
  /** 送り込みの上限 (バイト/秒)。実測レート × PACE */
  paceBytesPerSec: number;
  /** 実測レート (バイト/秒)。読んだ量を秒に直すのに使う (`resumeFrom`) */
  bytesPerSec: number;
}

/**
 * **番組が替わって作り直したところ** (`live.ts` の `Session.restart`)。録画ごとに覚える。
 *
 * 追っかけのエンコードも、ライブと同じく PMT の並びが変わったら畳んで `restart` を伝える。観ている側は
 * 届いたぶんを観終えてから、観ていた位置をリクエストし直す (画面もテレビのアプリも)。ただ位置は秒で、
 * バイトへはレートで比例して当てるので、少し手前に当たると前の番組の PMT を読んでからまた変わり、
 * 作り直しを繰り返す。**近くをリクエストされたら、変わったところのバイトから読む** (`resumePlan`)
 */
export interface ChaseResume {
  /** 変わったところ (秒。`ChasePlan.at` と同じ物差し) */
  at: number;
  /** 変わったところ (バイト。188 に揃えてある) */
  offset: number;
  /** これを過ぎたら使わない (ms) */
  until: number;
}

/** 作り直したところから、これだけ (秒) の内をリクエストされたら、そこから読む (`resumePlan`) */
const RESUME_NEAR = 15;
/** 作り直したところを覚えておく長さ (ms)。リクエストし直すのは観終えてから (届いたぶんは倍速で先へ伸びている) */
const RESUME_KEEP = 10 * 60_000;

/**
 * 読んだ量 (`consumed` バイト。`plan` の先頭から) のところで作り直した。どこからリクエストし直せばいいかを返す。
 * 塊の途中で変わったので、**読んだ塊の末尾**から読む。塊の先頭からだと前の番組の PMT をまた読む
 */
export function resumeFrom(
  plan: ChasePlan,
  consumed: number,
  now = Date.now(),
): ChaseResume {
  return {
    at: plan.at + consumed / plan.bytesPerSec,
    offset: plan.offset + Math.ceil(consumed / PACKET) * PACKET,
    until: now + RESUME_KEEP,
  };
}

/** 作り直したところの近く (`RESUME_NEAR`) をリクエストされたら、変わったところのバイトから読む */
export function resumePlan(
  plan: ChasePlan,
  resume: ChaseResume | undefined,
  now = Date.now(),
): ChasePlan {
  if (
    resume === undefined ||
    now > resume.until ||
    Math.abs(plan.at - resume.at) > RESUME_NEAR
  )
    return plan;
  return { ...plan, offset: resume.offset, at: resume.at };
}

/**
 * どこから読み始めるかを決める。
 *
 * @param size いまのファイルの大きさ (バイト)
 * @param recordedSec いま録れている長さ (秒)。録画中は「録り始めてからの経過」
 * @param atSec リクエストされた再生位置 (秒)
 */
export function chasePlan(
  size: number,
  recordedSec: number,
  atSec: number,
): ChasePlan {
  const usable = Math.max(1, recordedSec);
  const bytesPerSec = size / usable;
  /*
   * 書き込み中の端 (いま書いているところ) ぎりぎりから始めると、キーフレーム待ちで
   * 何も出ないまま追い付いてしまう。少し手前に置く
   */
  const at = Math.min(Math.max(0, atSec), Math.max(0, usable - 5));
  const offset = Math.floor((at * bytesPerSec) / PACKET) * PACKET;
  return {
    offset: Math.min(offset, Math.max(0, size - PACKET)),
    at,
    recordedSec: usable,
    paceBytesPerSec: Math.max(1_000_000, bytesPerSec) * PACE,
    bytesPerSec,
  };
}

/**
 * 伸びているファイルを読み続けるストリーム。
 *
 * 末尾 (EOF) に着いたら書き足されるのを待って読み足す。**録画が終わっていて**
 * 末尾に着いたら、それが本当の終わり。
 *
 * **読む側が詰まっていたら読まない。** 受け取る側 (ffmpeg の標準入力・HTTP の応答) が
 * 先へ進まない間は、こちらも次を読まずに待つ。待たずに読むと、倍速で送り込むぶんが
 * どこかに溜まり続ける。
 *
 * @param done もう書き足されないか (録画が終わったか)。EOF のたびに訊く
 * @param hold ほかの理由で止めておくか (HTTP の追っかけで、エンコードした先が読まれていないとき。
 *   WebSocket の元の TS の追っかけで、止めてと言われたとき・詰まったとき。`live.ts` の `chaseStream`・`openChase`)。
 *   省けば止めない
 * @param burst 倍速の縛りを掛けずに読む先頭のぶん (バイト)。アプリ向けの字幕 API が、リクエストされた位置より
 *   手前から読み始めて観ている位置を追い越すのに使う (`live.ts` の `recordingCaptions`)。省けば 0
 */
export function followFile(
  path: string,
  offset: number,
  paceBytesPerSec: number,
  done: () => boolean,
  hold: () => boolean = () => false,
  burst = 0,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let started = Date.now();
      let sent = 0;
      let position = offset;
      const handle = await openRecording(path);
      try {
        const buffer = new Uint8Array(READ_SIZE);
        while (!cancelled) {
          if ((controller.desiredSize ?? 1) <= 0 || hold()) {
            // 止めていた間は倍速の持ち分に数えない。数えると、止めたあとにそのぶんを縛り無しで読む
            const waited = Date.now();
            await Bun.sleep(WAIT_READER);
            started += Date.now() - waited;
            continue;
          }
          const { bytesRead } = await handle.read(
            buffer,
            0,
            READ_SIZE,
            position,
          );
          if (bytesRead > 0) {
            position += bytesRead;
            sent += bytesRead;
            controller.enqueue(buffer.slice(0, bytesRead));
            // 倍速より先へは行かない (上の説明)。遅れているぶんは眠らず進む
            const ahead =
              Math.max(0, sent - burst) / paceBytesPerSec -
              (Date.now() - started) / 1000;
            if (ahead > 0) await Bun.sleep(ahead * 1000);
            continue;
          }
          // 末尾に着いた。録画が終わっていれば読み切った、まだなら待って読み足す
          if (done()) break;
          await Bun.sleep(WAIT_MORE);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await handle.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

/** いまのファイルの大きさ。無ければ null (消された・まだ書き始めていない) */
export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** 読んだ先頭の控え。録画中も先頭は変わらないので、読めたものはパスごとに覚える (追っかけはシークのたびに聞く) */
const heads = new Map<string, number>();
/** 控えごとに覚えておく数 (`heads`・`unreadable`・`spans`)。追っかけと字幕で同時に読む録画はいくつもない */
const HEADS_MOST = 32;
/** 読めなかったパスと、次に読み直してよい時刻 (ms)。録り始めの数秒は先頭が揃わないので、シークのたびに 4MB 読み直さない */
const unreadable = new Map<string, number>();
/** 読めなかったあと、読み直すまで控える長さ (ms) */
const HEAD_RETRY = 5_000;

/** 尺を測るのに先頭と末尾から読む量。映像と音声の最初の PES、最後の映像の PES が入る長さ (`playback.ts` の `probeTs` と同じ) */
const SPAN_BYTES = 4 * 1024 * 1024;

/** 測った尺の控え。同じファイル (大きさ・更新時刻) なら読み直さない */
const spans = new Map<string, { key: string; seconds: number | null }>();

/** ファイルの `offset` から `length` バイトを同期で読む */
function readRange(
  file: RecordingSyncHandle,
  offset: number,
  length: number,
): Uint8Array {
  const buffer = new Uint8Array(length);
  return buffer.subarray(0, file.read(buffer, 0, length, offset));
}

/**
 * **録り終えた元の TS の尺 (秒)。** 先頭の PTS (`tsHead`) から最後の映像の PES まで。観る画面の物差し
 * (`playback.ts` の `probeTs`) と同じ測り方。読めない・PES が見つからなければ null。
 *
 * 追っかけと録画の字幕は、呼ばれたその場で読み始める位置を決めるので同期で読む (先頭と末尾の 4MB ずつ)。
 * 測ったものは控える (シークのたびに読み直さない)
 */
export function finishedTsSec(path: string): number | null {
  let size = 0;
  let key = "";
  try {
    const stat = statSync(path);
    size = stat.size;
    key = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const held = spans.get(path);
  if (held?.key === key) return held.seconds;
  let seconds: number | null = null;
  try {
    const file = openRecordingSync(path);
    try {
      const head = tsHead(readRange(file, 0, SPAN_BYTES));
      const last =
        head === null
          ? null
          : lastVideoPts(
              readRange(file, Math.max(0, size - SPAN_BYTES), SPAN_BYTES),
            );
      const span = head === null || last === null ? 0 : sinceHead(last, head);
      seconds = span > 0 ? span : null;
    } finally {
      file.close();
    }
  } catch {
    seconds = null;
  }
  if (spans.size >= HEADS_MOST) spans.delete(spans.keys().next().value!);
  spans.set(path, { key, seconds });
  return seconds;
}

/**
 * **元の TS に録れている長さ (秒)。** 追っかけと録画の字幕が、秒をバイトに比例で当てる物差し (`chasePlan`)。
 *
 * - 録っている最中は、録り始めてからの経過
 * - 録り終えたものは、元の TS を測った尺 (`finishedTsSec`)。**`duration_ms` は使わない。** エンコードし終えると
 *   出来上がりの長さ (先頭を捨てたあと) に書き換わる (`encoder.ts`) ので TS より短く、位置が先へずれていた
 * - 測れなければ、エンコードしていない録画 (`encode_skip` が NULL) は `duration_ms` (録れた長さ)、それも無ければ番組表の尺
 */
export function recordedSec(
  rec: Pick<
    Recording,
    | "finished_at"
    | "created_at"
    | "duration_ms"
    | "encode_skip"
    | "start_at"
    | "end_at"
  >,
  path: string,
  now = Date.now(),
): number {
  if (rec.finished_at === null) return (now - rec.created_at) / 1000;
  const measured = finishedTsSec(path);
  if (measured !== null) return measured;
  const recorded = rec.encode_skip === null ? rec.duration_ms : null;
  return (recorded ?? rec.end_at - rec.start_at) / 1000;
}

/**
 * **元の TS の先頭の PTS** (90kHz。`ts/seek.ts` の `readHead`)。追っかけを元の TS で送るとき、画面が再生位置を
 * 出す物差しの 0 (`live.ts` の `openChase`)。読めたものは覚える。録り始めたばかりで先頭の PES が揃わない・読めなければ
 * null で、`HEAD_RETRY` の間は読み直さずに null を返す
 */
export async function tsFileHead(
  path: string,
  now = Date.now(),
): Promise<number | null> {
  const held = heads.get(path);
  if (held !== undefined) return held;
  if ((unreadable.get(path) ?? 0) > now) return null;
  let head: number | null = null;
  try {
    const handle = await openRecording(path);
    try {
      head = await readHead(async (offset, length) => {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      });
    } finally {
      await handle.close();
    }
  } catch {
    head = null;
  }
  if (head === null) {
    if (unreadable.size >= HEADS_MOST)
      unreadable.delete(unreadable.keys().next().value!);
    unreadable.set(path, now + HEAD_RETRY);
    return null;
  }
  unreadable.delete(path);
  if (heads.size >= HEADS_MOST) heads.delete(heads.keys().next().value!);
  heads.set(path, head);
  return head;
}

/**
 * **追っかけを元の TS で送るとき、録画のファイルを読むのを止めるか** (`followFile` の `hold`。`live.ts` の `openChase`)。
 * 元の TS は捨てると観ていない先が欠けるので、捨てる代わりに読むほうを止める。どれか 1 つでも当たれば止める
 */
export function chaseReadHeld(o: {
  /** 画面が止めてほしいと送ってきた (`{ type: 'hold', on: true }`) */
  asked: boolean;
  /** 送り先のバッファが捨て始める量を超えている (`ws.ts` の `Connection.congested`。回線が倍速に追いつかない) */
  congested: boolean;
  /** 呼ぶ側のほかの理由 (HTTP の追っかけで読まれていない、など) */
  outside: boolean;
}): boolean {
  return o.asked || o.congested || o.outside;
}
