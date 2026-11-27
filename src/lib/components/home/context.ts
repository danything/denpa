/**
 * ホーム (`routes/+page.svelte`) の部品が分け合うもの。行と見出し (日付・番組・「いま」) は、
 * 描いた時刻・番組の開け閉め・詳細の開き方・削除の 2 回押しをホームと共有するので、props で何段も渡さずに
 * コンテキストで配る (`setHome` はホームだけが呼ぶ)
 */

import { getContext, setContext } from "svelte";

import type { Arming } from "#lib/arming.svelte.js";
import type { NowStatus } from "#lib/format.js";
import type { Filter, TimelineItem } from "#lib/timeline.js";

import type { PageData } from "../../../routes/$types";

export type Res = PageData["reservations"][number];
export type Rec = PageData["recordings"][number];
export type Missed = PageData["missed"][number];

/** 時間軸に並べる 1 行 (`#lib/timeline.ts`)。キーは種類ごとに接頭辞を付ける (録画と予約で ID の空間が別のため) */
export type Item = TimelineItem &
  (
    | { kind: "res"; res: Res }
    | { kind: "rec"; rec: Rec }
    | { kind: "missed"; res: Missed }
  );

/** 表示の切り替え (`ViewList`) が受けるもの */
export interface ViewControls {
  grouped: boolean;
  setGrouped: (on: boolean) => void;
  /** 新しい順で表示 (上下を返す。`#lib/timeline.ts`) */
  reversed: boolean;
  setReversed: (on: boolean) => void;
  /** 「完了した予約も表示」「削除済みも表示」の行き先 (入っていれば外した URL) */
  finishedHref: string;
  deletedHref: string;
  showFinished: boolean;
  showDeleted: boolean;
}

/** 絞り込み・状態・表示の切り替え。操作の 1 行 (`TimelineBar`) とサイドバー (`HomeAside`) が同じものを受ける */
export interface HomeControls extends ViewControls {
  filter: Filter;
  /** 絞り込みを替える (見ていた行をその場に残す。`routes/+page.svelte`) */
  setFilter: (next: Filter) => void;
  counts: Record<Filter, number>;
  /** 空きと、あと何時間録れるか (`disk.capacity`)。読めなければ null */
  capacity: { free: string; hours: string | null } | null;
  /** エンコードを待っている・している録画 (動いているものが先) */
  encoding: Rec[];
}

interface HomeContext {
  /** 描いた時刻。予約の側分けと並べ方の物差し (読み直すまで変えない) */
  readonly clock: number;
  /** 分ごとに進むいまの時刻 (`#lib/minute-clock.svelte.ts`)。「いま」の時刻・あと何分か・進み具合のバーに使う。一覧は並べ直さない */
  readonly now: number;
  /** 「いま」の行に添える一言 (次の録画まで)。次の予約が無ければ null */
  readonly nowStatus: NowStatus | null;
  /** バーの先に「いま」の時刻を出す、いちばん上の録画中の行のキー (無ければ null で、「いま」の行を見せる。`TimelineHeading`) */
  readonly firstLiveKey: string | null;
  /** 削除の 2 回押し (録画と録り逃しで共用。録り逃しのキーは負の値) */
  readonly deleting: Arming;
  /** 取り消せる予約か */
  cancelable(res: { state: string; end_at: number }): boolean;
  /** その録画を観る画面。観られないものは null */
  watchLink(rec: Rec): string | null;
  /** まだ観ていない録画 (行の点) */
  unwatched(rec: Rec): boolean;
  /** 録画・番組からルールを作る入口 */
  ruleFrom(kind: "recording" | "program", id: number): string;
  openReservation(res: Res): void;
  openRecording(rec: Rec): void;
  openMissed(res: Missed): void;
  /** まとめて表示の番組を開く・閉じる (側ごと) */
  toggleGroup(zone: "future" | "past", group: string): void;
  /** 日付の見出しの字。今日・明日・昨日は言葉で、ほかは西暦つきの日付 */
  dayLabel(at: number): string;
}

const KEY = Symbol("home");

export function setHome(context: HomeContext): void {
  setContext(KEY, context);
}

export function home(): HomeContext {
  return getContext<HomeContext>(KEY);
}
