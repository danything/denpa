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
    if (target === null) return;
    const row =
        list.querySelector<HTMLElement>(`[data-key="${target}"]`) ??
        list.querySelector<HTMLElement>(`[data-group-rows~="${target}"]`);
    if (row === null) return;
    const bottom = box !== null ? box.getBoundingClientRect().bottom : window.innerHeight;
    if (row.getBoundingClientRect().bottom > bottom - 8) {
        scrollToTop(list, row, height - row.offsetHeight - 16 - (box === null ? tabbarHeight() : 0));
    }
}
