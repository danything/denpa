/**
 * **Windows と Mac のスリープ。** 録画・ライブ視聴・エンコードの間はスリープさせず (`awake.ts`)、
 * 次の録画の少し前にスリープから起こす。ほかの OS では何もしない (Linux はサーバとして動かす前提)。
 *
 * - Windows は、denpa 本体 (install.ps1 を流したユーザーか SYSTEM のタスク) が kernel32 の待機可能タイマーを
 *   「スリープから起こす」指定で設定する (`awake.windowsWake`。特別な権限は要らない)。タイマーは本体のプロセスが持ち、本体が止まれば OS が消す。
 *   効くのは、電源オプションの「スリープ解除タイマーの許可」が有効なときだけ (docs/install-windows.md)
 * - Mac は、denpa 本体 (root の LaunchDaemon) が IOKit の `IOPMSchedulePowerEvent` で起こす予約を置く (root が要る)。
 *   予約は OS が覚えていて、本体が起き直しても残るので、置いた時刻をデータの置き場の `wake-at` に書き、
 *   次に置き直すときと起動したときに取り消す (docs/install-mac.md)
 *
 * どちらも、次の録画が変わるたびに時刻を設定し直し、録画が無ければ取り消す。設定できなければ、理由をログと
 * 設定の「バージョンと環境」に出す (`wakeStatus`)。
 *
 * 外からの視聴の要求ではスリープから起こせない (寝ている機械は要求を受けられない)。外からいつも観るなら、
 * スリープしない設定にする (docs/install-windows.md・docs/install-mac.md)
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, asc, eq, gt, isNull } from "drizzle-orm";

import {
  holdAwake,
  type MacPower,
  macPower,
  type WindowsWake,
  windowsWake,
} from "./awake";
import { config } from "./config";
import { orm } from "./db";
import { runningEncodes } from "./encoder";
import { hasLiveViewers } from "./live";
import { activeRecordingIds } from "./recorder";
import { plannedStartSql } from "./recording";
import { reservations } from "./schema";

const MIN = 60_000;

/** 起こすのは、録画を始める時刻 (前のマージン込み) のこれだけ前 */
export const WAKE_LEAD = 3 * MIN;
/**
 * 録画を始めるまでがこれより短ければ、もうスリープさせない。**起こしたあとに眠り直させないため。**
 * 人の操作が無いまま起きた Windows は、2 分ほどでまた眠る (無人のスリープ解除のタイムアウトの既定)。
 * 起こす時刻 (`WAKE_LEAD`) より長くしておく
 */
export const HOLD_BEFORE = 5 * MIN;

/**
 * 次に録画を始める時刻 (前のマージン込み)。無ければ null。
 * チューナーを譲って冒頭を削った予約は、譲ったぶんのあと (`record_from`) から録るので、そこに合わせて起こす (`recording.plannedStart`)
 */
function nextRecording(at: number): number | null {
  const next = orm()
    .select({ from: plannedStartSql() })
    .from(reservations)
    .where(
      and(
        eq(reservations.state, "scheduled"),
        isNull(reservations.started_at),
        gt(plannedStartSql(), at),
      ),
    )
    .orderBy(asc(plannedStartSql()))
    .get();
  return next === undefined ? null : next.from;
}

/**
 * スリープさせないか。録画中・エンコード中・ライブを観ている人がいる、か次の録画が近い (`HOLD_BEFORE`)
 */
export function shouldHold(o: {
  recording: boolean;
  encoding: boolean;
  watching: boolean;
  next: number | null;
  now: number;
}): boolean {
  return (
    o.recording ||
    o.encoding ||
    o.watching ||
    (o.next !== null && o.next - o.now < HOLD_BEFORE)
  );
}

/** タイマーを設定した (Mac は予約を置いた) 時刻 (起こす時刻)。null は取り消したあと、undefined はまだ何もしていない */
let written: number | null | undefined;
/** 起こせない理由。起こせていれば null。ログには理由が変わったときだけ出す */
let problem: string | null = null;

function fail(reason: string): void {
  if (reason !== problem)
    console.warn(
      `[power] 録画の前にスリープから起こせません。スリープしている間は録画が始まりません: ${reason}`,
    );
  problem = reason;
}

function scheduled(at: number): void {
  written = at;
  problem = null;
  console.log(
    `[power] ${new Date(at).toLocaleString("ja-JP")} にスリープから起こします (次の録画の ${WAKE_LEAD / MIN} 分前)`,
  );
}

/** 起こす様子 (設定の「バージョンと環境」)。`at` は起こす時刻 (無ければ null)、`problem` は起こせない理由 */
export interface WakeStatus {
  at: number | null;
  problem: string | null;
}

/** いまの起こす様子。Windows と Mac 以外では null (起こさない) */
export function wakeStatus(now = Date.now()): WakeStatus | null {
  if (process.platform !== "win32" && process.platform !== "darwin")
    return null;
  return wakeState(now);
}

/**
 * OS によらない中身 (単体テストが使う)。起こす時刻を過ぎたら (もう起きている) `at` は null にする。
 * 過ぎたあとは設定し直さず (`scheduleWakeWindows`)、`written` に前の時刻が残るため
 */
