/**
 * ホーム (`routes/+page.svelte`) の部品が分け合うもの。行・番組の見出し・頭の1行は、
 * 開いた行の覚え・詳細の開き方・削除の2回押しをホームと共有するので、props で何段も渡さずに
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

/** 時間軸に並べる1行 (`#lib/timeline.ts`)。鍵は種類ごとに接頭辞を付ける (録画と予約でIDの空間が別のため) */
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
  /** 「完了した予約も表示」「削除済みも表示」の行き先 (入っていれば外した URL) */
  finishedHref: string;
  deletedHref: string;
  showFinished: boolean;
  showDeleted: boolean;
}

/** 絞り込み・状態・表示の切り替え。頭の1行 (`TimelineBar`) とサイドバー (`HomeAside`) が同じものを受ける */
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

export interface HomeContext {
  /** 描いた時刻。「いま」の線と予約の側分けの物差し */
  readonly clock: number;
  /** 「いま」の線に添える一言 (次の録画まで)。次の予約が無ければ null */
  readonly nowStatus: NowStatus | null;
  /**
   * 進み具合のバーを出せる、いちばん上の録画中の行の鍵 (無ければ null。そのときは「いま」の線を見せる)。**録画中は「いま」をその行の進み具合のバーの先に出す** —
   * いまは録っている番組の途中なので、別の線を行の下に引かない。時刻を出すのは 1 本だけ
   */
  readonly firstLiveKey: string | null;
  /** 削除の2回押し (録画と録り逃しで共用。録り逃しの鍵は負の値) */
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
  /** 日付の見出しの字。今日・明日・昨日は言葉で、ほかは日付 */
  dayLabel(at: number): string;
}

const KEY = Symbol("home");

export function setHome(context: HomeContext): void {
  setContext(KEY, context);
}

export function home(): HomeContext {
  return getContext<HomeContext>(KEY);
}
