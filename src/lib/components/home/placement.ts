/**
 * ホームを開いたときの位置 (`routes/+page.svelte`)。
 *
 * **観終えていない録画があれば、いちばん古いものを映す** — 溜まったぶんを古い順に片付けられるように。
 * 無ければ「いま」の線。どれを映すかと、描いていない所 (60 件より先) を描かせるのは呼ぶ側
 * (`#lib/timeline.ts` の `catchUp`・`Paged.showUpTo`)。ここは描き終えた一覧を送るだけ。
 * どの幅でもページごとスクロールする (`home.css`) ので、送るのは window
 */

/**
 * 一覧の下に被さるもの (下のタブと、そのすぐ上に貼り付いた頭の1行) の高さ。
 * 頭の1行を出すのはスマホの形だけで、いつも下に貼り付く (`home.css`)。上に被さるものは日付の見出しだけ
 */
function bottomCover(): number {
  const tab =
    document.querySelector<HTMLElement>('[data-testid="tabbar"]')
      ?.offsetHeight ?? 0;
  const bar = document.querySelector<HTMLElement>(
    '[data-testid="timeline-toolbar"]',
  );
  const below =
    bar !== null && getComputedStyle(bar).display !== "none"
      ? bar.offsetHeight
      : 0;
  return tab + below;
}

/**
 * 開いたときの位置に送る。線を見えている所の 7 割ほどの高さに置き (上に新しい録画、下に次の予約が入る)、
 * `target` (映したい録画の行の鍵) があって線のままでは見えなければ、その行が上の端 (貼り付いた日付の見出しの下)
 * に来るまで戻す。閉じた番組の中にあれば、その見出し (`data-group-rows`)
 */
export function placeTimeline(list: HTMLElement, target: string | null): void {
  const now = list.querySelector<HTMLElement>('[data-testid="timeline-now"]');
  if (now === null) return;
  // 貼り付いた日付の見出しの下端。行はその少し下に置く (`alignTop` が見出しの裏へ送らないように)
  const line =
    topEdge(list) +
    (list.querySelector<HTMLElement>(".t-day")?.offsetHeight ?? 32);
  const bottom = window.innerHeight - bottomCover();
  // 見えている所の高さ (上はヘッダーと見出し、スマホの形は下のタブと頭の1行が被さる)
  const view = bottom - line;
  /*
   * **録画中は線を見せない** (`TimelineHeading`。読み上げの見出しだけ残す)。見せていない線は流れの外に置かれ、
   * 包みの頭に来るので、位置は当てにならない。線のある所 (録画中の行のいちばん下の下端) で数える。
   * 線の位置で数えていた頃は、録画中の行が下のタブの裏に入ったままになることがあった
   */
  const lives = list.querySelectorAll<HTMLElement>(".t-row.live");
  const lastLive = now.classList.contains("visually-hidden")
    ? (lives[lives.length - 1] ?? null)
    : null;
  const lineAt = () =>
    lastLive === null
      ? now.getBoundingClientRect()
      : { top: lastLive.getBoundingClientRect().bottom, height: 0 };
  /*
   * **線がもう見えている (上から 4 割より下で、下に被さるものより上) なら動かさない。**
   * 録れたものが少ないと線は頭の近くにあり、7 割まで下げる余地が無い
   */
  const { top: lineY, height: lineHeight } = lineAt();
  const lineTop = lineY - line;
  if (lineTop < view * 0.4 || lineTop > view - lineHeight)
    scrollPage(lineTop - view * 0.7);
  /*
   * **録画中の行は線のすぐ上にいるので、線と一緒に映す。** 何本も録っていて頭が見出しの裏に入るなら、
   * 線が下の端に掛からない範囲で戻す
   */
  const live = lives[0] ?? null;
  if (live !== null) {
    const short = line + 8 - live.getBoundingClientRect().top;
    const { top, height } = lineAt();
    const room = bottom - (top + height);
    if (short > 0 && room > 0) scrollPage(-Math.min(short, room));
  }
  const row =
    target === null
      ? null
      : (list.querySelector<HTMLElement>(`[data-key="${target}"]`) ??
        list.querySelector<HTMLElement>(`[data-group-rows~="${target}"]`));
  if (row !== null) {
    const top = row.getBoundingClientRect().top;
    if (top < line) scrollPage(top - line - 8);
  }
  alignTop(list);
}

/**
 * 一覧の見えている所の上端。日付の見出しが貼り付く線 (広い形は浮いたヘッダーの下端、スマホの形は上の安全域の下)。
 * 貼り付いたときの位置で数える (巻き始めは少し下にいるが、送り先はいつも貼り付いた位置で決める)
 */
function topEdge(list: HTMLElement): number {
  const day = list.querySelector<HTMLElement>(".t-day");
  return day === null ? 0 : Number.parseFloat(getComputedStyle(day).top) || 0;
}

function scrollPage(delta: number): void {
  window.scrollTo({ top: window.scrollY + delta });
}

/**
 * **止めた所で、見出しも行も途中で切らない。** 日ごと (まとめて表示は側ごと) に包んだ見出しは、包みの終わりで
 * 押し上げられる。送った先がちょうどそこだと、前の日の見出しが半分だけ頭に残っていた。
 * 半分押し上げられた見出しがあれば、それが隠れきるところまで送る。そのうえで、貼り付いた見出しの
 * 下端に掛かっている行があれば、その行が見出しの裏に隠れきるところまで送る (半分だけ見える行を残さない)。
 * **送るのは先へだけ** (行き来させない)。開いたときに映す行 (観終えていない録画) は見出しの少し下に置くので、隠れない
 */
