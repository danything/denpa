/**
 * 追っかけ再生の入口 — **録画中の伸びている元のTSを読み続ける** (issue #16)。
 *
 * チューナーは使わない。電波は録画が既に受けていて、ファイルに書き足されて
 * いる (`recorder.ts`)。ここはそのファイルを尻から追い読みして、ライブ視聴と
 * 同じエンコードの経路 (`live.ts` の Session) に流し込むだけ。何人開いてもチューナー数には
 * 響かず、増えるのは ffmpeg だけ。
 *
 * ## シークはバイト比例で当たりを付ける
 *
 * 元のTSには時間→バイトの索引が無い。放送TSはレートがほぼ一定なので、
 * 「これまで録れた秒数とファイルの大きさ」からバイト/秒を出して比例で飛ぶ。
 * 188バイト (TS パケット) に揃えれば、ffmpeg は次のキーフレームから読み直す。
 * シークのたびに ffmpeg ごと立て直す (ライブの選局し直しと同じ流儀)。
 */

import { statSync } from "node:fs";
import { open } from "node:fs/promises";

import { PACKET } from "../ts/psi";

/** 1回に読む量。露骨に小さいと read の回数だけ損する */
const READ_SIZE = 256 * 1024;

/** 書き足されるのを待つ間隔 (ms)。放送は約2MB/秒なので、これで十分細かい */
const WAIT_MORE = 300;

/** 読む側が詰まっているときに、空くのを待つ間隔 (ms) */
const WAIT_READER = 50;

/**
 * 送り込みの上限 — **実時間の倍速まで。**
 *
 * ffmpeg はファイルなら実時間の数倍でエンコードできるが、そのまま流すと観る側の
 * MSE バッファが際限なく太り (30分の後追いで数百MB)、ブラウザの持ち分を
 * 超えて追記が断られる。倍速なら「観ている先」は常に伸び続け、しかも
 * 観る側に溜まるのは観た速さとの差だけで済む
 */
const PACE = 2;

export interface ChasePlan {
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
 * 読んだ量 (`consumed` バイト。`plan` の頭から) のところで作り直した。どこからリクエストし直せばいいかを返す。
 * 塊の途中で変わったので、**読んだ塊の尻**から — 頭からだと前の番組の PMT をまた読む
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
 * 尻 (EOF) に着いたら書き足されるのを待って読み足す。**録画が終わっていて**
 * 尻に着いたら、それが本当の終わり。
 *
 * **読む側が詰まっていたら読まない。** 受け取る側 (ffmpeg の標準入力・HTTP の応答) が
 * 先へ進まない間は、こちらも次を読まずに待つ。待たずに読むと、倍速で送り込むぶんが
 * どこかに溜まり続ける。
 *
 * @param done もう書き足されないか (録画が終わったか)。EOF のたびに訊く
 * @param hold ほかの理由で止めておくか (HTTP の追っかけで、エンコードした先が読まれていないとき。
 *   `live.ts` の `chaseStream`)。省けば止めない
 * @param burst 倍速の縛りを掛けずに読む頭のぶん (バイト)。アプリ向けの字幕 API が、リクエストされた位置より
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
      const started = Date.now();
      let sent = 0;
      let position = offset;
      const handle = await open(path, "r");
      try {
        const buffer = new Uint8Array(READ_SIZE);
        while (!cancelled) {
          if ((controller.desiredSize ?? 1) <= 0 || hold()) {
            await Bun.sleep(WAIT_READER);
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
          // 尻に着いた。録画が終わっていれば読み切った、まだなら待って読み足す
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
