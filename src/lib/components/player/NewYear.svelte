<script lang="ts" module>
  /**
   * 紙吹雪の 1 枚ずつ。毎回同じ並びで足りるので、乱数ではなく決めた表にする。
   * `x` は左からの位置 (%)、`d` は落ちる長さの倍率 (`--dp-pulse` に掛ける)、`w` は出るまでの待ち (`--dp-duration` の何倍か)、
   * `r` は落ちきるまでに回る角度、`c` は色 (下の style の `.c0`〜`.c3`)、`s` は形 (`rect` 長方形・`strip` 細い帯・`dot` 丸)
   */
  const PIECES = [
    { x: 3, d: 1.1, w: 0, r: 220, c: 0, s: "rect" },
    { x: 9, d: 1.2, w: 3, r: -180, c: 1, s: "dot" },
    { x: 15, d: 1, w: 1, r: 300, c: 2, s: "strip" },
    { x: 21, d: 1.2, w: 4, r: -240, c: 3, s: "rect" },
    { x: 27, d: 1.05, w: 2, r: 160, c: 1, s: "strip" },
    { x: 33, d: 1.25, w: 0, r: -320, c: 2, s: "rect" },
    { x: 39, d: 1, w: 3, r: 200, c: 0, s: "dot" },
    { x: 45, d: 1.15, w: 1, r: -200, c: 3, s: "strip" },
    { x: 51, d: 1.2, w: 4, r: 280, c: 1, s: "rect" },
    { x: 57, d: 1.05, w: 2, r: -160, c: 2, s: "dot" },
    { x: 63, d: 1.2, w: 0, r: 240, c: 0, s: "strip" },
    { x: 69, d: 1, w: 3, r: -300, c: 3, s: "rect" },
    { x: 75, d: 1.1, w: 1, r: 180, c: 1, s: "rect" },
    { x: 81, d: 1.25, w: 4, r: -220, c: 2, s: "strip" },
    { x: 87, d: 1.05, w: 2, r: 260, c: 0, s: "dot" },
    { x: 93, d: 1.2, w: 0, r: -260, c: 3, s: "rect" },
    { x: 97, d: 1.15, w: 3, r: 200, c: 1, s: "strip" },
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
   * - 映している場面の放送の時刻 (`at`) で数える。23:59:50 から右下に 10・9・8… と大きく出し (映像の高さの 15%。数字ごとに弾んで替わり、
   *   5 秒前からは空色で少し大きく)、0:00 に「あけましておめでとうございます」を真ん中に 3 秒だけ出して消す
   * - 紙吹雪は年越しの前後で実況の勢いが跳ねたら 1 回だけ (`season.ts` の `ConfettiTrigger`)。実況を開いていなければ (`force` が null) 0:00 に 1 回だけ。
   *   あいさつより奥に降らせる (字を隠さない)。動きを減らす設定では降らせない
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

  /** 動きを減らす設定 (紙吹雪を出さない。カウントダウンとあいさつは動かさずに出す) */
  const still = new MediaQuery("prefers-reduced-motion: reduce");

  let shown = $state<Countdown>(null);
  /** 紙吹雪の回 (同じ部品で 2 回目を降らせるときに作り直す) */
  let rain = $state(0);
  let raining = $state(false);

  /** 年越しから遠い間は 1 秒ごと、近い間は 0.2 秒ごとに放送の時刻を読む (秒の変わり目から遅れすぎない) */
  const FAR = 1000;
  const NEAR = 200;
  /** この秒から色を替えて大きくする (0:00 に向けて盛り上げる) */
  const FINAL = 5;

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

{#if !hidden && (shown !== null || raining)}
  <!-- 舞台いっぱいの層。大きさは映像の高さから決める (`cqh`)。重なりは 紙吹雪 → 数字・あいさつ -->
  <div
    class="new-year"
    aria-hidden={shown?.kind === "count" ? "true" : undefined}
  >
    {#if raining && !still.current}
      {#key rain}
        <div class="confetti" data-testid="{testid}-confetti">
          {#each PIECES as piece, i (i)}
            <i
              class="c{piece.c} {piece.s}"
              style:--x="{piece.x}%"
              style:--d={piece.d}
              style:--w={piece.w}
              style:--r="{piece.r}deg"
            ></i>
          {/each}
        </div>
      {/key}
    {/if}
    {#if shown?.kind === "count"}
      <!-- 秒の数は読み上げない (毎秒読まれる) -->
      <div
        class="count"
        data-final={shown.n <= FINAL ? "" : undefined}
        data-testid={testid}
        data-kind="count"
      >
        {#key shown.n}
          <span class="pop">{shown.n}</span>
        {/key}
      </div>
    {:else if shown?.kind === "greet"}
      <div class="greet" role="status" data-testid={testid} data-kind="greet">
        <span class="pop">あけましておめでとうございます</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* 舞台いっぱいに重ねる。押せない (下の映像を押せるように) */
  .new-year {
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: var(--dp-z-stage-controls);
    container-type: size;
    overflow: hidden;
  }

  /*
   * 秒の数。右下 (字幕はたいてい下の真ん中、右端の縦のボタンの列は上から並ぶ)。操作バーの高さ (`--stage-bar`) のぶん上げ、
   * 右の列の幅 (4rem) だけ左に寄せて、操作バーと右の列が出ても重ならない。字の大きさは映像の高さの 15%
   */
  .count {
    position: absolute;
    right: 4rem;
    bottom: calc(var(--stage-bar, 0px) + var(--dp-space-2));
    font-size: 15cqh;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--dp-on-video);
    filter: var(--dp-on-video-ink) drop-shadow(0 0 0.15em rgb(0 0 0 / 0.5));
  }
  /* 5 秒前から: 映像の上のアクセント (空色) で、少し大きく */
  .count[data-final] {
    font-size: 19cqh;
    color: var(--dp-on-video-on);
  }

  /* あいさつ。真ん中に、映像の上の覆いの面 (`--dp-video-veil`) を敷いて大きく。紙吹雪より手前 */
  .greet {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--dp-space-4);
  }
  .greet .pop {
    max-width: 100%;
    padding: 0.4em 0.9em;
    border-radius: var(--dp-radius-full);
    background: var(--dp-video-veil);
    font-size: clamp(var(--dp-text-base), 7cqh, 3rem);
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    color: var(--dp-on-video);
  }

  /* 数字ごとに大きいところから弾んで替わり、あいさつは透明から少し大きくなって出る (ばね)。動きを減らす設定では時間のトークンが 0 になる */
  .pop {
    display: inline-block;
    animation: pop var(--dp-duration-move) var(--dp-ease-spring);
  }
  .count .pop {
    animation-name: bounce;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.85);
    }
  }
  @keyframes bounce {
    from {
      opacity: 0.4;
      transform: scale(1.45);
    }
  }

  /* 紙吹雪。舞台の上から 7 割まで落ちて消える。あいさつより奥 (先に置く) */
  .confetti {
    position: absolute;
    inset: 0 0 30%;
    container-type: size;
  }
  .confetti i {
    position: absolute;
    top: -1rem;
    left: var(--x);
    width: 0.5rem;
    height: 0.75rem;
    border-radius: 1px;
    opacity: 0;
    /* 落ちる長さは `--dp-pulse` (2s) を 1 枚ずつ伸び縮みさせ、出る時もずらす。transform と透明度だけで動かす */
    animation: fall calc(var(--dp-pulse) * var(--d)) var(--dp-ease-exit)
      calc(var(--dp-duration) * var(--w)) forwards;
  }
  .confetti .strip {
    width: 0.25rem;
    height: 1rem;
  }
  .confetti .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }
  /* 紅白と金、映像の上のアクセントの空色 (どれも映像の上の色で、テーマで変えない) */
  .c0 {
    background: var(--dp-on-video);
  }
  .c1 {
    background: var(--dp-season-red);
  }
  .c2 {
    background: var(--dp-season-gold);
  }
  .c3 {
    background: var(--dp-on-video-on);
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
