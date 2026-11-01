<script lang="ts">
  import { getContext, onMount } from "svelte";
  import type { Attachment } from "svelte/attachments";

  import type { Comment } from "#lib/jikkyo/comments.js";
  import type { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import {
    fontSize,
    laneCount,
    Lanes,
    lead,
    lineHeight,
    NO_OUTSIDE,
    type Outside,
    sizeScale,
    textWidth,
  } from "#lib/jikkyo/lanes.js";

  import { PLAYER_STAGE, STAGE_OUTSIDE } from "./controls.svelte";
  import { fitRect } from "./paint";

  /**
   * **実況のコメントを映像の上に流す** (ライブ・追っかけ・観る画面で同じ)。決まりは docs/watch.md の「実況のコメント」。
   *
   * - 行・字の大きさは映像の枠 (16:9 に収めた所。字幕の面と同じ) で決める。重ねる順は 映像 → 操作列の影 → 実況 → 字幕 → 操作列のボタン
   *   (影に潜ると暗く欠けて見える。段の数は `ControlBar`)
   * - **アンビエントの光が枠の外に見えている間は、流れるものは光の範囲 (舞台の `STAGE_OUTSIDE`) の右の端から入り、左の端まで流れる。**
   *   行は枠と同じ高さのまま、枠を渡る速さも同じ (`lanes.ts` の `Outside`)。枠の外のぶんは同じものをもう1つ、
   *   舞台の外の所に描く (窓の端から端まで。枠の下・光と右の列の上で、押すものは受けない。枠の中の1つは字幕と操作バーの下のまま)。2つは同じ時に足すので、同じ動きで流れる。
   *   外へ出すのは枠が舞台の幅いっぱいのときだけ (データ放送の小窓などでは、枠と舞台の端の間で欠けて見える)
   * - 録画 (`ahead`) は外を渡るぶん早く流し始め、枠の右の端に着く時刻を外が無いときと同じにする。ライブは届いたときに
   *   外の右の端から流すので、枠に入るのがそのぶん遅れる
   * - 動きは CSS の `translateX` だけ (JS では動かさない)。止めたら `animation-play-state: paused`、
   *   速さを変えたら長さを割る。流し終えたら外す
   * - 色・位置・大きさはコメントのコマンドどおり (`command.ts`。既定は白で右から左へ)。`ue`・`shita` は枠の中の上・下の行に 3 秒止める
   *   (先まで取ったものは時刻が来るまで待たせる)。止めるもので枠より広いものは、枠に収まるまで字を縮める。
   *   透明度 0.5。読み上げには出さない
   * - 動きを減らす設定では流さず、上の行に 3 秒置いて消す (`shita` は下の行)
   *   (長さは `!important` で書く。Pico は動きを減らす設定で `animation-duration` を 1ms にするので、置いたものがすぐ消えていた)
   * - この端末から書き込んだものは、字の前に字と同じ色の点 (`mine-dot`)
   * - 同時に流すのは 60 件まで (`data-lite` の端末では 15 件)。空いた行が無ければ捨てる
   * - 切り抜きは、いま枠に見えているものを見えている位置のまま写す (`snapshot.ts` の `commentLayer`。枠は `data-frame` で探す。
   *   外の写しは入らない)
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
    /** コメントが前もって分かっているか (録画・追っかけ)。枠の外を渡るぶん早く流し始める */
    ahead?: boolean;
  }
  let { feed, air, show, paused, rate, ahead = false }: Props = $props();

  interface Item {
    id: number;
    text: string;
    lane: number;
    /** 流れ終わるまで (放送時刻の ms) */
    duration: number;
    width: number;
    /** 止めて置く (上・下・動きを減らす設定) */
    still: boolean;
    /** 字の大きさ (px) */
    size: number;
    color: string | undefined;
    mine: boolean;
    /** 流し始めたときの、枠の外を流れる幅 */
    path: Outside;
    /** 外の写しを描く所 (流し始めたときのもの)。外が無かった・作り直されたなら描かない (途中から動きがずれる) */
    trail: HTMLElement | null;
  }

  /** 枠の外の幅と、外の所の中での枠の位置 (px) */
  interface Around extends Outside {
    x: number;
    y: number;
  }
  const NO_AROUND: Around = { ...NO_OUTSIDE, x: 0, y: 0 };

  let items = $state<Item[]>([]);
  let box = $state<HTMLElement | null>(null);
  let frame = $state({ left: 0, top: 0, width: 0, height: 0 });
  let around = $state<Around>(NO_AROUND);
  let lanes = new Lanes(1);
  let nextId = 0;
  let reduced = false;
  let most = 60;
  /** 止めるもので、先まで取ったために時刻がまだ来ていないもの */
  let waiting: Comment[] = [];

  const size = $derived(fontSize(frame.height));
  const line = $derived(lineHeight(frame.height));

  const stageOf = getContext<(() => HTMLElement | null) | undefined>(
    PLAYER_STAGE,
  );
  const outsideOf = getContext<(() => HTMLElement | null) | undefined>(
    STAGE_OUTSIDE,
  );
  /** 枠の外の所。光を枠の外に出していなければ null */
  const outer = $derived(outsideOf?.() ?? null);

  /** 枠の大きさと、外の所の中での枠の位置を測る */
  function measure(): void {
    if (box === null) return;
    frame = fitRect(box.clientWidth, box.clientHeight, 16, 9);
    lanes.resize(laneCount(frame.height));
    around = surround(box);
  }

  function surround(target: HTMLElement): Around {
    const out = outer;
    const stage = stageOf?.() ?? null;
    if (out === null || stage === null) return NO_AROUND;
    const o = out.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const left = b.left + frame.left;
    const right = left + frame.width;
    // 枠が舞台の幅いっぱいのときだけ外へ出す。外の所が出ていない (幅 0) ときも出さない
    if (
      o.width <= 0 ||
      Math.abs(left - s.left) > 1 ||
      Math.abs(right - s.right) > 1
    )
      return NO_AROUND;
    return {
      right: Math.max(0, o.right - right),
      left: Math.max(0, left - o.left),
      x: left - o.left,
      y: b.top + frame.top - o.top,
    };
  }

  onMount(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = motion.matches;
    const onMotion = () => (reduced = motion.matches);
    motion.addEventListener("change", onMotion);
    most = document.documentElement.dataset["lite"] === undefined ? 60 : 15;
    const observer = new ResizeObserver(measure);
    if (box !== null) observer.observe(box);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
    };
  });

  // 外の所が出入りした・大きさが変わった (右の列の幅が変わったときなど) ら測り直す。observe した直後にも1回呼ばれる
  $effect(() => {
    const out = outer;
    if (out === null) {
      around = NO_AROUND;
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(out);
    return () => observer.disconnect();
  });

  // 流すのは見せている間だけ。0.1 秒おきに新しいものを取る (コメントは秒より細かく合わせる必要が無い)
  $effect(() => {
    if (!show) {
      items = [];
      lanes.clear();
      waiting = [];
      feed.pause();
      return;
    }
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  });

  /** 止めて置くか (上・下・動きを減らす設定) */
  function stillOf(comment: Comment): boolean {
    return reduced || comment.style?.place !== undefined;
  }

  function tick(): void {
    const w = air();
    if (w === null || frame.width <= 0) return;
    const path: Outside = reduced
      ? NO_OUTSIDE
      : { right: around.right, left: around.left };
    const trail = path.right > 0 || path.left > 0 ? outer : null;
    const { comments, jumped } = feed.take(
      w,
      ahead ? lead(frame.width, path.right) : 0,
    );
    if (jumped) {
      items = [];
      lanes.clear();
      waiting = [];
    }
    // 止めるものは時刻が来てから出す (流れるものは外を渡るぶん先に出す)
    const due = waiting.filter((c) => c.at <= w);
    if (due.length > 0) waiting = waiting.filter((c) => c.at > w);
    for (const comment of comments) {
      if (stillOf(comment) && comment.at > w) waiting.push(comment);
      else due.push(comment);
    }
    if (due.length === 0) return;
    const added: Item[] = [];
    for (const comment of due) {
      if (items.length + added.length >= most) break;
      const style = comment.style ?? {};
      const still = stillOf(comment);
      let px = size * sizeScale(style.size);
      let width = textWidth(comment.text, px);
      // 止めるものは枠に収める (流れるものは長くても流れきる)
      if (still && width > frame.width) {
        px *= frame.width / width;
        width = frame.width;
      }
      const flow = still
        ? lanes.hold(w, style.place === "shita" ? "bottom" : "top")
        : lanes.flow(w, width, frame.width, px, path);
      if (flow === null) continue;
      added.push({
        id: nextId++,
        text: comment.text,
        lane: flow.lane,
        duration: flow.duration,
        width,
        still,
        size: px,
        color: style.color,
        mine: comment.mine === true,
        path: still ? NO_OUTSIDE : path,
        trail: still ? null : trail,
      });
    }
    if (added.length > 0) items = [...items, ...added];
  }

  function done(id: number): void {
    items = items.filter((item) => item.id !== id);
  }

  /** 舞台の外の所へ移す (枠の `overflow: hidden` と重なりの順から出す)。消すときは自分で外す */
  function into(target: HTMLElement): Attachment<HTMLElement> {
    return (node) => {
      target.append(node);
      return () => node.remove();
    };
  }
</script>

{#snippet comment(item: Item, testid: string, end?: () => void)}
  <span
    class="comment"
    class:still={item.still}
    class:mine-dot={item.mine}
    style:font-size={item.size === size ? undefined : `${item.size}px`}
    style:color={item.color}
    data-testid={testid}
    style:top="{(item.lane + 0.5) * line}px"
    style:--from="{frame.width + item.path.right}px"
    style:--to="{-item.width - item.path.left}px"
    style:animation-duration|important="{item.duration / Math.max(rate, 0.1)}ms"
    onanimationend={end}>{item.text}</span
  >
{/snippet}

<div
  bind:this={box}
  class="jikkyo"
  data-paused={paused ? "" : undefined}
  data-testid="jikkyo-layer"
  aria-hidden="true"
>
  <div
    class="frame"
    data-frame
    style:left="{frame.left}px"
    style:top="{frame.top}px"
    style:width="{frame.width}px"
    style:height="{frame.height}px"
    style:font-size="{size}px"
    style:line-height="{line}px"
  >
    {#each items as item (item.id)}
      {@render comment(item, "jikkyo-comment", () => done(item.id))}
    {/each}
  </div>
</div>
{#if outer !== null}
  <!-- 枠の外の写し。舞台の外の所へ移し、枠と同じ位置・大きさに置く (はみ出したぶんは外の所が切る) -->
  <div
    {@attach into(outer)}
    class="trail"
    data-paused={paused ? "" : undefined}
    data-testid="jikkyo-outside"
    aria-hidden="true"
    style:left="{around.x}px"
    style:top="{around.y}px"
    style:width="{frame.width}px"
    style:height="{frame.height}px"
    style:font-size="{size}px"
    style:line-height="{line}px"
  >
    {#each items as item (item.id)}
      {#if item.trail === outer}
        {@render comment(item, "jikkyo-outside-comment")}
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* 操作列の影 (7) より上、字幕 (9) と操作列のボタン (10) より下 (`ControlBar`) */
  .jikkyo {
    position: absolute;
    inset: 0;
    z-index: 8;
    overflow: hidden;
    pointer-events: none;
  }
  .frame {
    position: absolute;
    overflow: hidden;
  }
  /* 枠の外の写しを置く所。切るのは外の所 (`PlayerStage` の `.outside`) */
  .trail {
    position: absolute;
    pointer-events: none;
  }
  .comment {
    position: absolute;
    left: 0;
    white-space: pre;
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
  /* 自分の書き込みの点 (`.mine-dot`) にも字と同じ黒い縁 */
  .comment.mine-dot::before {
    box-shadow: 0 0 0 1px #000;
  }
  .jikkyo[data-paused] .comment,
  .trail[data-paused] .comment {
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
