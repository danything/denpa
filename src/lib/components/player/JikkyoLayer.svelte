<script lang="ts">
  import { onMount } from "svelte";

  import type { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import {
    fontSize,
    laneCount,
    Lanes,
    lineHeight,
    textWidth,
  } from "#lib/jikkyo/lanes.js";

  import { fitRect } from "./paint";

  /**
   * **実況のコメントを映像の上に流す** (ライブ・追っかけ・観る画面で同じ)。決まりは docs/watch.md の「実況」。
   *
   * - 映像の枠 (16:9 に収めた所。字幕の面と同じ) の全面に流す。重ねる順は 映像 → 実況 → 字幕 → 操作バー
   * - 動きは CSS の `translateX` だけ (JS では動かさない)。止めたら `animation-play-state: paused`、
   *   速さを変えたら長さを割る。流し終えたら外す
   * - 色・位置・大きさのコマンドは使わず、全部白で右から左へ。透明度 0.5。読み上げには出さない
   * - 動きを減らす設定では流さず、上の行に 3 秒置いて消す
   * - 同時に流すのは 60 件まで (`data-lite` の端末では 15 件)。空いた行が無ければ捨てる
   */
  interface Props {
    feed: JikkyoFeed;
    /** いま映しているコマの放送時刻 (ms)。まだ分からなければ null */
    air: () => number | null;
    /** 流すか (オフ・重ねない間は false。流れているものも消す) */
    show: boolean;
    paused: boolean;
    /** 再生の速さ */
    rate: number;
  }
  let { feed, air, show, paused, rate }: Props = $props();

  interface Item {
    id: number;
    text: string;
    lane: number;
    /** 流れ終わるまで (放送時刻の ms) */
    duration: number;
    width: number;
    still: boolean;
  }

  let items = $state<Item[]>([]);
  let box = $state<HTMLElement | null>(null);
  let frame = $state({ left: 0, top: 0, width: 0, height: 0 });
  let lanes = new Lanes(1);
  let nextId = 0;
  let reduced = false;
  let most = 60;

  const size = $derived(fontSize(frame.height));
  const line = $derived(lineHeight(frame.height));

  onMount(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = motion.matches;
    const onMotion = () => (reduced = motion.matches);
    motion.addEventListener("change", onMotion);
    most = document.documentElement.dataset["lite"] === undefined ? 60 : 15;
    const observer = new ResizeObserver(() => {
      if (box === null) return;
      frame = fitRect(box.clientWidth, box.clientHeight, 16, 9);
      lanes.resize(laneCount(frame.height));
    });
    if (box !== null) observer.observe(box);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
    };
  });

  // 流すのは見せている間だけ。0.1 秒おきに新しいものを取る (コメントは秒より細かく合わせる必要が無い)
  $effect(() => {
    if (!show) {
      items = [];
      lanes.clear();
      feed.pause();
      return;
    }
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  });

  function tick(): void {
    const w = air();
    if (w === null || frame.width <= 0) return;
    const { comments, jumped } = feed.take(w);
    if (jumped) {
      items = [];
      lanes.clear();
    }
    if (comments.length === 0) return;
    const added: Item[] = [];
    for (const comment of comments) {
      if (items.length + added.length >= most) break;
      const width = textWidth(comment.text, size);
      const flow = reduced
        ? lanes.still(w)
        : lanes.flow(w, width, frame.width, size);
      if (flow === null) continue;
      added.push({
        id: nextId++,
        text: comment.text,
        lane: flow.lane,
        duration: flow.duration,
        width,
        still: reduced,
      });
    }
    if (added.length > 0) items = [...items, ...added];
  }

  function done(id: number): void {
    items = items.filter((item) => item.id !== id);
  }
</script>

<div
  bind:this={box}
  class="jikkyo"
  data-paused={paused ? "" : undefined}
  data-testid="jikkyo-layer"
  aria-hidden="true"
>
  <div
    class="frame"
    style:left="{frame.left}px"
    style:top="{frame.top}px"
    style:width="{frame.width}px"
    style:height="{frame.height}px"
    style:font-size="{size}px"
    style:line-height="{line}px"
  >
    {#each items as item (item.id)}
      <span
        class="comment"
        class:still={item.still}
        data-testid="jikkyo-comment"
        style:top="{(item.lane + 0.5) * line}px"
        style:--from="{frame.width}px"
        style:--to="{-item.width}px"
        style:animation-duration="{item.duration / Math.max(rate, 0.1)}ms"
        onanimationend={() => done(item.id)}>{item.text}</span
      >
    {/each}
  </div>
</div>

<style>
  .jikkyo {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .frame {
    position: absolute;
    overflow: hidden;
  }
  .comment {
    position: absolute;
    left: 0;
    white-space: pre;
    font-family: var(--broadcast-font);
    color: var(--dp-on-video);
    opacity: 0.5;
    /* 黒い縁。明るい場面でも読めるように */
    text-shadow:
      -1px -1px 0 #000,
      1px -1px 0 #000,
      -1px 1px 0 #000,
      1px 1px 0 #000;
    will-change: transform;
    animation-name: jikkyo-flow;
    animation-timing-function: linear;
    animation-fill-mode: both;
  }
  .comment.still {
    left: 50%;
    translate: -50% 0;
    will-change: auto;
    animation-name: jikkyo-still;
  }
  .jikkyo[data-paused] .comment {
    animation-play-state: paused;
  }
  @keyframes jikkyo-flow {
    from {
      transform: translateX(var(--from));
    }
    to {
      transform: translateX(var(--to));
    }
  }
  /* 動かさない。長さを測るためだけのもの (終わったら外す) */
  @keyframes jikkyo-still {
    from,
    to {
      opacity: 0.5;
    }
  }
</style>
