<script lang="ts">
  import { onMount, type Snippet, tick } from "svelte";

  import { clock } from "#lib/format.js";
  import { type Comment, commentKey } from "#lib/jikkyo/comments.js";
  import { jumped } from "#lib/jikkyo/cursor.js";
  import type { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import {
    airClock,
    atNow,
    follows,
    LIST_AHEAD,
    LIST_EVERY,
    LIST_MAX,
    LIST_MAX_LITE,
    LIST_SEEK_SETTLE,
    LIST_SPAN,
    moreAhead,
    nearEnd,
    nowTop,
    sameRows,
  } from "#lib/jikkyo/list.js";
  import { ListHold } from "#lib/jikkyo/ranking.js";

  /**
   * **右の列の「コメントの一覧」** (ライブ・追っかけ・観る画面で同じ)。決まりは `list.ts` と docs/watch.md の「コメントの一覧」。
   *
   * - 置き場はデータ放送のリモコンと同じく右の列の頭で、局の一覧・番組の中身はその下に残す。高さは決めてあり、中だけ巻く
   * - 流れるほうと同じ `air()` で控えを 0.25 秒ごとに読み直す。シーク・巻き戻しにもそのまま付いていく
   * - 新しいものが下。行が少ないうちも下に寄せる (いまの再生位置までのいちばん新しい行が、いつも一覧の下の端に来る)
   * - 録画 (`edge` を渡す) は、再生位置より後に書かれたもの (この先) もその下の外に並べる。「ここから先」の一言で分け、字は控えた色。
   *   下へ巻かなければ見えない (先を見せない)。`LIST_AHEAD` 件ずつ並べ、下の端に近づいたら足す (上の行は替えない)
   * - 「いま」にいる間は付いていき、上へも下へも巻いて離れた・指やポインタやフォーカスが乗っている間は止める。
   *   止めている間は並びも替えない (上限を超えて上の行が落ちると、読んでいる行がずれる)。飛んだ (シーク) ときだけは替える
   *   (「いま」へはいつも飛ぶ。滑らせると、滑っている間に増えた行で下の端が逃げ、付いていくのが外れる)
   * - 「最新へ」(録画は上にも下にも離れるので「いまへ」) は巻いて離れている間だけ出す。「いま」で乗っているだけなら出さない
   *   (離れれば付いていくのに戻る。出すといちばん新しい行に重なる)
   * - 読み上げには知らせない (`aria-live` を付けない。1 分に何百件も来る)。自分の書き込みは字の下に主の色の線
   * - 録画 (観る画面・追っかけ) は時刻の代わりに録画の中の再生位置を出す (`place`)。観られないものは「開始前」「CM」。
   *   `seek` があれば、時刻のボタン (と行) を押すとその位置へ飛ぶ。ライブは書かれた時刻のまま
   * - `children` は一覧の下に置くもの (ライブで書き込む 1 行)
   */
  interface Props {
    feed: JikkyoFeed;
    /** いま映しているコマの放送時刻 (ms)。まだ分からなければ null */
    air: () => number | null;
    /** 放送時刻 (ms) → 録画の中の再生位置 (秒)。無ければ (ライブ) 書かれた時刻を出す */
    place?: (at: number) => number | "before" | "cut";
    /** 時刻のボタン・行を押したときに、その再生位置 (秒) へ飛ぶ */
    seek?: (seconds: number) => void;
    /** この先を並べる端の放送時刻 (ms。観る画面は録画の終わり、追っかけは録れているところ)。無ければ (ライブ) この先を並べない */
    edge?: () => number | null;
    children?: Snippet;
  }
  let { feed, air, place, seek, edge, children }: Props = $props();

  /** いまの再生位置までのもの */
  let rows = $state<Comment[]>([]);
  /** この先 (録画だけ) */
  let ahead = $state<Comment[]>([]);
  let force = $state(0);
  let box = $state<HTMLDivElement | null>(null);
  let past = $state<HTMLOListElement | null>(null);
  /** 「いま」にいる (付いていく)。巻いて離れたら外れ、「いま」まで戻すか「最新へ」で戻る。外れている間は「最新へ」を出す */
  let stuck = $state(true);
  let last: number | null = null;
  let most = LIST_MAX;
  /** この先を並べたときの再生位置の放送時刻 (足すときは、並べてある行と同じところで分ける) */
  let cut: number | null = null;
  /** この先に求める件数。下の端に近づいたら増やし、「いま」で並べ直したら戻す */
  let want = LIST_AHEAD;
  /** 一覧から押して飛んだあと、乗っていても並べ直す残りの回数 (`LIST_SEEK_SETTLE`) */
  let settling = 0;
  /** 「いま」へ戻したときに置いた巻き位置 */
  let placed: number | null = null;

  /** 一覧から離れて 1 秒たったら、「いま」へ戻す (使っている間に増えたぶん) */
  const hold = new ListHold(() => {
    notice();
    if (stuck) void refresh(true);
  });

  /**
   * 置いた所から巻かれていたら、巻いた知らせ (`onscroll`) を待たずに「いま」にいるかを見直す
   * (知らせは次のコマで来る。待つ間に「いま」へ戻すと、巻いたぶんが消える)
   */
  function notice(): void {
    if (box !== null && placed !== null && box.scrollTop !== placed)
      stuck = atNow(box.scrollTop, now(box));
  }

  onMount(() => {
    most =
      document.documentElement.dataset["lite"] === undefined
        ? LIST_MAX
        : LIST_MAX_LITE;
    void refresh();
    const timer = setInterval(() => void refresh(), LIST_EVERY);
    return () => {
      clearInterval(timer);
      hold.clear();
    };
  });

  /** 読み直す。`latest` (離れた・「最新へ」) なら、止めていても並べ直して「いま」へ */
  async function refresh(latest = false): Promise<void> {
    const w = air();
    if (w === null) return;
    const leap = jumped(last, w);
    if (leap) stuck = true;
    else if (!latest) notice();
    last = w;
    force = feed.force(w);
    const follow =
      latest ||
      leap ||
      follows(stuck, hold.held, rows.length + ahead.length, settling > 0);
    if (settling > 0) settling--;
    if (!follow) return;
    const end = edge?.() ?? null;
    want = LIST_AHEAD;
    cut = w;
    const next = feed.recent(w, most);
    const nextAhead =
      end === null ? [] : feed.ahead(w, Math.min(w + LIST_SPAN, end), want);
    if (sameRows(rows, next) && sameRows(ahead, nextAhead)) {
      toNow();
      return;
    }
    rows = next;
    ahead = nextAhead;
    await tick();
    toNow();
  }

  /** 「いま」の巻き位置。巻き取る箱に下の余白があれば、それも見えている所から除く */
  function now(el: HTMLDivElement): number {
    if (ahead.length === 0 || past === null) return nowTop(el, null);
    const bottom =
      el.scrollTop +
      past.getBoundingClientRect().bottom -
      el.getBoundingClientRect().top -
      el.clientTop +
      (parseFloat(getComputedStyle(el).paddingBottom) || 0);
    return nowTop(el, bottom);
  }

  function toNow(): void {
    if (box === null) return;
    box.scrollTop = now(box);
    placed = box.scrollTop;
    stuck = true;
  }

  /** この先を足す (下の端に近づいた)。並べてある行は替えず、後ろに足すだけ */
  function more(): void {
    const end = edge?.() ?? null;
    if (end === null || cut === null) return;
    const next = moreAhead(want, ahead.length, most);
    if (next === want) return;
    want = next;
    ahead = feed.ahead(cut, Math.min(cut + LIST_SPAN, end), want);
  }

  function onscroll(): void {
    if (box === null) return;
    stuck = atNow(box.scrollTop, now(box));
    if (ahead.length > 0 && nearEnd(box)) more();
  }

  /** 行・時刻を押した。飛んだ先の「いま」で並べ直す (前へ少し飛んだだけでは「飛んだ」にならず、ポインタも乗ったまま) */
  function go(to: number): void {
    seek?.(to);
    stuck = true;
    settling = Math.ceil(LIST_SEEK_SETTLE / LIST_EVERY);
  }
</script>

<section class="jikkyo-list" data-testid="jikkyo-list">
  <div class="head">
    <h2 class="title">コメントの一覧</h2>
    <span class="force num" data-testid="jikkyo-list-force"
      ><span title="1分あたりのコメント数">勢い</span> {force}</span
    >
  </div>
  <div class="body">
    <!--
      使っている間は付いていくのを止める (`ListHold`。局の一覧の「実況」タブと同じ見方)。指は touch のほうで見る
      (巻き始めると pointer は取り消されるが、touch は指を離すまで続く)。フォーカスはキーボードで入ったときだけ。
      ホイールと指は、行を押して飛んだ直後の並べ直し (`settling`) もやめる (巻く知らせは、押した行を見える所へ寄せたときにも来るので見ない)。
      巻く入れ物は、いままでの行とこの先の行の 2 つの一覧を包む。乗っているかを見るだけで、押して何かするものではない
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={box}
      class="rows"
      data-testid="jikkyo-list-rows"
      {onscroll}
      onpointerenter={() => hold.set("pointer", true)}
      onpointerleave={() => hold.set("pointer", false)}
      onwheel={() => (settling = 0)}
      ontouchstart={() => {
        settling = 0;
        hold.set("touch", true);
      }}
      ontouchend={() => hold.set("touch", false)}
      ontouchcancel={() => hold.set("touch", false)}
      onfocusin={(event) =>
        hold.set(
          "focus",
          (event.target as HTMLElement).matches(":focus-visible"),
        )}
      onfocusout={() => hold.set("focus", false)}
    >
      <ol bind:this={past} class="past" aria-label="実況のコメント">
        {#each rows as comment (commentKey(comment))}
          {@render row(comment, false)}
        {/each}
      </ol>
      {#if ahead.length > 0}
        <!-- この先 (録画だけ)。「いま」の下の外にあり、下へ巻いたときだけ見える。線は引かず、控えた字の一言で分ける -->
        <p class="ahead" data-testid="jikkyo-list-ahead">ここから先</p>
        <ol class="future" aria-label="この先のコメント">
          {#each ahead as comment (commentKey(comment))}
            {@render row(comment, true)}
          {/each}
        </ol>
      {/if}
    </div>
    {#if !stuck}
      <button
        type="button"
        class="small latest"
        data-testid="jikkyo-list-latest"
        onclick={() => void refresh(true)}
        >{place === undefined ? "最新へ" : "いまへ"}</button
      >
    {/if}
  </div>
  {@render children?.()}
</section>

{#snippet row(comment: Comment, future: boolean)}
  {@const where = place?.(comment.at)}
  {@const to = typeof where === "number" && seek ? where : null}
  <!--
    飛べる行は、行のどこを押しても飛ぶ (マウス・指で狙いやすく)。キーボードと読み上げは頭の時刻のボタンで
  -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <li
    class="row"
    class:seekable={to !== null}
    onclick={to === null ? undefined : () => go(to)}
    data-testid={future ? "jikkyo-list-ahead-row" : "jikkyo-list-row"}
  >
    <span class="line">
      {#if where === undefined}
        <time class="at num">{airClock(comment.at)}</time>
      {:else if to !== null}
        <button
          type="button"
          class="at num jump"
          aria-label="{clock(to)} へ移る"
          onclick={(event) => {
            event.stopPropagation();
            go(to);
          }}
          data-testid="jikkyo-list-at">{clock(to)}</button
        >
      {:else}
        <span class="at num" data-testid="jikkyo-list-at"
          >{where === "before"
            ? "開始前"
            : where === "cut"
              ? "CM"
              : clock(where)}</span
        >
      {/if}
      <span class="text" class:mine-dot={comment.mine}
        >{comment.text}{#if comment.mine}<span class="visually-hidden"
            >(自分の書き込み)</span
          >{/if}</span
      >
    </span>
  </li>
{/snippet}

<style>
  /* カードにしない。データ放送のリモコンと同じく地も枠も付けず、下のものとは余白で分ける */
  .jikkyo-list {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    margin-bottom: var(--dp-space-4);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--dp-space-2);
    margin-bottom: var(--dp-space-1);
  }
  .title {
    margin: 0;
    font-size: var(--dp-text-sm);
    font-weight: var(--dp-weight-bold);
  }
  .force {
    font-size: var(--dp-text-xs);
    color: var(--dp-muted);
  }
  .body {
    position: relative;
  }
  /*
   * 高さはデータ放送のリモコンと同じくらい。中だけ巻く。行が少ないうちも下に寄せる (上に寄せると、下に空いた所が
   * 下の局の一覧との間に見え、間がリモコンのときより広く見える)。いまの再生位置までの行を一覧の高さ以上にして下へ寄せる
   * (この先が下に続いていても、「いま」の上に空きが残り、この先が見えてこない)。
   * 巻き取る箱は局の一覧 (ライブの `.channels`) と同じく列の幅いっぱいに広げ、スクロールバーを窓の右端に出す。
   * 行の端は列の余白 (`--dp-side-pad`) の内側のまま (見出し・番組名の端と同じ所)
   */
  .rows {
    height: 16rem;
    margin: 0 calc(-1 * var(--dp-side-pad, 0px));
    padding: 0 var(--dp-side-pad, 0px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .past,
  .future {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .past {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 100%;
  }
  .row {
    margin: 0;
    list-style: none;
  }
  /* この先の区切り。線も地も付けず、時刻と同じ控えた小さな字の一言だけ */
  .ahead {
    margin: 0;
    padding: var(--dp-space-1) 0 0.125rem;
    font-size: var(--dp-text-xs);
    color: var(--dp-muted);
  }
  /* この先の行は控えた字 (まだ映していない)。時刻のボタンは飛べるので、いまより前の行と同じ主の色のまま */
  .future .text {
    color: var(--dp-muted);
  }
  .line {
    display: flex;
    gap: var(--dp-space-2);
    padding: 0.125rem 0;
    font-size: var(--dp-text-sm);
    line-height: 1.5;
  }
  .seekable {
    cursor: pointer;
  }
  .seekable:hover {
    background: var(--dp-hover-soft);
  }
  .at {
    flex-shrink: 0;
    font-size: var(--dp-text-xs);
    line-height: calc(var(--dp-text-sm) * 1.5);
    color: var(--dp-muted);
  }
  /* 飛べる時刻はリンクと同じ主の色の字で、押せると分かるように。行の高さは変えない */
  .jump {
    width: auto;
    height: auto;
    margin: 0 -0.25rem;
    padding: 0 0.25rem;
    border: 0;
    border-radius: var(--dp-radius);
    background: none;
    box-shadow: none;
    color: var(--dp-primary-text);
  }
  .jump:hover {
    background: var(--dp-hover-soft);
    text-decoration: underline;
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* 巻いて離れている間だけ出すので、重なるのは読み返している古い行か、この先の行 (「いま」の行は見えている所の外にある) */
  .latest {
    position: absolute;
    left: 50%;
    bottom: var(--dp-space-2);
    translate: -50% 0;
    margin: 0;
  }
</style>
