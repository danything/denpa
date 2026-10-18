/**
 * アンビエントモードの決め方 (`ambient.svelte.ts`・`AmbientGlow.svelte` のうち、画面に触らない所)。
 *
 * 単体テストで見るために分けてある (`ambient.test.ts`)
 */

/** 端末ごとに覚える鍵 (`keep.ts`)。バックグラウンド再生・速さと同じ置き場 */
export const AMBIENT_KEY = 'player-ambient';

/** 覚えていた値。**既定はオン** — 切ったことのある端末だけオフで始まる */
export function storedAmbient(saved: string | null): boolean {
    return saved !== '0';
}

/**
 * 写す大きさ。**32x18 (16:9)。** ぼかして広げるので、これより細かくしても見た目は変わらない。
 * 縮めるのは写す側 (`<video>` はブラウザ、worker は worker の中) で、元の大きさの画素は読まない
 */
export const GLANCE = { width: 32, height: 18 } as const;

/** 写す間隔 (ms)。**1秒に5回まで。** 前の1枚から次の1枚へは、この長さで入れ替える */
export const EVERY = 200;

export interface Situation {
    /** オンにしているか */
    on: boolean;
    /** 光が見える置き方か (二段組。狭い画面と横にしたスマホでは映像の周りに地が残らない) */
    wide: boolean;
    /**
     * 暗いテーマか。**明るいテーマでは出さない** — 白い地に映像の暗い色が混ざると、灰色の汚れのように
     * 見えた (YouTube も暗いテーマのときだけ)
     */
    dark: boolean;
    /** 全画面か。映像の周りは見えない */
    fullscreen: boolean;
    /** ページが裏に回っているか */
    hidden: boolean;
    /** 動かさない設定 (`prefers-reduced-motion: reduce`) か */
    reduced: boolean;
    /** 再生しているか */
    playing: boolean;
    /** もう1枚写して光を出しているか */
    lit: boolean;
}

/**
 * いま何をするか。
 *
 * - `off` … 光を消す (オフにした・明るいテーマ・光が見えない置き方)
 * - `hold` … 写さない。出している光はそのまま (止めている・裏に回った・全画面・動かさない設定で1枚写したあと)
 * - `watch` … 間隔ごとに写す
 *
 * **止めている間・動かさない設定では、まだ光が無ければ1枚だけ写す** (`lit` が立つと `hold` になる)。
 * 止めた映像から開いた録画にも光は出る
 */
export function plan(now: Situation): 'off' | 'hold' | 'watch' {
    if (!now.on || !now.wide || !now.dark) return 'off';
    if (now.fullscreen || now.hidden) return 'hold';
    if (now.reduced || !now.playing) return now.lit ? 'hold' : 'watch';
    return 'watch';
}

export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** 光を枠より大きく引き伸ばす割合。ぼかすと縁が薄くなるので、そのぶん外へ出す */
export const SCALE = 1.08;

/** ぼかしの強さ (px)。枠の幅の 4% を 24〜56px に収める */
export function blur(width: number): number {
    return Math.round(Math.min(56, Math.max(24, width * 0.04)));
}

/** 映像の外へ光が届く幅 (px)。引き伸ばしたぶんと、ぼかしが広がるぶん (強さの2倍でほぼ消える) */
export function reach(width: number): number {
    return Math.round((width * (SCALE - 1)) / 2 + blur(width) * 2);
}

/**
 * 光を描く範囲。**映像の枠を `reach` ぶん広げ、`bounds` (はみ出してよい範囲) で切る。**
 * どちらも画面の座標 (`getBoundingClientRect`)。`bounds` は `<main>` の内側で、右に列があれば
 * その左端まで — 列の上に光を出さない・ページを巻き取れる長さを増やさない
 */
export function region(stage: Rect, bounds: Rect): Rect {
    const spread = reach(stage.right - stage.left);
    const left = Math.max(bounds.left, stage.left - spread);
    const top = Math.max(bounds.top, stage.top - spread);
    const right = Math.min(bounds.right, stage.right + spread);
    const bottom = Math.min(bounds.bottom, stage.bottom + spread);
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
}

/**
 * 範囲を、**枠に重ならない4本の帯** (上・下・左・右) に分ける。幅か高さが無い帯は返さない。
 *
 * 光を枠の後ろに1枚で敷くと、映像が1コマ進むたびに枠の下の光まで合成し直すことになる
 * (GPU の無いヘッドレスの Chromium では、1枚で敷くと光が止まっていても CPU が 1 秒あたり 0.6 秒ほど増えた)。
 * 帯なら映像のコマで描き直される所に光が無い
 */
