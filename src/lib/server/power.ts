/**
 * **Windows のスリープ。** 録画・ライブ視聴・エンコードの間はスリープさせず (`awake.ts`)、
 * 次の録画の少し前にスリープから起こす (タスク スケジューラの「スリープを解除して実行」)。
 * Windows 以外では何もしない (Linux はサーバとして動かす前提。Mac は別にする)。
 *
 * 起こすのは、denpa 本体 (SYSTEM のタスク) がタスク `denpa-wake` を書き直して行う。中身は何もしない
 * コマンドで、起こすためだけにある。次の録画が変わるたびに時刻を書き直し、録画が無ければ消す。
 * 効くのは、電源オプションの「スリープ解除タイマーの許可」が有効なときだけ (docs/install-windows.md)。
 *
 * 外からの視聴の要求ではスリープから起こせない (寝ている機械は要求を受けられない)。外からいつも観るなら、
 * スリープしない設定にする (docs/install-windows.md)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { holdAwake } from "./awake";
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
export const WAKE_TASK = "denpa-wake";

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

/** タスクを書いた時刻 (起こす時刻)。null は消したあと、undefined はまだ何もしていない */
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

/** 起こすタスクを `at` に書き直す (null なら消す)。同じなら何もしない */
async function scheduleWake(at: number | null, now: number): Promise<void> {
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

/** 定期に呼ぶ (`runtime.ts`)。Windows 以外では何もしない */
export async function checkPower(now = Date.now()): Promise<void> {
  if (process.platform !== "win32") return;
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
  await scheduleWake(next === null ? null : next - WAKE_LEAD, now);
}
