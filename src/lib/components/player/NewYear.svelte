<script lang="ts" module>
  /**
   * 紙吹雪の 1 枚ずつ。毎回同じ並びで足りるので、乱数ではなく決めた表にする。
   * `x` は左からの位置 (%)、`d` は落ちる長さの倍率 (`--dp-pulse` に掛ける)、`w` は出るまでの待ち (`--dp-duration` の何倍か)、
   * `r` は落ちきるまでに回る角度、`c` は白の濃さ (下の style)
   */
  const PIECES = [
    { x: 4, d: 1.1, w: 0, r: 220, c: 0 },
    { x: 11, d: 1.3, w: 3, r: -180, c: 1 },
    { x: 18, d: 0.95, w: 1, r: 300, c: 2 },
    { x: 26, d: 1.2, w: 4, r: -240, c: 0 },
    { x: 33, d: 1.05, w: 2, r: 160, c: 1 },
    { x: 41, d: 1.25, w: 0, r: -320, c: 0 },
    { x: 48, d: 0.9, w: 3, r: 200, c: 2 },
    { x: 55, d: 1.15, w: 1, r: -200, c: 1 },
    { x: 62, d: 1.3, w: 4, r: 280, c: 0 },
    { x: 69, d: 1, w: 2, r: -160, c: 2 },
    { x: 76, d: 1.2, w: 0, r: 240, c: 1 },
    { x: 83, d: 0.95, w: 3, r: -300, c: 0 },
    { x: 90, d: 1.1, w: 1, r: 180, c: 2 },
    { x: 96, d: 1.25, w: 4, r: -220, c: 1 },
  ] as const;
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";

  import {
    CONFETTI_FOR,
    ConfettiTrigger,
    type Countdown,
    countdown,
    nearNewYear,
  } from "#lib/season.js";
  import { season } from "#lib/season.svelte.js";

  /**
   * **年越しのカウントダウンと紙吹雪** (ライブ・追っかけ・観る画面の舞台に重ねる。docs/screens.md「季節の演出」・docs/design.md「季節の演出」)。
   *
   * - 映している場面の放送の時刻 (`at`) で数える。23:59:50 から左上の隅に 10・9・8… と小さく出し、0:00 に
   *   「あけましておめでとうございます」を少しだけ出して消す
   * - 紙吹雪は年越しの前後で実況の勢いが跳ねたら 1 回だけ (`season.ts` の `ConfettiTrigger`)。実況を開いていなければ (`force` が null) 0:00 に 1 回だけ。
   *   舞台の上のほうにだけ降らせ、下に出る字幕に掛けない。動きを減らす設定では降らせない
   * - **押せず、操作バーも起こさない** (ポインタを受けない)。データ放送を出している間 (`hidden`) は出さない
   * - 世帯の設定 (季節の演出) がオフか、サーバの時刻をもらえていなければ何もしない
   */
  let {
    at,
    force = null,
    hidden = false,
    testid,
  }: {
    /** 映している場面の放送の時刻 (unix ms)。分からなければ null */
    at: () => number | null;
    /** いまの勢い (1 分あたりのコメント数)。実況を開いていなければ null */
    force?: (() => number) | null;
    hidden?: boolean;
    testid: string;
  } = $props();

  /** 動きを減らす設定 (紙吹雪を出さない。カウントダウンは出す) */
  const still = new MediaQuery("prefers-reduced-motion: reduce");

  let shown = $state<Countdown>(null);
  /** 紙吹雪の回 (同じ部品で 2 回目を降らせるときに作り直す) */
  let rain = $state(0);
  let raining = $state(false);

  /** 年越しから遠い間は 1 秒ごと、近い間は 0.2 秒ごとに放送の時刻を見る (秒の変わり目から遅れすぎない) */
  const FAR = 1000;
  const NEAR = 200;

  function label(c: Countdown): string {
    return c === null ? "" : c.kind === "count" ? String(c.n) : c.kind;
  }

  $effect(() => {
    if (!season.ready) {
      shown = null;
      return;
    }
    const readForce = force;
    const trigger = new ConfettiTrigger();
    let timer: ReturnType<typeof setTimeout>;
    let stop: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      const t = at();
      const next = t === null ? null : countdown(t);
      // 同じ秒のうちは書き換えない (0.2 秒ごとに描き直さない)
      if (label(next) !== label(shown)) shown = next;
      if (
        t !== null &&
        trigger.feed(t, readForce === null ? null : readForce())
      ) {
        rain++;
        raining = true;
        clearTimeout(stop);
        stop = setTimeout(() => (raining = false), CONFETTI_FOR);
      }
      timer = setTimeout(tick, t !== null && nearNewYear(t) ? NEAR : FAR);
    };
    // 中で読む放送の時刻はこの $effect の依存にしない (毎コマ作り直さない)
    untrack(tick);
    return () => {
      clearTimeout(timer);
      clearTimeout(stop);
    };
  });
