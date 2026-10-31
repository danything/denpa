<script lang="ts">
  import { onMount, type Snippet, tick } from "svelte";

  import type { Comment } from "#lib/jikkyo/comments.js";
  import type { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import {
    airClock,
    atBottom,
    follows,
    jumped,
    LIST_EVERY,
    LIST_MAX,
    LIST_MAX_LITE,
    rowKey,
    sameRows,
  } from "#lib/jikkyo/list.js";
  import { ListHold } from "#lib/jikkyo/ranking.js";

  /**
   * **右の列の「コメントの一覧」** (ライブ・追っかけ・観る画面で同じ)。決まりは `list.ts` と docs/watch.md の「コメントの一覧」。
   *
   * - 置き場はデータ放送のリモコンと同じく右の列の頭で、局の一覧・番組の中身はその下に残す。高さは決めてあり、中だけ巻く
   * - 流れるほうと同じ `air()` で控えを 0.25 秒ごとに読み直す。シーク・巻き戻しにもそのまま付いていく
   * - 新しいものが下。行が少ないうちも下に寄せる (いちばん新しい行が、いつも一覧の下の端に来る)
   * - いちばん下にいる間は付いていき、上へ巻いた・指やポインタやフォーカスが乗っている間は止める。
   *   止めている間は並びも替えない (上限を超えて上の行が落ちると、読んでいる行がずれる)。飛んだ (シーク) ときだけは替える
   *   (下へはいつも飛ぶ。滑らせると、滑っている間に増えた行で下の端が逃げ、付いていくのが外れる)
   * - 「最新へ」は上へ巻いている間だけ出す。下で乗っているだけなら出さない (離れれば付いていくのに戻る。出すといちばん新しい行に重なる)
   * - 読み上げには知らせない (`aria-live` を付けない。1 分に何百件も来る)。自分の書き込みは流れるほうと同じく字の下に短い線
   * - `seek` があれば (観る画面)、行を押すとその時刻へ飛ぶ
   * - `children` は一覧の下に置くもの (ライブで書き込む 1 行)
   */
  interface Props {
    feed: JikkyoFeed;
    /** いま映しているコマの放送時刻 (ms)。まだ分からなければ null */
    air: () => number | null;
    /** 行を押したときにその放送時刻へ飛ぶ (録画だけ) */
    seek?: (at: number) => void;
    children?: Snippet;
  }
  let { feed, air, seek, children }: Props = $props();

  let rows = $state<Comment[]>([]);
  let force = $state(0);
  let box = $state<HTMLOListElement | null>(null);
  /** いちばん下にいる (付いていく)。上へ巻いたら外れ、下まで戻すか「最新へ」で戻る。外れている間は「最新へ」を出す */
  let stuck = $state(true);
  let last: number | null = null;
  let most = LIST_MAX;

  /** 一覧から離れて 1 秒たったら、いちばん下へ戻す (使っている間に増えたぶん) */
  const hold = new ListHold(() => {
    if (stuck) void refresh(true);
  });

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

  /** 読み直す。`latest` (離れた・「最新へ」) なら、止めていても並べ直していちばん下へ */
  async function refresh(latest = false): Promise<void> {
    const w = air();
    if (w === null) return;
    const leap = jumped(last, w);
    if (leap) stuck = true;
    last = w;
    force = feed.force(w);
    const next = feed.recent(w, most);
    const follow = latest || leap || follows(stuck, hold.held, rows.length);
    if (sameRows(rows, next)) {
      if (follow) toBottom();
      return;
    }
    if (!follow) return;
    rows = next;
    await tick();
    toBottom();
  }

  function toBottom(): void {
    if (box === null) return;
    box.scrollTop = box.scrollHeight;
    stuck = true;
  }

  function onscroll(): void {
    if (box !== null) stuck = atBottom(box);
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
      (巻き始めると pointer は取り消されるが、touch は指を離すまで続く)。フォーカスはキーボードで入ったときだけ
    -->
    <ol
      bind:this={box}
      class="rows"
      aria-label="実況のコメント"
      data-testid="jikkyo-list-rows"
      {onscroll}
      onpointerenter={() => hold.set("pointer", true)}
      onpointerleave={() => hold.set("pointer", false)}
      ontouchstart={() => hold.set("touch", true)}
      ontouchend={() => hold.set("touch", false)}
      ontouchcancel={() => hold.set("touch", false)}
      onfocusin={(event) =>
        hold.set(
          "focus",
          (event.target as HTMLElement).matches(":focus-visible"),
        )}
      onfocusout={() => hold.set("focus", false)}
    >
      {#each rows as comment (rowKey(comment))}
        <li class="row" class:mine={comment.mine} data-testid="jikkyo-list-row">
          {#if seek}
            <button
              type="button"
              class="line seekable"
              onclick={() => seek(comment.at)}
            >
              <time class="at num">{airClock(comment.at)}</time>
              <span class="text"
                >{comment.text}{#if comment.mine}<span class="visually-hidden"
                    >(自分の書き込み)</span
                  >{/if}</span
              >
            </button>
          {:else}
            <span class="line">
              <time class="at num">{airClock(comment.at)}</time>
              <span class="text"
                >{comment.text}{#if comment.mine}<span class="visually-hidden"
                    >(自分の書き込み)</span
                  >{/if}</span
              >
            </span>
          {/if}
        </li>
      {/each}
    </ol>
    {#if !stuck}
      <button
        type="button"
        class="small latest"
        data-testid="jikkyo-list-latest"
        onclick={() => void refresh(true)}>最新へ</button
      >
    {/if}
  </div>
  {@render children?.()}
</section>

<style>
  /* カードにしない。データ放送のリモコンと同じく地も枠も付けず、下のものとは余白で分ける */
  .jikkyo-list {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    margin-bottom: 1.75rem;
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
   * 下の局の一覧との間に見え、間がリモコンのときより広く見える)。`justify-content: flex-end` だと溢れた上の行へ巻けないので、
   * 頭の行の上の余白で押し下げる
   */
  .rows {
    display: flex;
    flex-direction: column;
    height: 16rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }
  .row {
    margin: 0;
    list-style: none;
  }
  .row:first-child {
    margin-top: auto;
  }
  .line {
    display: flex;
    gap: var(--dp-space-2);
    width: 100%;
    margin: 0;
    padding: 0.125rem 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: var(--dp-text-sm);
    line-height: 1.5;
    text-align: start;
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
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--broadcast-font);
  }
  /* この端末から書き込んだもの。流れるほうと同じく字の下に短い線 (字の色は替えない) */
  .mine .text {
    text-decoration: underline 2px var(--dp-primary-text);
    text-underline-offset: 3px;
  }
  /* 上へ巻いている間だけ出すので、重なるのは読み返している古い行 (いちばん新しい行は下の外にある) */
  .latest {
    position: absolute;
    left: 50%;
    bottom: var(--dp-space-2);
    translate: -50% 0;
    margin: 0;
  }
</style>
