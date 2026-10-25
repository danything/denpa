<script lang="ts">
  import { untrack } from "svelte";

  import { setAmbientThemeColor, themeBackground } from "#lib/theme-color.js";

  import {
    changed,
    colorStep,
    edgeExtend,
    EVERY,
    farthest,
    follow,
    frameDelta,
    fromHex,
    GLANCE,
    type GlowLayout,
    glowLayout,
    glowPixels,
    plan,
    reach,
    type Rect,
    region,
    type Rgb,
    strips,
    toHex,
    toneFrame,
    TOOLBAR_STEP,
    WASH_LUMINANCE,
    washTop,
  } from "./ambient";
  import type { Ambient } from "./ambient.svelte.js";
  import { PHONE_LANDSCAPE } from "./PlayerLayout.svelte";

  /**
   * アンビエントモード。いまのコマの色を、映像の周りの地に薄く敷く (YouTube と同じ見え方。docs/player.md)。
   * 舞台 (`PlayerStage`) が枠のすぐ前 (兄弟) に置く。オン/オフと写し方は `ambient.svelte.ts`、計算は `ambient.ts`。
   *
   * - 縦に積むときは映像の下の中身に、二段組は窓全体に敷き、枠から離れるほど薄くする (`reach`・`farthest`)。
   *   明るさを抑えてから敷くので、上の字はどちらのテーマでも 4.5 以上で読める (`toneFrame`・`WASH_LUMINANCE`)
   * - 色は小さな canvas で作って CSS で引き伸ばす。`filter: blur` は使わない (GPU の無い端末で重かった)
   * - 前の色からの入れ替えは CSS の `opacity` の transition (下の style)。帯ごとに canvas を2枚重ね、新しい色を裏の1枚に
   *   描いてから表と裏を入れ替える (`face`)。ここで動かすのは「どちらが表か」の印だけ
   * - 色は枠に重ならない4本の帯 (`.band`) にだけ描く (`strips`)。枠の後ろに敷くと映像のコマごとに合成し直す
   * - ブラウザの枠の色 (`theme-color`) もページの上の端の色にする (`washTop`)
   * - 写さないときは `ambient.ts` の `plan`。映像の上には何も重ねない
   */
  let {
    ambient,
    stage,
    fullscreen,
    testid,
  }: {
    ambient: Ambient;
    /** 映像の枠 (`PlayerStage` の `.stage`) */
    stage: HTMLElement | null;
    /** 全画面か (`StageFullscreen.active`) */
    fullscreen: boolean;
    testid: string;
  } = $props();

  const BANDS = [0, 1, 2, 3];
  /** 帯ごとの2枚 (表と裏)。どちらが表かは `front` */
  const SIDES = [0, 1];
  let box = $state<HTMLDivElement | null>(null);
  const bands = $state<(HTMLDivElement | null)[]>([null, null, null, null]);
  /** 帯の canvas。帯 `i` の `side` の側は `i * 2 + side` */
  const canvases = $state<(HTMLCanvasElement | null)[]>(
    Array.from({ length: BANDS.length * SIDES.length }, () => null),
  );

  let hidden = $state(false);
  let reduced = $state(false);
  let room = $state(false);
  /** 縦に積んでいるか (768px より狭い)。色は映像の下へだけ敷く */
  let stacked = $state(false);
  let dark = $state(false);
  /** もう1枚写して光を出しているか */
  let lit = $state(false);
  /** 写した回数。E2E が「動いている・止まっている」を見る */
  let updates = $state(0);
  /** 最後に写した1枚と、最後に入れ替えた1枚の違い (`frameDelta`)。E2E が「止まった映像では 0 に近い」を見る */
  let delta = $state<number | null>(null);

  const now = $derived(
    plan({
      on: ambient.on,
      room,
      fullscreen,
      hidden,
      reduced,
      playing: ambient.playing,
      lit,
    }),
  );
  /** 光を出しているか。置き場はこれが変わったときだけ測り直す (写す・止めるの切り替えでは測らない) */
  const visible = $derived(now !== "off");

  /** いまの置き場。枠の大きさが変わると変わる */
  let layout: GlowLayout | null = null;
  /** 表と裏それぞれに描いた1枚 (画面に出さない canvas)。帯の canvas はここから切り出して描く */
  let layers: (HTMLCanvasElement | null)[] = [null, null];
  /** 入れ替えの途中で次の色が来たとき、見えている色を作る下書き (`settle`) */
  let spare: HTMLCanvasElement | null = null;
  /** いま表の側 (0 か 1) */
  let front = 0;
  /** いまの色 (縁を延ばした 32x18 の RGBA。時間でならしたもの)。置き場やテーマが変わったら、これから作り直す */
  let colors: Float32Array | null = null;
  /** 時間でならした色 (`follow`)。写すたびに進め、違いが大きくなったら `colors` に移す */
  let smoothed: Float32Array | null = null;
  /** 最後に写した時刻 (`performance.now`)。ならす重みを、経った時間で決める */
  let lastAt: number | null = null;

  function scratch(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = layout?.width ?? 1;
    canvas.height = layout?.height ?? 1;
    return canvas;
  }

  /** ならした色から、敷く色を作って描く (`toneFrame`・`glowPixels`) */
  function compose(
    target: HTMLCanvasElement,
    colors: Float32Array,
    at: GlowLayout,
  ): void {
    const context = target.getContext("2d");
    if (context === null) return;
    const frame = Uint8ClampedArray.from(colors);
    toneFrame(frame, dark ? "dark" : "light", WASH_LUMINANCE);
    const pixels = glowPixels(frame, GLANCE.width, GLANCE.height, at);
    context.putImageData(new ImageData(pixels, at.width, at.height), 0, 0);
    // ページの上の端の色をブラウザの枠の色にする (`washTop`)。描いたときだけ測るので、毎フレームの手間は無い
    const background = fromHex(themeBackground());
    if (background === null) return;
    const next = washTop(pixels, at.width, background, dark ? "dark" : "light");
    if (top === null || colorStep(top, next) >= TOOLBAR_STEP) top = next;
  }

  /** ページの上の端に見える色 (`washTop`)。ブラウザの枠の色にする (下の `toolbar`) */
  let top = $state<Rgb | null>(null);
  /**
   * **ブラウザの枠の色** (`theme-color.ts`)。色を敷いている間だけ。消した・全画面 (枠が見えない)・
   * 画面を離れたときはテーマの地に戻す。変わるのは色を入れ替えたときだけ (多くて 1 秒に 5 回)
   */
  const toolbar = $derived(
    now !== "off" && lit && !fullscreen && top !== null ? toHex(top) : null,
  );
  $effect(() => {
    setAmbientThemeColor(toolbar);
  });
  $effect(() => () => setAmbientThemeColor(null));

  let edge: HTMLCanvasElement | null = null;

  /** 写した1枚の画素 (32x18 の RGBA) */
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

  /** 帯の canvas の `side` の側に、その側の1枚 (`layers`) を描く。1枚も無ければ空にする */
  function paint(side: number): void {
    const layer = layers[side];
    canvases.forEach((canvas, k) => {
      const context = k % 2 === side ? canvas?.getContext("2d") : null;
      if (!canvas || !context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (layer) context.drawImage(layer, 0, 0);
    });
  }

  /**
   * `side` の側を表にする。入れ替えの動きは CSS (下の style の `[data-front]`)。
   * `instant` ならその場で入れ替える (transition を外して当て、計算させてから戻す)
   */
  function face(side: number, instant: boolean): void {
    front = side;
    box?.toggleAttribute("data-instant", instant);
    canvases.forEach((canvas, k) =>
      canvas?.toggleAttribute("data-front", k % 2 === side),
    );
    if (!instant || box === null) return;
    void getComputedStyle(canvases[side] ?? box).opacity;
    box.removeAttribute("data-instant");
  }

  /**
   * **入れ替えの途中で次の色が来たら、いま見えている色を表にしてから次へ進む** (色が跳ねない)。
   * 2枚は同じ曲線で逆に動き、足して重ねている (`plus-lighter`) ので、見えている色は
   * 「表 × 表の透明度 + 裏 × (1 − 表の透明度)」。それを裏に描いて、その場で表にする
   */
  function settle(): void {
    // 隠した帯の中では transition が進まないので、出ている帯の1枚で見る
    const shown = canvases.find(
      (canvas, k) => k % 2 === front && canvas?.parentElement?.hidden === false,
    );
    if (!shown || layout === null) return;
    const mix = Number.parseFloat(getComputedStyle(shown).opacity);
    if (!(mix < 1)) return;
    const back = 1 - front;
    spare ??= scratch();
    const context = spare.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, spare.width, spare.height);
    const old = layers[back];
    const next = layers[front];
    if (old) {
      context.globalAlpha = 1 - mix;
      context.drawImage(old, 0, 0);
    }
    if (next) {
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = mix;
      context.drawImage(next, 0, 0);
    }
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    [layers[back], spare] = [spare, old ?? null];
    paint(back);
    face(back, true);
  }

  /** いまの色を最後の1枚から作り直し、動かさずに表へ出す (置き場・テーマが変わったとき) */
  function repaint(): void {
    layers = [null, null];
    spare = null;
    if (colors !== null) {
      const layer = scratch();
      if (layout !== null) compose(layer, colors, layout);
      layers[front] = layer;
    }
    paint(0);
    paint(1);
    face(front, true);
  }

  /** 写した1枚を次の色にして、裏に描いてから表と裏を入れ替える (動きは CSS。動かさない設定ではすぐ) */
  function show(bitmap: ImageBitmap): void {
    const pixels = framePixels(bitmap);
    bitmap.close();
    if (pixels === null) return;
    // 縁の色を延ばし (`edgeExtend`)、時間でならす (`follow`。場面が変わったらすぐ)
    const now = performance.now();
    // ならした色は、入れ替えるかどうかに関わらず毎回進める (入れ替えを見送っても、ゆっくりした変化を捨てない)
    smoothed = follow(
      smoothed,
      edgeExtend(pixels),
      lastAt === null ? EVERY : now - lastAt,
    );
    lastAt = now;
    // 最後に入れ替えた色との違い。小さければ入れ替えない (`ambient.ts` の `changed`)
    delta = colors === null ? null : frameDelta(colors, smoothed);
    if (colors !== null && !changed(colors, smoothed)) return;
    colors = Float32Array.from(smoothed);
    if (layout === null) return;
    settle();
    const back = 1 - front;
    const layer = (layers[back] ??= scratch());
    compose(layer, colors, layout);
    paint(back);
    face(back, false);
  }

  $effect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const twoColumns = matchMedia("(min-width: 768px)");
    const phone = matchMedia(PHONE_LANDSCAPE);
    const check = () => {
      hidden = document.visibilityState === "hidden";
      reduced = motion.matches;
      room = !phone.matches;
      stacked = !twoColumns.matches;
      dark = document.documentElement.dataset["theme"] === "dark";
    };
    check();
    document.addEventListener("visibilitychange", check);
    // テーマはヘッダーのボタンと端末の設定で変わる (`theme.svelte.ts` が `<html data-theme>` を書き換える)
    const theme = new MutationObserver(check);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    for (const media of [motion, twoColumns, phone])
      media.addEventListener("change", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      theme.disconnect();
      for (const media of [motion, twoColumns, phone])
        media.removeEventListener("change", check);
    };
  });

  /** 色を敷いている間、右の列を色の上に描かせる (`<html data-ambient>`。下の style) */
  $effect(() => {
    if (now === "off" || !lit) return;
    const root = document.documentElement;
    root.dataset["ambient"] = "";
    return () => {
      delete root.dataset["ambient"];
    };
  });

  /** 消したら光も捨てる。次にオンにしたときに古い色が出ないように */
  $effect(() => {
    if (now !== "off") return;
    lit = false;
    colors = null;
    smoothed = null;
    lastAt = null;
    top = null;
    layers = [null, null];
    spare = null;
    paint(0);
    paint(1);
  });

  /** テーマが変わったら、最後の1枚から塗り直す (色の濃くし方が違う) */
  $effect(() => {
    void dark;
    untrack(() => {
      if (colors !== null && layout !== null) repaint();
    });
  });

  /**
   * **範囲と帯の置き場を、枠に合わせて決める。** 枠・`<main>`・右の列の大きさが変わったとき、
   * 右の列が入れ替わったとき (ライブの局の一覧 ⇔ 番組の中身) に測り直す
   */
  $effect(() => {
    const target = stage;
    const outer = box;
    if (target === null || outer === null || !visible) return;
    const main = target.closest("main") ?? document.documentElement;
    const frame = target.closest<HTMLElement>("[data-player-layout]");
    const measure = () => {
      const s = target.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      /*
       * 二段組は**窓全体** (見出しと右の列の下にも敷き、窓の端へ向かって薄くする)。
       * 縦に積むときは、横は窓の幅、縦は `<main>` の中
       */
      const width = document.documentElement.clientWidth;
      const bounds: Rect = stacked
        ? { left: 0, top: m.top, right: width, bottom: m.bottom }
        : { left: 0, top: 0, right: width, bottom: window.innerHeight };
      const spread = stacked
        ? reach(s.width, false)
        : Math.max(reach(s.width, true), farthest(s, bounds));
      const area = region(s, bounds, spread);
      /*
       * 範囲の座標は入れ物 (いちばん近い位置を持つ祖先。無ければ文書) の内側から。
       * 文書のときは巻き取ったぶんを足す
       */
      const parent = outer.offsetParent;
      let baseLeft = -window.scrollX;
      let baseTop = -window.scrollY;
      if (
        parent instanceof HTMLElement &&
        getComputedStyle(parent).position !== "static"
      ) {
        const p = parent.getBoundingClientRect();
        baseLeft = p.left + parent.clientLeft - parent.scrollLeft;
        baseTop = p.top + parent.clientTop - parent.scrollTop;
      }
      const areaWidth = area.right - area.left;
      const areaHeight = area.bottom - area.top;
      outer.style.left = `${area.left - baseLeft}px`;
      outer.style.top = `${area.top - baseTop}px`;
      outer.style.width = `${areaWidth}px`;
      outer.style.height = `${areaHeight}px`;

      const next = glowLayout(area, s, spread);
      const resized =
        layout === null ||
        next.width !== layout.width ||
        next.height !== layout.height;
      const moved =
        resized ||
        next.x !== layout?.x ||
        next.y !== layout?.y ||
        next.radius !== layout?.radius;
      layout = next;

      const parts = strips(area, s);
      BANDS.forEach((i) => {
        const band = bands[i];
        if (!band) return;
        const part = parts[i];
        band.hidden = part === undefined;
        if (part === undefined) return;
        band.style.left = `${part.left - area.left}px`;
        band.style.top = `${part.top - area.top}px`;
        band.style.width = `${part.right - part.left}px`;
        band.style.height = `${part.bottom - part.top}px`;
        for (const side of SIDES) {
          const canvas = canvases[i * 2 + side];
          if (!canvas) continue;
          // canvas は範囲全体を覆い、帯はその一部を切り出す
          canvas.style.left = `${area.left - part.left}px`;
          canvas.style.top = `${area.top - part.top}px`;
          canvas.style.width = `${areaWidth}px`;
          canvas.style.height = `${areaHeight}px`;
          if (resized) {
            canvas.width = next.width;
            canvas.height = next.height;
          }
        }
      });
      // 置き場が変わったら、最後の1枚からぼかし直す (入れ替えの途中なら、そこで済ませる)
      if (moved) repaint();
    };
    measure();
    const sizes = new ResizeObserver(measure);
    const watchAside = () => {
      sizes.disconnect();
      sizes.observe(target);
      sizes.observe(main);
      const aside = frame?.querySelector(":scope > aside");
      if (aside) sizes.observe(aside);
      measure();
    };
    watchAside();
    const children = new MutationObserver(watchAside);
    if (frame) children.observe(frame, { childList: true });
    window.addEventListener("resize", measure);
    return () => {
      sizes.disconnect();
      children.disconnect();
      window.removeEventListener("resize", measure);
    };
  });

  /** 写す。`watch` の間だけ、`EVERY` ごとに */
  $effect(() => {
    if (now !== "watch") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = (await ambient.glance(GLANCE)) ?? null;
      } catch {
        // 写せなかった (切り替えの途中など)。次の回にまた写す
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
  class="ambient"
  data-off={now === "off" ? "" : undefined}
  data-plan={now}
  data-updates={updates}
  data-delta={delta === null ? undefined : delta.toFixed(2)}
  data-testid={testid}
  aria-hidden="true"
>
  {#each BANDS as i (i)}
    <div bind:this={bands[i]} class="band">
      {#each SIDES as side (side)}
        <canvas bind:this={canvases[i * 2 + side]}></canvas>
      {/each}
    </div>
  {/each}
</div>

<style>
  /*
     * 色を敷く範囲。位置と大きさは上の `measure` が書く。**自分では何も描かない** (帯が描く)。
     * 文書の順で枠より前にあるので、重なっても枠の下になる
     */
  .ambient {
    position: absolute;
    pointer-events: none;
  }
  .ambient[data-off] {
    display: none;
  }
  .band {
    position: absolute;
    overflow: hidden;
    /* 2枚の足し合わせ (下の `plus-lighter`) を帯の中で済ませ、ページの地には足さない */
    isolation: isolate;
  }
  /*
   * 明るいテーマでは地に掛ける (色の付いた所だけが乗る。`toneFrame` が色の薄い所を透明にしてある)。
   * 窓全体に敷くので控えめに (白へ寄るだけなので、字の読みやすさは変わらない)
   */
  :global(html:not([data-theme="dark"])) .band {
    mix-blend-mode: multiply;
    /* `ambient.ts` の `LIGHT_OPACITY` と同じ (枠の色を同じ描き方で作る) */
    opacity: 0.6;
  }
  /*
   * **色の入れ替え。** 表 (`data-front`) へ回った1枚が透明から出て、裏へ回った1枚が同じ長さ・同じ曲線で消える。
   * 2枚は重ねずに足す (`plus-lighter`) — 重ねると光の薄い所で透明度が足りなくなり、1秒に5回の入れ替えのたびに
   * 明滅して見えた。足せば途中も「前の色 × (1 − t) + 次の色 × t」になる。
   * 写す間隔 (`EVERY`。200ms) のうちに終わる長さにする。動かさない設定ではトークンが 0 になり、すぐ入れ替わる
   */
  canvas {
    position: absolute;
    opacity: 0;
    mix-blend-mode: plus-lighter;
    transition: opacity var(--dp-duration) var(--dp-ease);
  }
  canvas:global([data-front]) {
    opacity: 1;
  }
  /* 表の印と、置き場・テーマが変わったとき・入れ替えの途中で次が来たときに動かさない印は JS が付ける (`face`) */
  .ambient:global([data-instant]) canvas {
    transition: none;
  }
  /*
     * **右の列 (と、縦に積んだときの番組の中身) は色の上に描く。** 位置を持たせて、文書の順で色より後ろに
     * 描かせる (位置を持たない箱は、位置を持つ色より先に描かれて隠れる)
     */
  :global(html[data-ambient] [data-player-layout] > aside) {
    position: relative;
  }
</style>
