/**
 * ホームを開いたときの位置 (`routes/+page.svelte`)。
 *
 * **観終えていない録画があれば、いちばん古いものを映す** — 溜まったぶんを古い順に片付けられるように。
 * 無ければ「いま」の線。どれを映すかと、描いていない所 (60 件より先) を描かせるのは呼ぶ側
 * (`#lib/timeline.ts` の `catchUp`・`Paged.showUpTo`)。ここは描き終えた一覧を送るだけ
 */

/** 広い画面は一覧の枠が、狭い画面はページごとスクロールする */
function scroller(list: HTMLElement): HTMLElement | null {
    return getComputedStyle(list).overflowY === 'auto' ? list : null;
}

/** 一覧の上に被さるもの (狭い画面の頭の段・日付の見出し) の高さ */
function coverOf(): number {
    const bar = document.querySelector<HTMLElement>('[data-testid="timeline-toolbar"]');
    return (bar !== null && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0) + 32;
}

function tabbarHeight(): number {
    return document.querySelector<HTMLElement>('[data-testid="tabbar"]')?.offsetHeight ?? 0;
}

/** 要素の上端が、見えている所の上から `offset` の位置に来るよう送る */
function scrollToTop(list: HTMLElement, element: HTMLElement, offset: number): void {
    const box = scroller(list);
    if (box !== null) {
        box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
    } else {
        window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - offset });
    }
}

/**
 * 開いたときの位置に送る。線を見えている所の 3 割ほどの高さに置き (上に次の予約、下に新しい録画が入る)、
 * `target` (映したい録画の行の鍵) があって線のままでは見えなければ、その行が下の端に来るまで送る。
 * 閉じた番組の中にあれば、その見出し (`data-group-rows`)
 */
export function placeTimeline(list: HTMLElement, target: string | null): void {
    const now = list.querySelector<HTMLElement>('[data-testid="timeline-now"]');
    if (now === null) return;
    const box = scroller(list);
    const height = box !== null ? box.clientHeight : window.innerHeight;
    const cover = coverOf();
    scrollToTop(list, now, cover + (height - cover) * 0.25);
    const row =
        target === null
            ? null
            : (list.querySelector<HTMLElement>(`[data-key="${target}"]`) ??
              list.querySelector<HTMLElement>(`[data-group-rows~="${target}"]`));
    if (row !== null) {
        const bottom = box !== null ? box.getBoundingClientRect().bottom : window.innerHeight;
        if (row.getBoundingClientRect().bottom > bottom - 8) {
            scrollToTop(list, row, height - row.offsetHeight - 16 - (box === null ? tabbarHeight() : 0));
        }
    }
    alignTop(list);
}

/** 一覧の見えている所の上端 (広い画面は枠の上、狭い画面は貼り付いた頭の段の下) */
function topEdge(list: HTMLElement): number {
    const box = scroller(list);
    if (box !== null) return box.getBoundingClientRect().top;
    const bar = document.querySelector<HTMLElement>('[data-testid="timeline-toolbar"]');
    return bar !== null && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().bottom : 0;
}

function scrollBy(list: HTMLElement, delta: number): void {
    const box = scroller(list);
    if (box !== null) box.scrollTop += delta;
    else window.scrollTo({ top: window.scrollY + delta });
}

/**
 * **止めた所で、見出しも行も途中で切らない。** 側 (予約・録画) ごとに包んだ日付の見出しは、包みの終わりで
 * 押し上げられる。送った先がちょうどそこだと、前の日の見出しが半分だけ頭に残っていた。
 * 半分押し上げられた見出しがあれば、それが隠れきるところまで送る。そのうえで、貼り付いた見出しの
 * 下端に掛かっている行があれば、その行が見出しの裏に隠れきるところまで送る (半分だけ見える行を残さない)。
 * **送るのは先へだけ** — 戻すと、下の端に合わせて映した行 (観終えていない録画) が画面の外へ出る
 */
export function alignTop(list: HTMLElement): void {
    const top = topEdge(list);
    for (const heading of list.querySelectorAll<HTMLElement>('.t-day')) {
        const box = heading.getBoundingClientRect();
        if (box.top < top - 0.5 && box.bottom > top + 0.5) {
            scrollBy(list, box.bottom - top);
            break;
        }
    }
    let line = top;
    for (const heading of list.querySelectorAll<HTMLElement>('.t-day')) {
        const box = heading.getBoundingClientRect();
        if (Math.abs(box.top - top) < 1) line = Math.max(line, box.bottom);
    }
    for (const row of list.querySelectorAll<HTMLElement>(
        '.t-row, .group-head, [data-testid="timeline-now"]',
    )) {
        const box = row.getBoundingClientRect();
        if (box.top < line - 0.5 && box.bottom > line + 0.5) {
            scrollBy(list, box.bottom - line);
            return;
        }
    }
}

/** 絞り込みを替える前に覚えておく、見えている所のいちばん上の行 */
export interface Anchor {
    key: string;
    /** 見えている所の上端から行の上端まで */
    offset: number;
}

/** 見えている所の上のほうで、頭から見えている最初の行の鍵と位置 (貼り付いた日付の見出しの下) */
export function topRow(list: HTMLElement): Anchor | null {
    const top = topEdge(list);
    for (const row of list.querySelectorAll<HTMLElement>('[data-key]')) {
        const box = row.getBoundingClientRect();
        // 頭が切れている行 (見出しの裏に潜りかけ) は飛ばし、頭から見えている最初の行を選ぶ
        if (box.height === 0 || box.top < top + 32) continue;
        return { key: row.dataset['key'] ?? '', offset: box.top - top };
    }
    return null;
}

/**
 * **絞り込みを替えても、見ていた行をその場に残す。** 覚えた行がまだ一覧にあれば、同じ高さに戻す。
 * 無くなっていれば「いま」の線 (開いたときと同じ置き方)。戻せたかを返す
 */
export function restoreRow(list: HTMLElement, anchor: Anchor | null): boolean {
    const row = anchor === null ? null : list.querySelector<HTMLElement>(`[data-key="${anchor.key}"]`);
    if (anchor === null || row === null) {
        placeTimeline(list, null);
        return false;
    }
    scrollBy(list, row.getBoundingClientRect().top - topEdge(list) - anchor.offset);
    return true;
}
