/**
 * **直近の再生で画質の段を動かした記録** (設定の「その他」→「ログ」の「Issue にする」に入れる)。
 *
 * 段を動かす判断 (`adapt.ts` の `RungAdapter.tick`) が出るたびに、そのときの理由・受け取りの速さ・段に要る速さ・
 * コーデックを端末に覚える (localStorage)。サーバには送らない。「回線が細いため、720p に下げました」が出た理由を、
 * 報告した人に聞き直さずに読むためのもの。
 *
 * 新しい `PLAYBACK_KEEP` 件までで、古いものから捨てる。同じ判断が続くあいだ (サーバのエンコードが追いつかない間など、
 * 刻むたびに同じものが返る) は `REPEAT_GAP` に 1 件だけ覚える。localStorage を読み書きできないブラウザ (プライベートブラウズなど)
 * では覚えないだけ (`keep.ts`)。タブを 2 つ同時に開いて再生すると、同じときに書いた片方の件が残らないことがある
 */

import type { AdaptDecision, AdaptSample, Step } from "./adapt";
import type { LogSource } from "./issue-report";
import { read, write } from "./keep";

const KEY = "denpa.playback-events";
/** 覚えておく件数 */
export const PLAYBACK_KEEP = 40;
/** 同じ判断 (理由と段が同じ) を重ねて覚えない間 (ms) */
export const REPEAT_GAP = 60_000;

/** どの画面で再生していたか。パスの先頭から読む (録画の ID のような後ろは残さない) */
type PlaybackScreen = "live" | "chase" | "watch";

/** 1 件の記録 */
export interface PlaybackEvent {
  /** epoch ミリ秒 */
  at: number;
  screen: PlaybackScreen | null;
  reason: AdaptDecision["reason"];
  /** 動かす前の段 */
  from: Step;
  /** 動かした先の段。`encode`・`pinned` では `from` と同じ */
  to: Step;
  /** 画面に出した断り書き (`adaptNote`) */
  note: string;
  /** 受け取っていたコーデック (`h264`・`mpeg2` など)。分からなければ null */
  codec: string | null;
  /** 測った受け取りの速さ (bit/s)。測れていなければ null */
  throughput: number | null;
  /** 段に要る速さ (bit/s)。上げたときは上げた先の段、それ以外はいまの段 */
  need: number | null;
  /** ライブで測った回線の速さ (bit/s)。測っていなければ null */
  capacity: number | null;
  /** サーバのエンコードの速さ (`Pace.speed`)。エンコードしない経路は null */
  speed: number | null;
  /** 先に溜まっていた長さ (秒) */
  ahead: number;
  /** 形式を手で選んでいたか */
  manual: boolean;
}

const SCREEN_OF = /\/(live|chase|watch)(?:\/|$)/;

/** いまのパスの画面。分からなければ null */
function currentScreen(): PlaybackScreen | null {
  if (typeof location === "undefined") return null;
  const match = SCREEN_OF.exec(location.pathname);
  return match === null ? null : (match[1] as PlaybackScreen);
}

/** 判断と様子から 1 件を作る (`RungAdapter.tick` が呼ぶ) */
export function playbackEvent(
  sample: AdaptSample,
  decision: AdaptDecision,
  note: string,
  need: number | null,
): PlaybackEvent {
  return {
    at: sample.now,
    screen: currentScreen(),
    reason: decision.reason,
    from: sample.current,
    to: decision.step,
    note,
    codec: sample.codec ?? null,
    throughput: sample.throughput,
    need,
    capacity: sample.capacity?.bps ?? null,
    speed: sample.pace?.speed ?? null,
    ahead: sample.ahead,
    manual: sample.manual,
  };
}

/** 同じ判断 (理由と段が同じ) を `REPEAT_GAP` のうちに覚えているか */
const repeats = (earlier: PlaybackEvent, event: PlaybackEvent) =>
  earlier.reason === event.reason &&
  earlier.from === event.from &&
  earlier.to === event.to &&
  event.at - earlier.at >= 0 &&
  event.at - earlier.at < REPEAT_GAP;

/**
 * 足した並び (古い順)。同じ判断を `REPEAT_GAP` のうちに覚えていれば足さない。
 * 直前の 1 件だけと比べると、`encode` と `pinned` が交互に出たときに間引けないので、間のうちの件を全部見る
 */