export function alignTop(list: HTMLElement): void {
  const top = topEdge(list);
  for (const heading of list.querySelectorAll<HTMLElement>(".t-day")) {
    const box = heading.getBoundingClientRect();
    if (box.top < top - 0.5 && box.bottom > top + 0.5) {
      scrollPage(box.bottom - top);
      break;
    }
  }
  let line = top;
  for (const heading of list.querySelectorAll<HTMLElement>(".t-day")) {
    const box = heading.getBoundingClientRect();
    // 貼り付いている見出し (枠の余白ぶん下に付くこともあるので少し幅を持たせる)
    if (box.top >= top - 1 && box.top - top < 8)
      line = Math.max(line, box.bottom);
  }
  for (const row of list.querySelectorAll<HTMLElement>(
    '.t-row, .group-head, [data-testid="timeline-now"]',
  )) {
    const box = row.getBoundingClientRect();
    if (box.top < line - 0.5 && box.bottom > line + 0.5) {
      scrollPage(box.bottom - line);
      return;
    }
  }
}

/** 絞り込みを替える前に覚えておく、見えている所のいちばん上の行 */
interface Anchor {
  key: string;
  /** 見えている所の上端から行の上端まで */
  offset: number;
}

/** 見えている所の上のほうで、頭から見えている最初の行の鍵と位置 (貼り付いた日付の見出しの下) */
export function topRow(list: HTMLElement): Anchor | null {
  const top = topEdge(list);
  for (const row of list.querySelectorAll<HTMLElement>("[data-key]")) {
    const box = row.getBoundingClientRect();
    // 頭が切れている行 (見出しの裏に潜りかけ) は飛ばし、頭から見えている最初の行を選ぶ
    if (box.height === 0 || box.top < top + 32) continue;
    return { key: row.dataset["key"] ?? "", offset: box.top - top };
  }
  return null;
}

/**
 * **絞り込みを替えても、見ていた行をその場に残す。** 覚えた行がまだ一覧にあれば、同じ高さに戻す。
 * 無くなっていれば「いま」の線 (開いたときと同じ置き方)
 */
export function restoreRow(list: HTMLElement, anchor: Anchor | null): void {
  const row =
    anchor === null
      ? null
      : list.querySelector<HTMLElement>(`[data-key="${anchor.key}"]`);
  if (anchor === null || row === null) {
    placeTimeline(list, null);
    return;
  }
  scrollPage(row.getBoundingClientRect().top - topEdge(list) - anchor.offset);
}

/**
 * **上へ行を足しても、読んでいる所を動かさない。** 足す前に呼び、足して描き終えたら返り値を呼ぶ。
 * 768px からはブラウザの位置合わせを切ってある (`home.css` の `overflow-anchor: none`) ので、何もしないと足したぶん中身が下へずれる。
 * それより狭い画面ではブラウザが先に合わせることもあるが、残ったずれを測って送るので二重には動かない。
 * 物差しは `key` の行 (無ければ「いま」の線)。足すのはいつもそれより上なので、ずれたぶんだけ送り直せばよい
 */
export function holdPlace(
  list: HTMLElement,
  key: string | null = null,
): () => void {
  const mark =
    (key === null
      ? null
      : (list.querySelector<HTMLElement>(`[data-key="${key}"]`) ??
        list.querySelector<HTMLElement>(`[data-group-rows~="${key}"]`))) ??
    list.querySelector<HTMLElement>('[data-testid="timeline-now"]');
  const before = mark?.getBoundingClientRect().top ?? 0;
  return () => {
    if (mark === null || !mark.isConnected) return;
    scrollPage(mark.getBoundingClientRect().top - before);
  };
}

/**
 * **いま頭に貼り付いている日** (カレンダーで下線を引く日)。見えている所の上端に掛かっている包みの、日付の見出しの日。
 * まとめて表示 (日付の見出しが無い) や、日付の無い包みなら null
 */
export function topDay(list: HTMLElement): number | null {
  const top = topEdge(list);
  for (const block of list.querySelectorAll<HTMLElement>(".t-block")) {
    if (block.getBoundingClientRect().bottom <= top + 1) continue;
    const day = block.querySelector<HTMLElement>(
      ':scope > [data-testid="timeline-day"]',
    )?.dataset["day"];
    return day === undefined ? null : Number(day);
  }
  return null;
}

/**
 * その日の見出しを頭に送る (カレンダーで日を押したとき)。包みの頭を見えている所の上端に合わせる —
 * 見出しは貼り付くので、見出しの位置では送り先が決まらない。見出しが無ければ (まだ描いていない) 送らない。
 *
 * **見出しの上の離れ (`margin-top`。いちばん上の包みだけ 0) のぶんも送る。** 包みの頭だけを合わせていた頃は、
 * 上に別の日がある日を押すと、見出しが貼り付く所より離れのぶん (8px) 下に止まっていた
 */
export function showDay(list: HTMLElement, day: number): void {
  const head = list.querySelector<HTMLElement>(
    `[data-testid="timeline-day"][data-day="${day}"]`,
  );
  const block = head?.closest<HTMLElement>(".t-block");
  if (head === null || block === null || block === undefined) return;
  const gap = Number.parseFloat(getComputedStyle(head).marginTop) || 0;
  scrollPage(block.getBoundingClientRect().top + gap - topEdge(list));
}
