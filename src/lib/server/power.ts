/**
 * **Windows と Mac のスリープ。** 録画・ライブ視聴・エンコードの間はスリープさせず (`awake.ts`)、
 * 次の録画の少し前にスリープから起こす。ほかの OS では何もしない (Linux はサーバとして動かす前提)。
 *
 * - Windows は、denpa 本体 (SYSTEM のタスク) がタスク `denpa-wake` (タスク スケジューラの「スリープを解除して実行」) を
 *   書き直して起こす。中身は何もしないコマンドで、起こすためだけにある。効くのは、電源オプションの
 *   「スリープ解除タイマーの許可」が有効なときだけ (docs/install-windows.md)
 * - Mac は、denpa 本体 (root の LaunchDaemon) が IOKit の `IOPMSchedulePowerEvent` で起こす予約を置く (root が要る)。
 *   予約は OS が覚えていて、本体が起き直しても残るので、置いた時刻をデータの置き場の `wake-at` に書き、
 *   次に置き直すときと起動したときに取り消す (docs/install-mac.md)
 *
 * どちらも、次の録画が変わるたびに時刻を書き直し、録画が無ければ消す。
 *
 * 外からの視聴の要求ではスリープから起こせない (寝ている機械は要求を受けられない)。外からいつも観るなら、
 * スリープしない設定にする (docs/install-windows.md・docs/install-mac.md)
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { holdAwake, type MacPower, macPower } from "./awake";
import { config } from "./config";
import { orm } from "./db";
import { runningEncodes } from "./encoder";
import { hasLiveViewers } from "./live";
import { activeRecordingIds } from "./recorder";
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

/** 起こすタスクの名前。install.ps1 が外すときに消す */
const WAKE_TASK = "denpa-wake";

/** 次に録画を始める時刻 (前のマージン込み)。無ければ null */
function nextRecording(at: number): number | null {
  const next = orm()
    .select({ start_at: reservations.start_at })
    .from(reservations)
    .where(
      and(
        eq(reservations.state, "scheduled"),
        isNull(reservations.started_at),
        gt(reservations.start_at, at),
      ),
    )
    .orderBy(asc(reservations.start_at))
    .get();
  return next === undefined ? null : next.start_at - config.startMargin;
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

/** 起こすタスクの XML (タスク スケジューラの形式)。`at` はスリープから起こす時刻 (ms)。UTC で書く */
export function wakeTaskXml(at: number): string {
  const start = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>denpa が次の録画の前にスリープから起こすためのタスク (denpa 本体が書き直す)</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\\System32\\cmd.exe</Command>
      <Arguments>/d /c exit 0</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** タスク (Mac は予約) を書いた時刻 (起こす時刻)。null は消したあと、undefined はまだ何もしていない */
let written: number | null | undefined;
/** 書けなかったことは 1 度だけ知らせる */
let failed = false;

async function schtasks(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(["schtasks.exe", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code === 0) return true;
  if (!failed) {
    failed = true;
    console.warn(
      `[power] 録画の前にスリープから起こすタスク (${WAKE_TASK}) を書けません。スリープしている間は録画が始まりません: ${stderr.trim()}`,
    );
  }
  return false;
}

/** Windows: 起こすタスクを `at` に書き直す (null なら消す)。同じなら何もしない */
async function scheduleWakeTask(at: number | null, now: number): Promise<void> {
  if (at === written) return;
  if (at === null) {
    // 無いものは消さない (初めての起動など)。あるのに消せなければ、次に見たときにもう一度消す
    const exists =
      (await Bun.spawn(["schtasks.exe", "/Query", "/TN", WAKE_TASK], {
        stdio: ["ignore", "ignore", "ignore"],
      }).exited) === 0;
    if (!exists || (await schtasks(["/Delete", "/TN", WAKE_TASK, "/F"])))
      written = null;
    return;
  }
  // 起こす時刻を過ぎていれば書かない (もう起きている。録画が始まるまで `HOLD_BEFORE` でスリープさせない)
  if (at <= now) return;
  const file = join(config.dataDir, "wake-task.xml");
  mkdirSync(config.dataDir, { recursive: true });
  // schtasks は UTF-16 (BOM 付き) の XML を読む
  writeFileSync(file, `﻿${wakeTaskXml(at)}`, "utf16le");
  if (await schtasks(["/Create", "/TN", WAKE_TASK, "/XML", file, "/F"])) {
    written = at;
    failed = false;
    console.log(
      `[power] ${new Date(at).toLocaleString("ja-JP")} にスリープから起こします (次の録画の ${WAKE_LEAD / MIN} 分前)`,
    );
  }
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
 * Windows は何もしない (起こすタスクは install.ps1 が外す)
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
  if (power === null) return;
  mac = power;
  const previous = written === undefined ? lastWake() : written;
  if (previous !== null) power.cancel(previous, WAKE_BY);
  written = null;
  if (target === null) {
    rmSync(wakeFile(), { force: true });
    return;
  }
  const code = power.schedule(target, WAKE_BY);
  if (code !== 0) {
    rmSync(wakeFile(), { force: true });
    if (!failed) {
      failed = true;
      console.warn(
        `[power] 録画の前にスリープから起こす予約を置けません (IOPMSchedulePowerEvent が 0x${(code >>> 0).toString(16)} を返しました。root で動いていないと置けません)。スリープしている間は録画が始まりません`,
      );
    }
    return;
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(wakeFile(), String(target));
  written = target;
  failed = false;
  console.log(
    `[power] ${new Date(target).toLocaleString("ja-JP")} にスリープから起こします (次の録画の ${WAKE_LEAD / MIN} 分前)`,
  );
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
    ? scheduleWakeTask(at, now)
    : scheduleWakeMac(at, now));
}
