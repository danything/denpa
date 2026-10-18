/**
 * ホーム (`routes/+page.svelte`) の部品が分け合うもの。行・番組の見出し・サイドバーは、
 * 開いた行の覚え・詳細の開き方・削除の2回押しをホームと共有するので、props で何段も渡さずに
 * コンテキストで配る (`setHome` はホームだけが呼ぶ)
 */

import { getContext, setContext } from 'svelte';
import type { Arming } from '#lib/arming.svelte.js';
import type { TimelineItem } from '#lib/timeline.js';
import type { PageData } from '../../../routes/$types';

export type Res = PageData['reservations'][number];
export type Rec = PageData['recordings'][number];
export type Missed = PageData['missed'][number];

/** 時間軸に並べる1行 (`#lib/timeline.ts`)。鍵は種類ごとに接頭辞を付ける (録画と予約でIDの空間が別のため) */
export type Item = TimelineItem &
    ({ kind: 'res'; res: Res } | { kind: 'rec'; rec: Rec } | { kind: 'missed'; res: Missed });

export interface HomeContext {
    /** 描いた時刻。「いま」の線と予約の側分けの物差し */
    readonly clock: number;
    /** サイドバーに出ている行の鍵 */
    readonly pickedKey: string | null;
    /** その行をサイドバーに出す */
    select(key: string): void;
    /** 削除の2回押し (録画と録り逃しで共用。録り逃しの鍵は負の値) */
    readonly deleting: Arming;
    /** 取り消せる予約か */
    cancelable(res: { state: string; end_at: number }): boolean;
    /** その録画を観る画面。観られないものは null */
    watchLink(rec: Rec): string | null;
    /** まだ観ていない録画 (行の点) */
    unwatched(rec: Rec): boolean;
    /** 録画・番組からルールを作る入口 */
    ruleFrom(kind: 'recording' | 'program', id: number): string;
    openReservation(res: Res): void;
    openRecording(rec: Rec): void;
    openMissed(res: Missed): void;
    /** まとめて表示の番組を開く・閉じる (側ごと) */
    toggleGroup(zone: 'future' | 'past', group: string): void;
    /** 日付の見出しの字。今日・明日・昨日は言葉で、ほかは日付 */
    dayLabel(at: number): string;
    /** 「あと 25 分」 */
    untilLabel(at: number): string;
}

const KEY = Symbol('home');

export function setHome(context: HomeContext): void {
    setContext(KEY, context);
}

export function home(): HomeContext {
    return getContext<HomeContext>(KEY);
}

/**
 * 行に付ける (`{@attach}`)。指を乗せたとき・焦点が入ったときに、その行をサイドバーに出す。
 * 行そのものは押すものではない (押す的は中の入口とボタン) ので、属性のハンドラにはしない
 */
export function pickOn(context: HomeContext, key: string) {
    return (row: HTMLElement) => {
        const pick = () => context.select(key);
        row.addEventListener('mouseenter', pick);
        row.addEventListener('focusin', pick);
        return () => {
            row.removeEventListener('mouseenter', pick);
            row.removeEventListener('focusin', pick);
        };
    };
}
