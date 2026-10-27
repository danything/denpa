/**
 * **字幕の文字の配置を canvas に描く** ([caption-text.ts](../../../../packages/arib/src/caption-text.ts))。ライブ・追っかけ・観る画面で同じもの。
 *
 * サーバが置き場所まで決めて送ってくるので、ここは言われたとおりに塗るだけ。描き方は
 * libaribcaption の描き手 (region_renderer / text_renderer_freetype) に揃えてある:
 *
 * - 背景は区画 (`w`x`h`) ごとに塗る。空白も塗る
 * - 字は字の枠の左端をペンの位置にして、**縦は「永」の墨の上下を枠の真ん中に置く**
 *   (あちらが基準線をそう決めている)。横は `scaleX` で縮める
 * - 縁取りは字の外側へ `STROKE_WIDTH`、字より先に塗る
 * - 置き換えられなかった外字は、ドット絵を字の枠いっぱいに**なめらかに**引き伸ばす
 *
 * **canvas は画面の画素で敷く。** 全画面にすれば字もそのぶん細かく描き直す (`ResizeObserver`)。
 * 画素は CSS の大きさ (`clientWidth`。整数に丸めてある) ではなく**実際に見えている大きさ**で数える。
 */

import {
  type CaptionDrcs,
  type CaptionPage,
  type CaptionRun,
  FLASH_MS,
  isSpace,
  STROKE_WIDTH,
} from "@danything/arib/caption-text";

import { fitRect } from "./paint";

/** データ放送と同じ Denpa Font。手元の開発ではイメージに無いので、端末の丸ゴシックへ落ちる */
const CAPTION_FONT = "denpa-caption";
let fontLoading: Promise<void> | null = null;

/** 字を読み込む。**1回だけ** (`url` は `#lib/font.ts` の `denpaFontUrl()`) */
function loadCaptionFont(url: string): Promise<void> {
  if (fontLoading !== null) return fontLoading;
  const face = new FontFace(
    CAPTION_FONT,
    `url('${url}') format('woff2'), local('Hiragino Maru Gothic ProN'), local('Meiryo')`,
  );
  fontLoading = face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
    })
    .catch(() => {
      // 無くても描く (端末の字になるだけ)
    });
  return fontLoading;
}

/** 絵文字の字体を持ちうる字。数字や # も入るので、ASCII は `textStyle` で除く */
const EMOJI = /^\p{Emoji}$/u;

/**
 * **絵文字になりうる字は字で描く** (市販のテレビと同じ白黒)。後ろに VS15 (U+FE0E) を足す。
 *
 * 外字の ⚡ ⛅ 🈚 は、何もしないとブラウザがカラーの絵文字の字体へ回す。画面の文字は
 * CSS (`font-variant-emoji: text`、`app.css`) で言えるが、canvas には効かない。
 * 描くときに足すだけで、文字列そのもの (`CaptionRun.text`) は変えない
 */
export function textStyle(char: string): string {
  return (char.codePointAt(0) ?? 0) > 0x7f && EMOJI.test(char)
    ? `${char}\uFE0E`
    : char;
}

/** 「永」の墨の上下 (字の大きさ 1 あたり)。基準線を決めるのに使う */
interface Ink {
  ascent: number;
  descent: number;
}
let ink: Ink | null = null;

function measureInk(ctx: CanvasRenderingContext2D): Ink {
  if (ink !== null) return ink;
  ctx.font = `100px ${CAPTION_FONT}`;
  const m = ctx.measureText("永");
  const measured = {
    ascent: m.actualBoundingBoxAscent / 100,
    descent: m.actualBoundingBoxDescent / 100,
  };
  // 字がまだ無いうちは覚えない (端末の字で測ってしまう)
  if (document.fonts.check(`100px ${CAPTION_FONT}`)) ink = measured;
  return measured;
}

/** 外字の画像を、その色の点で描いた canvas にする。**色ごとに覚えておく** */
const drcsCache = new Map<string, HTMLCanvasElement>();

function drcsImage(drcs: CaptionDrcs, color: string): HTMLCanvasElement {
  const key = `${drcs.data}:${drcs.w}:${drcs.h}:${color}`;
  const cached = drcsCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = drcs.w;
  canvas.height = drcs.h;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const bytes = Uint8Array.from(atob(drcs.data), (c) => c.charCodeAt(0));
    const image = ctx.createImageData(drcs.w, drcs.h);
    const [r, g, b, a] = rgba(color);
    for (let i = 0; i < drcs.w * drcs.h; i++) {
      const bit = i * drcs.bits;
      const value =
        (bytes[bit >> 3]! >> (8 - (bit & 7) - drcs.bits)) & (drcs.depth - 1);
      if (value === 0) continue;
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
      image.data[i * 4 + 3] = Math.round((a * value) / (drcs.depth - 1));
    }
    ctx.putImageData(image, 0, 0);
  }
  if (drcsCache.size > 256) drcsCache.clear();
  drcsCache.set(key, canvas);
  return canvas;
}