</script>

{#if !hidden && shown !== null}
  <!-- 秒の数は読み上げない (毎秒読まれる)。あいさつだけ読む -->
  <div
    class="stage-note new-year"
    role={shown.kind === "greet" ? "status" : undefined}
    aria-hidden={shown.kind === "count" ? "true" : undefined}
    data-testid={testid}
    data-kind={shown.kind}
  >
    {#if shown.kind === "count"}
      {#key shown.n}
        <span class="tick">{shown.n}</span>
      {/key}
    {:else}
      <span class="tick">あけましておめでとうございます</span>
    {/if}
  </div>
{/if}

{#if !hidden && raining && !still.current}
  {#key rain}
    <div class="confetti" aria-hidden="true" data-testid="{testid}-confetti">
      {#each PIECES as piece, i (i)}
        <i
          class="c{piece.c}"
          style:--x="{piece.x}%"
          style:--d={piece.d}
          style:--w={piece.w}
          style:--r="{piece.r}deg"
        ></i>
      {/each}
    </div>
  {/key}
{/if}

<style>
  /*
   * 左上の隅 (右端は縦のボタンの列、上の真ん中は通知の列)。字は映像の上の短い通知と同じ (`.stage-note`)。
   * 実況のコメントは枠の上下に半行ずつ空けて流れ、字幕はたいてい下に出るので、上の隅に小さく置く
   */
  .new-year {
    pointer-events: none;
    position: absolute;
    top: var(--dp-space-2);
    left: var(--dp-space-2);
    z-index: var(--dp-z-stage-controls);
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  /* 秒が替わるたびに透明度だけでふわっと出す (`--dp-duration-enter`)。動きを減らす設定では時間のトークンが 0 になる */
  .tick {
    display: inline-block;
    animation: tick var(--dp-duration-enter) var(--dp-ease);
  }
  @keyframes tick {
    from {
      opacity: 0;
    }
  }
  /* 舞台の上の 4 割だけに降らせる (下に出る字幕に掛けない)。押せない */
  .confetti {
    pointer-events: none;
    position: absolute;
    inset: 0 0 60%;
    z-index: var(--dp-z-stage-controls);
    overflow: hidden;
    container-type: size;
  }
  .confetti i {
    position: absolute;
    top: -0.5rem;
    left: var(--x);
    width: 0.375rem;
    height: 0.625rem;
    border-radius: 1px;
    opacity: 0;
    /* 落ちる長さは `--dp-pulse` (2s) を 1 枚ずつ伸び縮みさせ、出る時もずらす。transform と透明度だけで動かす */
    animation: fall calc(var(--dp-pulse) * var(--d)) var(--dp-ease-exit)
      calc(var(--dp-duration) * var(--w)) forwards;
  }
  /* 映像の上の字と同じ白を 3 つの濃さで (テーマで変えない。色に役目を持たせない。docs/design.md「季節の演出」) */
  .c0 {
    background: var(--dp-on-video);
  }
  .c1 {
    background: var(--dp-on-video-soft);
  }
  .c2 {
    background: var(--dp-on-video-muted);
  }
  @keyframes fall {
    from {
      opacity: 1;
      transform: translateY(0) rotate(0);
    }
    80% {
      opacity: 1;
    }
    to {
      opacity: 0;
      transform: translateY(100cqh) rotate(var(--r));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .confetti {
      display: none;
    }
  }
</style>