export function wakeState(now: number): WakeStatus {
  const at = typeof written === "number" && written > now ? written : null;
  return { at, problem };
}

/**
 * Windows: 起こすタイマーを `at` に設定し直す (null なら取り消す)。同じなら何もしない。
 * **タスク スケジューラのタスク (前の `denpa-wake`) にしないのは、本体をユーザーで動かすと書き換えられないため。**
 * SYSTEM で動かすタスクは管理者でないと登録し直せず、本体のユーザーで動かすタスクは、ログオンしていなくても動かすのに
 * そのユーザーのパスワードが要る (本体は持たない)。待機可能タイマーは権限が要らず、どちらのユーザーでも同じに設定できる
 */
export async function scheduleWakeWindows(
  at: number | null,
  now: number,
  getTimer: () => Promise<WindowsWake | null> = windowsWake,
): Promise<void> {
  if (at === written) return;
  // 起こす録画が無ければ、起こせない理由も消す (次の録画で設定するときに、また確かめる)
  if (at === null) problem = null;
  // 一度も設定していなければ、取り消すものは無い
  if (at === null && written === undefined) {
    written = null;
    return;
  }
  // 起こす時刻を過ぎていれば設定しない (もう起きている。録画が始まるまで `HOLD_BEFORE` でスリープさせない)
  if (at !== null && at <= now) return;
  const timer = await getTimer();
  if (timer === null) {
    fail("kernel32 の待機可能タイマーを使えません (理由はログにあります)");
    return;
  }
  if (at === null) {
    timer.cancel();
    written = null;
    return;
  }
  // 設定できなければ written を変えず、次の定期チェックで設定し直す
  const reason = timer.set(at);
  if (reason === null) scheduled(at);
  else fail(reason);
}

/** Mac で起こす予約に付ける名前 (`pmset -g sched` に出る)。止まるときに本体が取り消す (`forgetWake`) */
const WAKE_BY = "denpa";

/** Mac で置いた予約の時刻 (ms) を書くファイル。起き直したあとに、前の起動が置いた予約を取り消すため */
function wakeFile(): string {
  return join(config.dataDir, "wake-at");
}

/** 前の起動が置いた予約の時刻。無ければ null */
function lastWake(): number | null {
  try {
    const at = Number(readFileSync(wakeFile(), "utf8").trim());
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * **秒で丸めた時刻。** 予約は置いたときと同じ時刻を渡さないと取り消せない。OS が覚える時刻の細かさに頼らないよう、
 * 置くときも取り消すときも秒にそろえる
 */
export function wakeSecond(at: number): number {
  return Math.floor(at / 1000) * 1000;
}

/** Mac の電源の呼び出し。予約を置いたときに読んだもの (`forgetWake` が止まる間際に同期で使う) */
let mac: MacPower | null = null;

/**
 * **Mac: 止まるときに、置いた予約を取り消す** (`runtime.ts` の後始末)。動いている本体がいなければ、起こしても録画は始まらない。
 * 起き直せば次の定期チェックで置き直す。外したとき (install.sh の `--uninstall`) に予約を残さないためでもある。
 * Windows は何もしない (タイマーは本体のプロセスが終われば OS が消す)
 */
export function forgetWake(): void {
  if (mac === null || typeof written !== "number") return;
  mac.cancel(written, WAKE_BY);
  rmSync(wakeFile(), { force: true });
  written = null;
}

/**
 * Mac: 起こす予約を `at` に置き直す (null なら取り消す)。同じなら何もしない。
 * 前の予約 (この起動で置いたものか、`wake-at` に書いてあるもの) は先に取り消す。過ぎた予約はもう無いので、
 * 取り消せなくてよい
 */
async function scheduleWakeMac(at: number | null, now: number): Promise<void> {
  const target = at === null ? null : wakeSecond(at);
  if (target === written) return;
  // 起こす時刻を過ぎていれば置かない (Windows と同じ)
  if (target !== null && target <= now) return;
  const power = await macPower();
  if (power === null) {
    fail("IOKit を読めません (理由はログにあります)");
    return;
  }
  mac = power;
  const previous = written === undefined ? lastWake() : written;
  if (previous !== null) power.cancel(previous, WAKE_BY);
  written = null;
  if (target === null) {
    rmSync(wakeFile(), { force: true });
    problem = null;
    return;
  }
  const code = power.schedule(target, WAKE_BY);
  if (code !== 0) {
    rmSync(wakeFile(), { force: true });
    fail(
      `IOPMSchedulePowerEvent が 0x${(code >>> 0).toString(16)} を返しました。root で動いていないと置けません`,
    );
    return;
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(wakeFile(), String(target));
  scheduled(target);
}

/** 定期に呼ぶ (`runtime.ts`)。Windows と Mac 以外では何もしない */
export async function checkPower(now = Date.now()): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "darwin") return;
  const next = nextRecording(now);
  await holdAwake(
    shouldHold({
      recording: activeRecordingIds().length > 0,
      encoding: runningEncodes() > 0,
      watching: hasLiveViewers(),
      next,
      now,
    }),
  );
  const at = next === null ? null : next - WAKE_LEAD;
  await (process.platform === "win32"
    ? scheduleWakeWindows(at, now)
    : scheduleWakeMac(at, now));
}