export function pushPlayback(
  list: readonly PlaybackEvent[],
  event: PlaybackEvent,
): PlaybackEvent[] {
  if (list.some((earlier) => repeats(earlier, event))) return [...list];
  return [...list, event].slice(-PLAYBACK_KEEP);
}

const STEPS = new Set<unknown>([0, 1, 2, 3, "audio"]);
const REASONS = new Set<unknown>([
  "slow",
  "restored",
  "encode",
  "pinned",
  "decode",
]);
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 文字列から読む。形式が違う件は捨てる */
export function parsePlayback(raw: string | null): PlaybackEvent[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: PlaybackEvent[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e["at"] !== "number" ||
      !REASONS.has(e["reason"]) ||
      !STEPS.has(e["from"]) ||
      !STEPS.has(e["to"]) ||
      typeof e["note"] !== "string"
    )
      continue;
    out.push({
      at: e["at"],
      screen:
        e["screen"] === "live" ||
        e["screen"] === "chase" ||
        e["screen"] === "watch"
          ? e["screen"]
          : null,
      reason: e["reason"] as PlaybackEvent["reason"],
      from: e["from"] as Step,
      to: e["to"] as Step,
      note: e["note"],
      codec: typeof e["codec"] === "string" ? e["codec"] : null,
      throughput: numberOrNull(e["throughput"]),
      need: numberOrNull(e["need"]),
      capacity: numberOrNull(e["capacity"]),
      speed: numberOrNull(e["speed"]),
      ahead: numberOrNull(e["ahead"]) ?? 0,
      manual: e["manual"] === true,
    });
  }
  return out.slice(-PLAYBACK_KEEP);
}

/** 覚えている記録 (古い順) */
export function loadPlayback(): PlaybackEvent[] {
  return parsePlayback(read(KEY));
}

/**
 * この画面で覚えた件のうち、`REPEAT_GAP` のうちのもの。同じ判断が刻むたびに返る間 (`encode`・`pinned`) は、
 * localStorage を読まずに間引く
 */
let recent: PlaybackEvent[] = [];

/** 1 件覚える */
export function rememberPlayback(event: PlaybackEvent): void {
  recent = recent.filter((earlier) => event.at - earlier.at < REPEAT_GAP);
  if (recent.some((earlier) => repeats(earlier, event))) return;
  recent.push(event);
  const list = loadPlayback();
  const next = pushPlayback(list, event);
  if (next.length !== list.length || next.at(-1) !== list.at(-1))
    write(KEY, JSON.stringify(next));
}

const SCREEN_LABEL: Record<PlaybackScreen, string> = {
  live: "ライブ",
  chase: "追っかけ",
  watch: "観る画面",
};

const STEP_LABEL: Record<Exclude<Step, "audio">, string> = {
  0: "元の画質",
  1: "720p",
  2: "540p",
  3: "360p",
};

const stepName = (step: Step) =>
  step === "audio" ? "音声だけ" : STEP_LABEL[step];

/** bit/s を `3.2 Mbit/s` に */
const mbps = (bps: number | null) =>
  bps === null ? "—" : `${(bps / 1_000_000).toFixed(1)} Mbit/s`;

/** 報告に書く 1 行 (時刻は付けない。`issue-report.ts` が付ける) */
export function playbackText(event: PlaybackEvent): string {
  const parts = [
    event.screen === null ? null : SCREEN_LABEL[event.screen],
    event.codec,
    event.from === event.to
      ? stepName(event.from)
      : `${stepName(event.from)} → ${stepName(event.to)}`,
    `受け取り ${mbps(event.throughput)}`,
    `必要 ${mbps(event.need)}`,
    event.capacity === null ? null : `測った回線 ${mbps(event.capacity)}`,
    event.speed === null ? null : `エンコードの速さ ${event.speed.toFixed(2)}`,
    `バッファ ${event.ahead.toFixed(1)} 秒`,
    event.manual ? "形式を手で選択" : null,
  ].filter((part) => part !== null && part !== "");
  return `${event.note} (${parts.join("・")})`;
}

/**
 * **報告に入れる再生の記録** (この端末で覚えているもの)。下げたもの・止まるものは警告、上げたものはふつうの行にする。
 * URL に入りきらないときは、ほかの見出しより先に選ぶ (`first`)
 */
export function playbackSource(events: readonly PlaybackEvent[]): LogSource {
  return {
    label: "この端末の再生",
    tagged: true,
    first: true,
    lines: events.map((event) => ({
      at: event.at,
      level: event.reason === "restored" ? "info" : "warn",
      text: playbackText(event),
    })),
  };
}
