/**
 * **字幕の文字の配置を canvas に描く** ([caption-text.ts](../../caption-text.ts))。ライブ・追っかけ・観る画面で同じもの。
 *
 * サーバが置き場所まで決めて送ってくるので、ここは言われたとおりに塗るだけ。描き方は
 * 絵にしていた頃の libaribcaption (region_renderer / text_renderer_freetype) に揃えてある:
 *
 * - 背景は区画 (`w`x`h`) ごとに塗る。空白も塗る
 * - 字は字の枠の左端をペンの位置にして、**縦は「永」の墨の上下を枠の真ん中に置く**
 *   (あちらが基準線をそう決めている)。横は `scaleX` で縮める
 * - 縁取りは字の外側へ `STROKE_WIDTH`、字より先に塗る
 * - 置き換えられなかった外字は、点の絵を字の枠いっぱいに**なめらかに**引き伸ばす
 *
 * **canvas は画面の画素で敷く。** 絵を伸ばしていた頃と違って、全画面にすれば字もそのぶん
 * 細かく描き直す (`ResizeObserver`)。字形は字幕を焼いていたのと同じ丸ゴシック (`/api/font`)。
 */

import {
    type CaptionDrcs,
    type CaptionPage,
    type CaptionRun,
    FLASH_MS,
    isSpace,
    STROKE_WIDTH,
} from '#lib/caption-text.js';
import { fitRect } from './paint';

/** 字幕を焼いていたのと同じ字。手元ではイメージに無いので、端末の丸ゴシックへ落ちる */
export const CAPTION_FONT = 'denpa-caption';
let fontLoading: Promise<void> | null = null;

/** 字を読み込む。**1回だけ** (`url` は `/api/font`) */
export function loadCaptionFont(url: string): Promise<void> {
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
    return (char.codePointAt(0) ?? 0) > 0x7f && EMOJI.test(char) ? `${char}\uFE0E` : char;
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
    const m = ctx.measureText('永');
    const measured = { ascent: m.actualBoundingBoxAscent / 100, descent: m.actualBoundingBoxDescent / 100 };
    // 字がまだ無いうちは覚えない (端末の字で測ってしまう)
    if (document.fonts.check(`100px ${CAPTION_FONT}`)) ink = measured;
    return measured;
}

/** 外字の絵を、その色の点で描いた canvas にする。**色ごとに覚えておく** */
const drcsCache = new Map<string, HTMLCanvasElement>();

function drcsImage(drcs: CaptionDrcs, color: string): HTMLCanvasElement {
    const key = `${drcs.data}:${drcs.w}:${drcs.h}:${color}`;
    const cached = drcsCache.get(key);
    if (cached !== undefined) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = drcs.w;
    canvas.height = drcs.h;
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
        const bytes = Uint8Array.from(atob(drcs.data), (c) => c.charCodeAt(0));
        const image = ctx.createImageData(drcs.w, drcs.h);
        const [r, g, b, a] = rgba(color);
        for (let i = 0; i < drcs.w * drcs.h; i++) {
            const bit = i * drcs.bits;
            const value = (bytes[bit >> 3]! >> (8 - (bit & 7) - drcs.bits)) & (drcs.depth - 1);
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

const transparent = (color: string) => color.endsWith('00');

/** 点滅しているものがあるか */
export function flashes(page: CaptionPage | null): boolean {
    return page?.runs.some((run) => run.flash === true) ?? false;
}

/**
 * 1枚を描く。canvas の大きさはそのまま使う (面を canvas いっぱいに伸ばす)。
 *
 * @param now 点滅の位相を決める時刻 (ms)
 */
export function drawPage(ctx: CanvasRenderingContext2D, page: CaptionPage, now = 0): void {
    const { width, height } = ctx.canvas;
    const sx = width / page.plane[0];
    const sy = height / page.plane[1];
    const dark = Math.floor(now / FLASH_MS) % 2 === 1;
    const metrics = measureInk(ctx);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
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
    const baseline = (fontPx - (metrics.ascent + metrics.descent) * fontPx) / 2 + metrics.ascent * fontPx;
    ctx.font = `${fontPx}px ${CAPTION_FONT}`;
    chars.forEach((char, i) => {
        const left = (run.x + i * run.w) * sx;
        const top = run.y * sy;
        const right = (run.x + (i + 1) * run.w) * sx;
        const bottom = (run.y + run.h) * sy;
        if (!transparent(run.bg)) {
            ctx.fillStyle = run.bg;
            ctx.fillRect(left, top, right - left, bottom - top);
        }
        if (run.box !== undefined) {
            ctx.fillStyle = run.fg;
            const w = Math.max(1, Math.floor(sx));
            const h = Math.max(1, Math.floor(sy));
            if (run.box & 4) ctx.fillRect(left, top, right - left, h);
            if (run.box & 1) ctx.fillRect(left, bottom - h, right - left, h);
            if (run.box & 8) ctx.fillRect(left, top, w, bottom - top);
            if (run.box & 2) ctx.fillRect(right - w, top, w, bottom - top);
        }
        if (run.flash === true && dark) return;
        const x = left + run.fx * sx;
        const y = top + run.fy * sy;
        if (run.drcs !== undefined) {
            const drcs = page.drcs?.[run.drcs];
            if (drcs === undefined) return;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
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
        // 横は字の枠の幅に合わせて縮める (FreeType に幅と高さを別々に渡していたのと同じ)
        ctx.scale(glyphW / fontPx, 1);
        if (run.stroke !== undefined) {
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
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
 * 1枚の canvas に字幕を出し続ける係。**出すものが変わったら `show` を呼ぶだけ。**
 *
 * - canvas の大きさを画面の画素に合わせ直す (全画面の出入りで描き直す)
 * - 字がまだ届いていなければ、届いてから描き直す
 * - 点滅があれば、その間だけ時計を回す
 *
 * 描いているかの印 (`data-drawn`) もここで立てる/下ろす。
 * 小窓 (`compose.ts`) とスクリーンショットがそれを見る
 */
export class CaptionPainter {
    private page: CaptionPage | null = null;
    private readonly resize: ResizeObserver | null;
    private flashTimer: ReturnType<typeof setInterval> | null = null;
    /** いま canvas に何か描いてあるか。描いていなければ消しに行かない */
    private painted = false;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        /** 字の置き場 (`resolve('api/font')`) */
        font: string,
    ) {
        this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.draw()) : null;
        this.resize?.observe(canvas);
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
        if (this.flashTimer !== null) clearInterval(this.flashTimer);
        this.flashTimer = null;
        this.page = null;
        this.draw();
    }

    private draw(): void {
        const canvas = this.canvas;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        const page = this.page;
        if (page === null || page.runs.length === 0) {
            if (!this.painted) return;
            this.painted = false;
            delete canvas.dataset['drawn'];
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        /*
         * 面の縦横比のまま、見えている枠に収まる大きさ × 画面の画素。canvas は
         * `object-fit: contain` で敷いてあるので、縦横比さえ合っていれば映像の絵にぴったり重なる
         */
        const dpr = window.devicePixelRatio || 1;
        const box = fitRect(canvas.clientWidth, canvas.clientHeight, page.plane[0], page.plane[1]);
        const width = Math.max(1, Math.round(box.width * dpr));
        const height = Math.max(1, Math.round(box.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        ctx.clearRect(0, 0, width, height);
        canvas.dataset['drawn'] = '';
        this.painted = true;
        drawPage(ctx, page, performance.now());
    }
}