function rgba(color: string): [number, number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

const transparent = (color: string) => color.endsWith("00");

/** 点滅しているものがあるか */
function flashes(page: CaptionPage | null): boolean {
  return page?.runs.some((run) => run.flash === true) ?? false;
}

/**
 * 1枚を描く。canvas の大きさはそのまま使う (面を canvas いっぱいに伸ばす)。
 *
 * @param now 点滅の位相を決める時刻 (ms)
 */
function drawPage(
  ctx: CanvasRenderingContext2D,
  page: CaptionPage,
  now = 0,
): void {
  const { width, height } = ctx.canvas;
  const sx = width / page.plane[0];
  const sy = height / page.plane[1];
  const dark = Math.floor(now / FLASH_MS) % 2 === 1;
  const metrics = measureInk(ctx);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (const run of page.runs) drawRun(ctx, page, run, sx, sy, metrics, dark);
}

function drawRun(
  ctx: CanvasRenderingContext2D,
  page: CaptionPage,
  run: CaptionRun,
  sx: number,
  sy: number,
  metrics: Ink,
  dark: boolean,
): void {
  const chars = [...run.text];
  const fontPx = run.size * sy;
  const glyphW = run.size * run.scaleX * sx;
  const strokePx = STROKE_WIDTH * sx;
  // 「永」の墨を字の枠の高さの真ん中に置いたときの基準線 (枠の上から)
  const baseline =
    (fontPx - (metrics.ascent + metrics.descent) * fontPx) / 2 +
    metrics.ascent * fontPx;
  ctx.font = `${fontPx}px ${CAPTION_FONT}`;
  chars.forEach((char, i) => {
    const left = (run.x + i * run.w) * sx;
    const top = run.y * sy;
    const right = (run.x + (i + 1) * run.w) * sx;
    const bottom = (run.y + run.h) * sy;
    /*
     * **塗る枠だけ画素の境目にそろえる。** 半端な位置のまま塗ると、隣の字との境の1画素が
     * 両方から半分ずつしか塗られず、半透明の背景に縦の筋が出ていた。
     * 隣どうしは同じ値に丸まるので、隙間も重なりもできない。字の位置は丸めない (字間が不揃いになる)
     */
    const [l, t, r, b] = [left, top, right, bottom].map(Math.round) as [
      number,
      number,
      number,
      number,
    ];
    if (!transparent(run.bg)) {
      ctx.fillStyle = run.bg;
      ctx.fillRect(l, t, r - l, b - t);
    }
    if (run.box !== undefined) {
      ctx.fillStyle = run.fg;
      const w = Math.max(1, Math.floor(sx));
      const h = Math.max(1, Math.floor(sy));
      if (run.box & 4) ctx.fillRect(l, t, r - l, h);
      if (run.box & 1) ctx.fillRect(l, b - h, r - l, h);
      if (run.box & 8) ctx.fillRect(l, t, w, b - t);
      if (run.box & 2) ctx.fillRect(r - w, t, w, b - t);
    }
    if (run.flash === true && dark) return;
    const x = left + run.fx * sx;
    const y = top + run.fy * sy;
    if (run.drcs !== undefined) {
      const drcs = page.drcs?.[run.drcs];
      if (drcs === undefined) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const h = fontPx;
      if (run.stroke !== undefined) {
        const edge = drcsImage(drcs, run.stroke);
        for (const [dx, dy] of [
          [-strokePx, 0],
          [strokePx, 0],
          [0, -strokePx],
          [0, strokePx],
        ] as const) {
          ctx.drawImage(edge, x + dx, y + dy, glyphW, h);
        }
      }
      ctx.drawImage(drcsImage(drcs, run.fg), x, y, glyphW, h);
      return;
    }
    if (isSpace(char.codePointAt(0) ?? 0)) return;
    if (run.underline === true) {
      ctx.fillStyle = run.fg;
      const thick = Math.max(1, fontPx * 0.05);
      ctx.fillRect(left, y + baseline + fontPx * 0.135, right - left, thick);
    }
    ctx.save();
    ctx.translate(x, y + baseline);
    // 横は字の枠の幅に合わせて縮める (libaribcaption が FreeType に幅と高さを別々に渡すのと同じ)
    ctx.scale(glyphW / fontPx, 1);
    if (run.stroke !== undefined) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // 縦の太さを合わせる (横に縮めた字では横が少し細くなる)
      ctx.lineWidth = strokePx * 2;
      ctx.strokeStyle = run.stroke;
      ctx.strokeText(textStyle(char), 0, 0);
    }
    ctx.fillStyle = run.fg;
    ctx.fillText(textStyle(char), 0, 0);
    ctx.restore();
  });
}

/**
 * 字の載っている縦の範囲 `[上, 下]` (面の高さに対する割合 0〜1)。背景の区画まで含める。
 * 操作列と重なるかを舞台が見るのに使う (`PlayerStage` の持ち上げ)。字が無ければ `[0, 0]`
 */