export function strips(area: Rect, stage: Rect): Rect[] {
    const top = Math.min(Math.max(stage.top, area.top), area.bottom);
    const bottom = Math.max(Math.min(stage.bottom, area.bottom), top);
    const left = Math.min(Math.max(stage.left, area.left), area.right);
    const right = Math.max(Math.min(stage.right, area.right), left);
    return [
        { left: area.left, top: area.top, right: area.right, bottom: top },
        { left: area.left, top: bottom, right: area.right, bottom: area.bottom },
        { left: area.left, top, right: left, bottom },
        { left: right, top, right: area.right, bottom },
    ].filter((r) => r.right > r.left && r.bottom > r.top);
}

/**
 * 光を描く canvas の細かさ。**枠の幅を 64 画素として描き、CSS で引き伸ばす。**
 * ぼかしも canvas の中でかけるので、引き伸ばすだけで済む (CSS の `filter: blur` は使わない —
 * GPU の無い端末では、入れ替えのたびに画面の大きさでぼかし直すことになる)
 */
export const GLOW_UNITS = 64;

/** 光の canvas の中での置き場 (画素)。`width`・`height` は canvas の大きさ */
export interface GlowLayout {
    width: number;
    height: number;
    /** コマを描く位置と大きさ (枠を `SCALE` 倍にしたもの) */
    x: number;
    y: number;
    w: number;
    h: number;
    /** 箱ぼかしの半径 (`boxRadius`) */
    radius: number;
}

/** 光の届く範囲 `area` と枠 `stage` (画面の座標) から、canvas の中の置き場を決める */
export function glowLayout(area: Rect, stage: Rect): GlowLayout {
    const stageWidth = Math.max(1, stage.right - stage.left);
    const k = GLOW_UNITS / stageWidth;
    const w = stageWidth * k * SCALE;
    const h = (stage.bottom - stage.top) * k * SCALE;
    const cx = ((stage.left + stage.right) / 2 - area.left) * k;
    const cy = ((stage.top + stage.bottom) / 2 - area.top) * k;
    return {
        width: Math.max(1, Math.ceil((area.right - area.left) * k)),
        height: Math.max(1, Math.ceil((area.bottom - area.top) * k)),
        x: cx - w / 2,
        y: cy - h / 2,
        w,
        h,
        radius: boxRadius(blur(stageWidth) * k),
    };
}

/**
 * 箱ぼかしを3回かけてガウスぼかし (強さ `sigma`) に近づけるときの半径。
 * 幅 `2r+1` の箱1回の分散は `((2r+1)^2 - 1) / 12` で、3回で3倍
 */
export function boxRadius(sigma: number): number {
    return Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
}

/**
 * RGBA (`ImageData` の並び。乗算していない) を箱ぼかしで3回ぼかす。**外は透明として扱う。**
 *
 * 色は透明度を掛けてからぼかし、最後に割り戻す — 掛けずにぼかすと、透明の外 (黒) が色に混ざって
 * 縁が黒ずむ
 */
export function blurPixels(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
    const size = width * height;
    const channels = [0, 1, 2, 3].map(() => new Float32Array(size));
    const [r, g, b, a] = channels as [Float32Array, Float32Array, Float32Array, Float32Array];
    for (let i = 0; i < size; i++) {
        const alpha = data[i * 4 + 3]! / 255;
        r[i] = data[i * 4]! * alpha;
        g[i] = data[i * 4 + 1]! * alpha;
        b[i] = data[i * 4 + 2]! * alpha;
        a[i] = data[i * 4 + 3]!;
    }
    const scratch = new Float32Array(Math.max(width, height));
    for (const channel of channels) {
        for (let pass = 0; pass < 3; pass++) {
            boxLine(channel, width, height, 1, width, radius, scratch);
            boxLine(channel, height, width, width, 1, radius, scratch);
        }
    }
    for (let i = 0; i < size; i++) {
        const alpha = a[i]!;
        const scale = alpha > 0 ? 255 / alpha : 0;
        data[i * 4] = r[i]! * scale;
        data[i * 4 + 1] = g[i]! * scale;
        data[i * 4 + 2] = b[i]! * scale;
        data[i * 4 + 3] = alpha;
    }
}

/**
 * 1方向の箱ぼかし。`length` 個並んだ列 (`step` 飛び) を `lines` 本 (`stride` 飛び)。
 * 窓の外は 0 として足し、いつも `2r+1` で割る (外は透明)
 */
function boxLine(
    values: Float32Array,
    length: number,
    lines: number,
    step: number,
    stride: number,
    radius: number,
    scratch: Float32Array,
): void {
    const span = 2 * radius + 1;
    for (let line = 0; line < lines; line++) {
        const base = line * stride;
        for (let i = 0; i < length; i++) scratch[i] = values[base + i * step]!;
        let sum = 0;
        for (let i = 0; i < Math.min(radius, length); i++) sum += scratch[i]!;
        for (let i = 0; i < length; i++) {
            const enter = i + radius;
            const leave = i - radius - 1;
            if (enter < length) sum += scratch[enter]!;
            if (leave >= 0) sum -= scratch[leave]!;
            values[base + i * step] = sum / span;
        }
    }
}
