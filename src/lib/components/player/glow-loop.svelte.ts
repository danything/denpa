import { EVERY, GLANCE, plan } from "./ambient";
import type { Ambient } from "./ambient.svelte.js";

/**
 * 映像の色を写して敷く部品 (`AmbientGlow`・`FoldReflection`) で同じ所。どこに・どんな形で描くかは部品が持つ。
 *
 * - `GlowLoop` … 写す繰り返し。`EVERY` ごとに 32x18 (`GLANCE`) を1枚写して画素を渡す。写すか・止めるかは `ambient.ts` の `plan`
 * - `Crossfade` … 前の色からの入れ替え。canvas 2 枚 (表と裏) の透明度の transition で、JS は表の印を付け替えるだけ
 */

interface Where {
  ambient: Ambient;
  /** 色を敷ける形か (横にしたスマホでは敷かない) */
  room: boolean;
  /** 敷いた色が見えない (全画面) */
  fullscreen: boolean;
}

/**
 * **写す繰り返し。** 部品の初めに作る (中で `$effect` を使う)。
 *
 * 動きを減らす設定と、ソフトウェアで描いている端末 (`<html data-lite>`) では、1枚写したら止める (`still`)。
 * 1 秒に 5 回描き直すのは docs/design.md 7 章の「時間で動き続けるもの」で、重さの決まりに従う
 */
export class GlowLoop {
  #where: () => Where;
  /** 画面を離れている (裏のタブ) */
  hidden = $state(false);
  /** 1枚写したら止めるか (動きを減らす設定・`data-lite`) */
  still = $state(false);
  /** もう1枚写して色を出しているか */
  lit = $state(false);
  /** 写した回数。E2E が「動いている・止まっている」を見る */
  updates = $state(0);

  /** 写す (`watch`)・出したまま止める (`hold`)・消す (`off`) */
  now = $derived.by(() => {
    const where = this.#where();
    return plan({
      on: where.ambient.on,
      room: where.room,
      fullscreen: where.fullscreen,
      hidden: this.hidden,
      still: this.still,
      playing: where.ambient.playing,
      lit: this.lit,
    });
  });

  #edge: HTMLCanvasElement | null = null;

  /** `show` は写した1枚の画素 (32x18 の RGBA) を受ける */
  constructor(where: () => Where, show: (pixels: Uint8ClampedArray) => void) {
    this.#where = where;

    $effect(() => {
      const motion = matchMedia("(prefers-reduced-motion: reduce)");
      const root = document.documentElement;
      const check = () => {
        this.hidden = document.visibilityState === "hidden";
        this.still = motion.matches || root.hasAttribute("data-lite");
      };
      check();
      document.addEventListener("visibilitychange", check);
      motion.addEventListener("change", check);
      const lite = new MutationObserver(check);
      lite.observe(root, { attributes: true, attributeFilter: ["data-lite"] });
      return () => {
        document.removeEventListener("visibilitychange", check);
        motion.removeEventListener("change", check);
        lite.disconnect();
      };
    });

    // 消したら色も捨てる。次にオンにしたときに古い色が出ないように (部品の側も自分の色を捨てる)
    $effect(() => {
      if (this.now === "off") this.lit = false;
    });

    /** 写す。`watch` の間だけ、`EVERY` ごとに */
    $effect(() => {
      if (this.now !== "watch") return;
      const ambient = this.#where().ambient;
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
          const pixels = this.#pixels(bitmap);
          bitmap.close();
          if (pixels !== null) show(pixels);
          this.updates++;
          this.lit = true;
        }
        timer = setTimeout(run, EVERY);
      };
      void run();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    });
  }

  /** 写した1枚の画素 (32x18 の RGBA) */
  #pixels(bitmap: ImageBitmap): Uint8ClampedArray | null {
    if (this.#edge === null) {
      this.#edge = document.createElement("canvas");
      this.#edge.width = GLANCE.width;
      this.#edge.height = GLANCE.height;
    }
    const context = this.#edge.getContext("2d", { willReadFrequently: true });
    if (context === null) return null;
    context.clearRect(0, 0, GLANCE.width, GLANCE.height);
    context.drawImage(bitmap, 0, 0, GLANCE.width, GLANCE.height);
    return context.getImageData(0, 0, GLANCE.width, GLANCE.height).data;
  }
}

