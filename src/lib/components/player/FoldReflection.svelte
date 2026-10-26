<script lang="ts">
  import { read } from "#lib/keep.js";

  import { changed, EVERY, follow, GLANCE, plan, toneFrame } from "./ambient";
  import type { Ambient } from "./ambient.svelte.js";
  import {
    type ReflectionLayout,
    reflectionLayout,
    reflectionPixels,
    storedStrength,
    STRENGTHS,
  } from "./reflection";

  /**
   * **テーブルトップの反射** (試作)。折り畳み端末を半分に折って机に置いたとき、下の段に映像の光が机に映り込んだ色を出す
   * (`reflection.ts`)。舞台 (`PlayerStage`) が、テーブルトップの形の間だけアンビエントの光 (`AmbientGlow`) の代わりに置く。
   *
   * - 写し方・ならし方・入れ替えの決め方はアンビエントの光と同じもの (`ambient.ts` の `plan`・`follow`・`changed`)
   * - 下の段は舞台の中 (いつも黒い。テーマで変えない) なので、色の整え方は暗いテーマの側だけ
   * - 色の入れ替えは canvas 2 枚の透明度の transition (下の style)。JS は表の印を付け替えるだけ
   * - ソフトウェアで描いている端末 (`data-lite`) と動きを減らす設定では、1 枚写したら止める
   */
  let {
    ambient,
    stage,
    aspect,
    testid,
  }: {
    ambient: Ambient;
    /** 映像の枠 (`PlayerStage` の `.stage`)。上の段で映像が出ている範囲を測る */
    stage: HTMLElement | null;
    /** 映像の縦横比 (`"16 / 9"`) */
    aspect: string;
    testid: string;
  } = $props();

  const SIDES = [0, 1];
  let box = $state<HTMLDivElement | null>(null);
  const canvases = $state<(HTMLCanvasElement | null)[]>([null, null]);

  let hidden = $state(false);
  let reduced = $state(false);
  let lite = $state(false);
  let lit = $state(false);
  let updates = $state(0);
  /** 試作の切り替え。決まったら外す */
  const strength = STRENGTHS[storedStrength(read("player-reflection"))];

  const now = $derived(
    plan({
      on: ambient.on,
      room: true,
      // 下の段は舞台の中なので、全画面でも見える
      fullscreen: false,
      hidden,
      reduced: reduced || lite,
      playing: ambient.playing,
      lit,
    }),
  );

  let layout: ReflectionLayout | null = null;
  let colors: Float32Array | null = null;
  let smoothed: Float32Array | null = null;
  let lastAt: number | null = null;
  let front = 0;
  let edge: HTMLCanvasElement | null = null;

  function framePixels(bitmap: ImageBitmap): Uint8ClampedArray | null {
    if (edge === null) {
      edge = document.createElement("canvas");
      edge.width = GLANCE.width;
      edge.height = GLANCE.height;
    }
    const context = edge.getContext("2d", { willReadFrequently: true });
    if (context === null) return null;
    context.clearRect(0, 0, GLANCE.width, GLANCE.height);
    context.drawImage(bitmap, 0, 0, GLANCE.width, GLANCE.height);
    return context.getImageData(0, 0, GLANCE.width, GLANCE.height).data;
  }

  function draw(canvas: HTMLCanvasElement, at: ReflectionLayout): void {
    const context = canvas.getContext("2d");
    if (context === null || colors === null) return;
    const frame = Uint8ClampedArray.from(colors);
    toneFrame(frame, "dark", { dark: strength.luminance, light: 1 });
    const pixels = reflectionPixels(frame, at, strength);
    context.putImageData(new ImageData(pixels, at.width, at.height), 0, 0);
  }

  function face(side: number, instant: boolean): void {
    front = side;
    box?.toggleAttribute("data-instant", instant);
    canvases.forEach((canvas, k) =>
      canvas?.toggleAttribute("data-front", k === side),
    );
    if (!instant || box === null) return;
    void getComputedStyle(canvases[side] ?? box).opacity;
    box.removeAttribute("data-instant");
  }

  /** 置き場が変わったら、いまの色をその場で描き直す */
  function repaint(): void {
    const canvas = canvases[front];
    if (!canvas || layout === null) return;
    draw(canvas, layout);
    face(front, true);
  }

  function show(bitmap: ImageBitmap): void {
    const pixels = framePixels(bitmap);
    bitmap.close();
    if (pixels === null) return;
    const at = performance.now();
    // 写した 32x18 をそのまま返して映す (縁を延ばした色 `edgeExtend` では、深い所に左右の縁の色が混ざった)。
    // ちらつきは時間でならして抑える (`follow`)
    smoothed = follow(smoothed, pixels, lastAt === null ? EVERY : at - lastAt);
    lastAt = at;
    if (colors !== null && !changed(colors, smoothed)) return;
    colors = Float32Array.from(smoothed);
    const back = 1 - front;
    const canvas = canvases[back];
    if (!canvas || layout === null) return;
    draw(canvas, layout);
    face(back, false);
  }

  $effect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const check = () => {
      hidden = document.visibilityState === "hidden";
      reduced = motion.matches;
      lite = document.documentElement.hasAttribute("data-lite");
    };
    check();
    document.addEventListener("visibilitychange", check);
    motion.addEventListener("change", check);
    const root = new MutationObserver(check);
    root.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-lite"],
    });
    return () => {
      document.removeEventListener("visibilitychange", check);
      motion.removeEventListener("change", check);
      root.disconnect();
    };
  });

  $effect(() => {
    if (now !== "off") return;
    lit = false;
    colors = null;
    smoothed = null;
    lastAt = null;
    for (const canvas of canvases)
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  });

  /** 下の段 (この箱。位置は CSS の `env(viewport-segment-*)`) と、上の段で映像が出ている横の範囲を測る */
  $effect(() => {
    const outer = box;
    const target = stage;
    const ratio = aspect;
    if (outer === null || target === null) return;
    const measure = () => {
      const segment = outer.getBoundingClientRect();
      const media = target
        .querySelector(":scope > [data-stage-media]")
        ?.getBoundingClientRect();
      const [w = 16, h = 9] = ratio.split("/").map(Number);
      const top = media ?? target.getBoundingClientRect();
      const width = Math.min(top.width, (top.height * w) / h);
      const next = reflectionLayout(segment, {
        left: top.left + (top.width - width) / 2 - segment.left,
        width,
      });
      const resized =
        layout === null ||
        next.width !== layout.width ||
        next.height !== layout.height;
      layout = next;
      for (const canvas of canvases) {
        if (!canvas || !resized) continue;
        canvas.width = next.width;
        canvas.height = next.height;
      }
      repaint();
    };
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(outer);
    sizes.observe(target);
    return () => sizes.disconnect();
  });

  $effect(() => {
    if (now !== "watch") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = (await ambient.glance(GLANCE)) ?? null;
      } catch {
        // 写せなかった。次の回にまた写す
      }
      if (stopped) {
        bitmap?.close();
        return;
      }
      if (bitmap !== null) {
        show(bitmap);
        updates++;
        lit = true;
      }
      timer = setTimeout(run, EVERY);
    };
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });
</script>

<div
  bind:this={box}
  class="reflection"
  data-plan={now}
  data-updates={updates}
  data-testid={testid}
  aria-hidden="true"
>
  {#each SIDES as side (side)}
    <canvas bind:this={canvases[side]}></canvas>
  {/each}
</div>

<style>
  /*
   * 下の段いっぱい。折り目 (と蝶番の隙間) の下から、画面の下の端まで。
   * 位置を持つ枠 (`.stage`) の中で、文書の順でいちばん前にあるので、映像と操作の下になる
   */
  .reflection {
    position: absolute;
    top: env(viewport-segment-top 0 1, 50%);
    right: 0;
    bottom: 0;
    left: 0;
    pointer-events: none;
    isolation: isolate;
  }
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
  .reflection:global([data-instant]) canvas,
  :global(:root[data-lite]) canvas {
    transition: none;
  }
</style>
