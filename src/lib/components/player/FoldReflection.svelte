<script lang="ts">
  import { changed, EVERY, follow, toneFrame, WASH_LUMINANCE } from "./ambient";
  import type { Ambient } from "./ambient.svelte.js";
  import { Crossfade, GlowLoop } from "./glow-loop.svelte.js";
  import {
    type ReflectionLayout,
    reflectionLayout,
    reflectionPixels,
    STRENGTH,
  } from "./reflection";

  /**
   * **テーブルトップの反射。** 折り畳み端末を半分に折って机に置いたとき (`PlayerLayout` の `TABLETOP`)、
   * 下の段の地に、上の段の映像の光が机に映り込んだ色を敷く (`reflection.ts`)。舞台 (`PlayerStage`) が、
   * この形の間だけアンビエントの光 (`AmbientGlow`) の代わりに置く。オン/オフはアンビエントモードと同じ設定。
   *
   * - 右の列 (局の一覧・番組の中身) はこの上に重なる (`PlayerLayout`)。色の明るさはアンビエントの光と同じ上限で、上の字は 4.5:1 を保つ
   * - 下の段は舞台の中 (いつも黒。テーマで変えない) なので、色の整え方は暗いテーマの側だけ
   * - 写す繰り返しと色の入れ替えはアンビエントの光と同じ部品 (`glow-loop.svelte.ts`)。動きを減らす設定と
   *   ソフトウェアで描いている端末 (`data-lite`) では、1 枚写したら止める
   */
  let {
    ambient,
    stage,
    aspect,
    fullscreen,
    testid,
  }: {
    ambient: Ambient;
    /** 映像の枠 (`PlayerStage` の `.stage`)。上の段で映像が出ている横の範囲を測る */
    stage: HTMLElement | null;
    /** 映像の縦横比 (`"16 / 9"`) */
    aspect: string;
    /** 全画面か (`StageFullscreen.active`)。全画面の間は下の段が見えない */
    fullscreen: boolean;
    testid: string;
  } = $props();

  const SIDES = [0, 1];
  let box = $state<HTMLDivElement | null>(null);
  const canvases = $state<(HTMLCanvasElement | null)[]>([null, null]);

  const loop = new GlowLoop(() => ({ ambient, room: true, fullscreen }), show);
  const now = $derived(loop.now);

  let layout: ReflectionLayout | null = null;
  const fade = new Crossfade({
    box: () => box,
    canvases: (side) => [canvases[side]],
    size: () => layout,
  });
  /** いまの色 (32x18 の RGBA。時間でならしたもの) と、ならしている途中の色 */
  let colors: Float32Array | null = null;
  let smoothed: Float32Array | null = null;
  let lastAt: number | null = null;

  function compose(
    target: HTMLCanvasElement,
    colors: Float32Array,
    at: ReflectionLayout,
  ): void {
    const context = target.getContext("2d");
    if (context === null) return;
    const frame = Uint8ClampedArray.from(colors);
    toneFrame(frame, "dark", WASH_LUMINANCE);
    const pixels = reflectionPixels(frame, at, STRENGTH);
    context.putImageData(new ImageData(pixels, at.width, at.height), 0, 0);
  }

  /** 置き場が変わったら、いまの色をその場で描き直す */
  function repaint(): void {
    const at = layout;
    const last = colors;
    fade.repaint(
      at !== null && last !== null ? (layer) => compose(layer, last, at) : null,
    );
  }

  function show(pixels: Uint8ClampedArray): void {
    const at = performance.now();
    /*
     * 写した 32x18 をそのまま返して映す (縁を延ばした色 `edgeExtend` では、深い所に左右の縁の色が混ざる)。
     * ちらつきは時間でならして抑える (`follow`)
     */
    smoothed = follow(smoothed, pixels, lastAt === null ? EVERY : at - lastAt);
    lastAt = at;
    if (colors !== null && !changed(colors, smoothed)) return;
    const next = Float32Array.from(smoothed);
    colors = next;
    const place = layout;
    if (place === null) return;
    fade.next((layer) => compose(layer, next, place));
  }

  /** 消したら色も捨てる */
  $effect(() => {
    if (now !== "off") return;
    colors = null;
    smoothed = null;
    lastAt = null;
    fade.repaint(null);
  });

  /** 下の段 (この箱。位置は CSS の `env(viewport-segment-*)`) と、上の段で映像が出ている横の範囲を測る */
  $effect(() => {
    const outer = box;
    const target = stage;
    const ratio = aspect;
    if (outer === null || target === null) return;
    const measure = () => {
      const segment = outer.getBoundingClientRect();
      const frame = target.getBoundingClientRect();
      // 枠が映像の形でないとき (狭い画面で上下に黒帯が出る) は、映像の幅だけ
      const [w = 16, h = 9] = ratio.split("/").map(Number);
      const width = Math.min(frame.width, (frame.height * w) / h);
      const next = reflectionLayout(segment, {
        left: frame.left + (frame.width - width) / 2 - segment.left,
        width,
      });
      const resized =
        layout === null ||
        next.width !== layout.width ||
        next.height !== layout.height;
      // 置き場が変わらなければ描き直さない (入れ替えの途中を捨てない)
      const moved = resized || next.x !== layout?.x || next.w !== layout?.w;
      layout = next;
      if (resized)
        for (const canvas of canvases) {
          if (!canvas) continue;
          canvas.width = next.width;
          canvas.height = next.height;
        }
      if (moved) repaint();
    };
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(outer);
    sizes.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      sizes.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
</script>

<div
  bind:this={box}
  class="reflection"
  data-off={now === "off" ? "" : undefined}
  data-plan={now}
  data-updates={loop.updates}
  data-testid={testid}
  aria-hidden="true"
>
  {#each SIDES as side (side)}
    <canvas bind:this={canvases[side]}></canvas>
  {/each}
</div>

<style>
  /*
   * 下の段いっぱい (折り目と蝶番の隙間の下から、画面の下の端まで)。黒い地 (`PlayerLayout`) の上、右の列の下に描く —
   * 文書の順で右の列より前にあり、右の列は位置を持たせてある
   */
  .reflection {
    position: fixed;
    top: env(viewport-segment-top 0 1, 50%);
    right: 0;
    bottom: 0;
    left: 0;
    pointer-events: none;
    /* 2枚の足し合わせ (下の `plus-lighter`) を箱の中で済ませる */
    isolation: isolate;
  }
  .reflection[data-off] {
    display: none;
  }
  /* 入れ替えはアンビエントの光と同じ (`AmbientGlow` の `canvas`)。表の印と、その場で入れ替える印は JS が付ける */
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    mix-blend-mode: plus-lighter;
    transition: opacity var(--dp-duration) var(--dp-ease);
  }
  canvas:global([data-front]) {
    opacity: 1;
  }
  .reflection:global([data-instant]) canvas {
    transition: none;
  }
</style>