interface Parts {
  /** 外の箱。その場で入れ替えるあいだ `data-instant` を付ける (CSS が transition を外す) */
  box: () => HTMLElement | null;
  /** 画面に出す canvas のうち、`side` (0 か 1) の側のもの。どれにも同じ1枚を描く */
  canvases: (side: number) => (HTMLCanvasElement | null | undefined)[];
  /** 描く1枚の大きさ (画素)。まだ決まっていなければ null */
  size: () => { width: number; height: number } | null;
}

/**
 * **色の入れ替え。** 新しい色を裏の1枚に描いてから表と裏を入れ替える。動きは CSS の `opacity` の transition
 * (表の印 `data-front`)。2 枚は重ねずに足す (`mix-blend-mode: plus-lighter`) — 途中も「前 × (1 − t) + 次 × t」になる。
 *
 * 描いた1枚は画面に出さない canvas (`layers`) に持ち、画面の canvas へはそこから写す (同じ1枚を何枚もの帯に出せる)
 */
export class Crossfade {
  #parts: Parts;
  /** いま表の側 (0 か 1) */
  #front = 0;
  /** 表と裏それぞれに描いた1枚 */
  #layers: (HTMLCanvasElement | null)[] = [null, null];
  /** 入れ替えの途中で次の色が来たとき、見えている色を作る下書き (`settle`) */
  #spare: HTMLCanvasElement | null = null;

  constructor(parts: Parts) {
    this.#parts = parts;
  }

  #scratch(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    const size = this.#parts.size();
    canvas.width = size?.width ?? 1;
    canvas.height = size?.height ?? 1;
    return canvas;
  }

  /** 画面の canvas の `side` の側に、その側の1枚を描く。1枚も無ければ空にする */
  #paint(side: number): void {
    const layer = this.#layers[side];
    for (const canvas of this.#parts.canvases(side)) {
      const context = canvas?.getContext("2d");
      if (!canvas || !context) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (layer) context.drawImage(layer, 0, 0);
    }
  }

  /**
   * `side` の側を表にする。`instant` ならその場で入れ替える (transition を外して当て、計算させてから戻す)
   */
  #face(side: number, instant: boolean): void {
    this.#front = side;
    const box = this.#parts.box();
    box?.toggleAttribute("data-instant", instant);
    for (const s of [0, 1])
      for (const canvas of this.#parts.canvases(s))
        canvas?.toggleAttribute("data-front", s === side);
    if (!instant || box === null) return;
    void getComputedStyle(this.#parts.canvases(side)[0] ?? box).opacity;
    box.removeAttribute("data-instant");
  }

  /**
   * **入れ替えの途中で次の色が来たら、いま見えている色を表にしてから次へ進む** (色が跳ねない)。
   * 見えている色は「表 × 表の透明度 + 裏 × (1 − 表の透明度)」。それを裏に描いて、その場で表にする
   */
  #settle(): void {
    // 隠した帯の中では transition が進まないので、出ている1枚で見る
    const shown = this.#parts
      .canvases(this.#front)
      .find((canvas) => canvas && canvas.parentElement?.hidden === false);
    if (!shown) return;
    const mix = Number.parseFloat(getComputedStyle(shown).opacity);
    if (!(mix < 1)) return;
    const back = 1 - this.#front;
    this.#spare ??= this.#scratch();
    const context = this.#spare.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, this.#spare.width, this.#spare.height);
    const old = this.#layers[back];
    const next = this.#layers[this.#front];
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
    [this.#layers[back], this.#spare] = [this.#spare, old ?? null];
    this.#paint(back);
    this.#face(back, true);
  }

  /** 次の色を裏に描いて (`draw`)、表と裏を入れ替える (動きは CSS。動かさない設定ではすぐ) */
  next(draw: (layer: HTMLCanvasElement) => void): void {
    this.#settle();
    const back = 1 - this.#front;
    const layer = (this.#layers[back] ??= this.#scratch());
    draw(layer);
    this.#paint(back);
    this.#face(back, false);
  }

  /** いまの色を描き直して、動かさずに表へ出す (置き場・テーマが変わったとき)。`draw` が無ければ空にする */
  repaint(draw: ((layer: HTMLCanvasElement) => void) | null): void {
    this.#layers = [null, null];
    this.#spare = null;
    if (draw !== null) {
      const layer = this.#scratch();
      draw(layer);
      this.#layers[this.#front] = layer;
    }
    this.#paint(0);
    this.#paint(1);
    this.#face(this.#front, true);
  }
}