export function inkSpan(page: CaptionPage): [number, number] {
  const height = page.plane[1];
  if (page.runs.length === 0 || height <= 0) return [0, 0];
  let top = Number.POSITIVE_INFINITY;
  let bottom = 0;
  for (const run of page.runs) {
    top = Math.min(top, run.y);
    bottom = Math.max(bottom, run.y + run.h);
  }
  return [Math.max(0, top / height), Math.min(1, bottom / height)];
}

/**
 * 1枚の canvas に字幕を出し続ける係。**出すものが変わったら `show` を呼ぶだけ。**
 *
 * - canvas の大きさを画面の画素に合わせ直す (全画面の出入りで描き直す)
 * - 字がまだ届いていなければ、届いてから描き直す
 * - 点滅があれば、その間だけ時計を回す
 *
 * 描いているかの印 (`data-drawn`) もここで立てる/下ろす。
 * 小窓 (`compose.ts`) と E2E がそれを見る
 */
export class CaptionPainter {
  private page: CaptionPage | null = null;
  private readonly resize: ResizeObserver | null;
  private readonly rescale = () => this.draw();
  private flashTimer: ReturnType<typeof setInterval> | null = null;
  /** いま canvas に何か描いてあるか。描いていなければ消しに行かない */
  private painted = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** 字の置き場 (`denpaFontUrl()`。バージョン付き) */
    font: string,
  ) {
    this.resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(this.rescale)
        : null;
    this.resize?.observe(canvas);
    // ブラウザのズーム (`devicePixelRatio` が変わる)
    window.addEventListener("resize", this.rescale);
    void loadCaptionFont(font).then(() => {
      ink = null;
      this.draw();
    });
  }

  /** 出すものを替える。null なら消す */
  show(page: CaptionPage | null): void {
    if (page === this.page) return;
    this.page = page;
    if (flashes(page)) {
      this.flashTimer ??= setInterval(() => this.draw(), FLASH_MS);
    } else if (this.flashTimer !== null) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    this.draw();
  }

  /** 畳む。canvas は消して返す */
  close(): void {
    this.resize?.disconnect();
    window.removeEventListener("resize", this.rescale);
    if (this.flashTimer !== null) clearInterval(this.flashTimer);
    this.flashTimer = null;
    this.page = null;
    this.draw();
  }

  private draw(): void {
    const canvas = this.canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const page = this.page;
    if (page === null || page.runs.length === 0) {
      if (!this.painted) return;
      this.painted = false;
      delete canvas.dataset["drawn"];
      delete canvas.dataset["ink"];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    /*
     * **描く画素は、見えている大きさ × 画面の画素。** 面の縦横比のまま CSS の枠に収めた
     * 箱 (`box`) を、実際に見えている倍率 (`kx`/`ky`) で数える。
     *
     * CSS の大きさ (`clientWidth`) は整数に丸めてあるので、それで数えると端数のぶん画像が
     * 引き伸ばされて滲む (スマホの縦・データ放送の小窓の中の `%` の大きさで出る)。
     * `translate` (操作バーの上への持ち上げ) は大きさを変えないので、倍率には入らない。
     * 祖先に掛かるのは `scale` と `translate` だけの前提 (`rotate` だと外接矩形になり合わない)
     */
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const shown = canvas.getBoundingClientRect();
    const kx = cssWidth > 0 ? shown.width / cssWidth : 1;
    const ky = cssHeight > 0 ? shown.height / cssHeight : 1;
    const box = fitRect(cssWidth, cssHeight, page.plane[0], page.plane[1]);
    /*
     * 箱が枠いっぱい (観る画面は `place` が枠を映像に合わせる。小窓の中も面と同じ 16:9)
     * なら、見えている大きさそのもので描いて `fill` で敷く — 面を縦と横で別々に伸ばして
     * いても1画素ずつ合う。枠が余る (枠と面の縦横比が違う) ときは `contain` で真ん中に置く
     */
    const fills = box.width >= cssWidth - 1 && box.height >= cssHeight - 1;
    const fit = fills ? "fill" : "contain";
    if (canvas.style.objectFit !== fit) canvas.style.objectFit = fit;
    const width = Math.max(
      1,
      Math.round((fills ? shown.width : box.width * kx) * dpr),
    );
    const height = Math.max(
      1,
      Math.round((fills ? shown.height : box.height * ky) * dpr),
    );
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    canvas.dataset["drawn"] = "";
    // 字の載っている縦の範囲 (canvas の高さに対する割合)。操作列と重なるときに舞台が字幕を持ち上げる (`PlayerStage`)
    const [top, bottom] = inkSpan(page);
    const tall = cssHeight || 1;
    canvas.dataset["ink"] =
      `${((box.top + top * box.height) / tall).toFixed(4)},${((box.top + bottom * box.height) / tall).toFixed(4)}`;
    this.painted = true;
    drawPage(ctx, page, performance.now());
  }
}
