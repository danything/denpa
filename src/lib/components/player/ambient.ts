/**
 * アンビエントモードの決め方 (`ambient.svelte.ts`・`AmbientGlow.svelte` のうち、画面に触らない所)。
 *
 * 単体テストで見るために分けてある (`ambient.test.ts`)
 */

/** 端末ごとに覚える鍵 (`keep.ts`)。バックグラウンド再生・速さと同じ置き場 */
export const AMBIENT_KEY = "player-ambient";

/** 覚えていた値。**既定はオン** — 切ったことのある端末だけオフで始まる */
export function storedAmbient(saved: string | null): boolean {
  return saved !== "0";
}

/**
 * 写す大きさ。**32x18 (16:9)。** ぼかして広げるので、これより細かくしても見た目は変わらない。
 * 縮めるのは写す側 (`<video>` はブラウザ、worker は worker の中) で、元の大きさの画素は読まない
 */
export const GLANCE = { width: 32, height: 18 } as const;

/**
 * 写す間隔 (ms)。**1秒に5回。** 1秒に1回写して時間でならし、1.2 秒かけて入れ替えていた頃 (#1000) は、
 * 場面が変わっても色がなかなか付いてこなかった
 */
export const EVERY = 200;

/**
 * **写した2枚の違い。** 色 (RGB) の差の平均 (0〜255)。透明度は見ない
 */
export function frameDelta(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (i % 4 === 3) continue;
    sum += Math.abs(a[i]! - b[i]!);
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * **これより小さい違いは入れ替えない** (`frameDelta`、0〜255)。止まった場面でも、放送の雑音や字幕の縁で
 * 写すたびに少しずつ違い、それを 1 秒に 5 回入れ替えるとちらついて見えた。比べる相手は最後に入れ替えた
 * 1枚なので、ゆっくり変わる色もいずれは追いつく
 */
export const STILL = 2;

/**
 * **縁の色を外へ延ばす元** (`edgeExtend`)。映像が枠の外へ続いているように見せる (Ambilight と同じ考え)。
 *
 * - **辺に沿っては細かく** — 上下の辺は 32 点、左右の辺は 18 点 (写した 32x18 の1マスごと)。映像の色が辺に
 *   沿って変われば、光の色もそのとおりに変わる。少しだけならす (`taps`。左右 2 マスまで)
 * - **辺から内へは厚く平均する** — 枠の外側 15% (`depth`) の帯の平均。外周の1マスだけから取っていた頃は、
 *   そこを小さなものが横切るたびに色が変わってちらついた
 *
 * 4x3 の格子に平均していた頃 (#1064) より、辺の色の細かさが残る。真ん中の動きは光に入らない
 */
const EDGE = { depth: 0.15, taps: [1, 2, 3, 2, 1] } as const;

/**
 * 写した 32x18 (`GLANCE`) から、**縁を延ばした 32x18** を作る。各マスは、近い辺の帯の平均 (`EDGE`) を、
 * 辺までの近さで混ぜたもの (近いほど重い。角では2辺が半分ずつ)。光 (`glowPixels`) はこれの、いちばん近い
 * 縁の所の色を外へ延ばす
 */
export function edgeExtend(
  pixels: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  const width = GLANCE.width;
  const height = GLANCE.height;
  /** 範囲 [x0, x1) x [y0, y1) の平均 (端は重なった割合だけ数える) */
  const band = (x0: number, x1: number, y0: number, y1: number): number[] => {
    const sum = [0, 0, 0, 0];
    let area = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const weight = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
        for (let c = 0; c < 4; c++)
          sum[c]! += pixels[(y * width + x) * 4 + c]! * weight;
        area += weight;
      }
    }
    return sum.map((v) => v / area);
  };
  const smooth = (line: number[][]): number[][] =>
    line.map((_, i) => {
      const sum = [0, 0, 0, 0];
      let total = 0;
      EDGE.taps.forEach((tap, k) => {
        const j = Math.min(
          line.length - 1,
          Math.max(0, i + k - (EDGE.taps.length - 1) / 2),
        );
        for (let c = 0; c < 4; c++) sum[c]! += line[j]![c]! * tap;
        total += tap;
      });
      return sum.map((v) => v / total);
    });
  const rows = height * EDGE.depth;
  const cols = width * EDGE.depth;
  const top = smooth(
    Array.from({ length: width }, (_, x) => band(x, x + 1, 0, rows)),
  );
  const bottom = smooth(
    Array.from({ length: width }, (_, x) =>
      band(x, x + 1, height - rows, height),
    ),
  );
  const left = smooth(
    Array.from({ length: height }, (_, y) => band(0, cols, y, y + 1)),
  );
  const right = smooth(
    Array.from({ length: height }, (_, y) =>
      band(width - cols, width, y, y + 1),
    ),
  );
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 辺までの距離 (マス)。近さの4乗で重みを付ける
      const near = [y + 0.5, height - y - 0.5, x + 0.5, width - x - 0.5].map(
        (d) => 1 / d ** 4,
      );
      const sources = [top[x]!, bottom[x]!, left[y]!, right[y]!];
      const total = near.reduce((a, b) => a + b, 0);
      for (let c = 0; c < 4; c++) {
        out[(y * width + x) * 4 + c] =
          sources.reduce((a, s, i) => a + s[c]! * near[i]!, 0) / total;
      }
    }
  }
  return out;
}

/**
 * 色を時間でならす時定数 (ms)。**250ms — 写す間隔 (200ms) と同じくらい。** 入れ替えの 200ms と合わせても、
 * 新しい色の 9 割まで 0.6 秒ほどで追いつく
 */
const SETTLE = 250;

/** **場面が変わった** と見なす違い (`frameDelta`、0〜255)。これを超えたらならさずに、すぐ新しい色にする */
const CUT = 40;

/**
 * **色を時間でならす。** 前の色 (`prev`) を、写した色 (`next`) へ、経った時間 (`dt` ms) に応じて寄せる
 * (時定数 `SETTLE` の指数移動平均)。場面が変わったら (`CUT`) ならさずに `next` にする — 切り替わりで遅れない
 */
export function follow(
  prev: Float32Array | null,
  next: Uint8ClampedArray,
  dt: number,
): Float32Array {
  if (
    prev === null ||
    prev.length !== next.length ||
    frameDelta(prev, next) >= CUT
  )
    return Float32Array.from(next);
  const weight = 1 - Math.exp(-Math.max(0, dt) / SETTLE);
  const out = new Float32Array(next.length);
  for (let i = 0; i < next.length; i++)
    out[i] = prev[i]! + (next[i]! - prev[i]!) * weight;
  return out;
}

/**
 * **ただし、どこか1画素でもこれ以上変わったら入れ替える** (0〜255)。字幕が出たなど一部だけが大きく変わると、
 * 平均では `STILL` に届かないことがある
 */
const STILL_PEAK = 24;

/** 入れ替えるほど変わったか (`STILL`・`STILL_PEAK`) */
export function changed(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (frameDelta(a, b) >= STILL) return true;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (i % 4 !== 3 && Math.abs(a[i]! - b[i]!) >= STILL_PEAK) return true;
  }
  return false;
}

/** 前の色から次の色へ入れ替える長さ (ms)。写す間隔と同じ */
export const FADE = 200;

/** 入れ替えを何段で描くか。1段 50ms */
export const FADE_STEPS = 4;

/** 入れ替えの進み方。始めと終わりをゆっくりにする (0〜1 → 0〜1) */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export interface Situation {
  /** オンにしているか */
  on: boolean;
  /** 色を敷く場所があるか (横にしたスマホでは映像が画面いっぱいで、周りに地が残らない) */
  room: boolean;
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
 * - `off` … 光を消す (オフにした・光が見えない置き方)
 * - `hold` … 写さない。出している光はそのまま (止めている・裏に回った・全画面・動かさない設定で1枚写したあと)
 * - `watch` … 間隔ごとに写す
 *
 * **止めている間・動かさない設定では、まだ光が無ければ1枚だけ写す** (`lit` が立つと `hold` になる)。
 * 止めた映像から開いた録画にも光は出る
 */
export function plan(now: Situation): "off" | "hold" | "watch" {
  if (!now.on || !now.room) return "off";
  if (now.fullscreen || now.hidden) return "hold";
  if (now.reduced || !now.playing) return now.lit ? "hold" : "watch";
  return "watch";
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 映像の外へ色が届く幅 (px)。
 *
 * - **二段組 (`wide`)** … 枠の幅の 20%。枠の後ろに敷いた色が、周りへ少しだけにじむ
 * - **縦に積むとき** … 枠の幅の 90% (240px から)。映像の下の番組の中身に色を敷き、下へ向かって地に溶かす
 *   (YouTube のスマホのアプリと同じ見え方)
 */
export function reach(width: number, wide: boolean): number {
  return Math.round(wide ? width * 0.2 : Math.max(240, width * 0.9));
}

/**
 * 縁からの距離 `t` (0 = 枠の縁、1 = `reach`) での色の濃さ。**縁で 1、届く幅で 0。** 両端で傾きが 0 なので、
 * 枠の縁にも光の外側にも筋が出ない。濃いのは縁の近くで、半分で 0.35、4分の3で 0.06
 */
export function falloff(t: number): number {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  const s = t * t * (3 - 2 * t);
  return (1 - s) ** 1.5;
}

/**
 * 枠から範囲のいちばん遠い端までの距離 (px)。二段組ではこれを届く幅にして、窓の端へ向かって薄くする
 */
export function farthest(stage: Rect, bounds: Rect): number {
  return Math.max(
    stage.left - bounds.left,
    bounds.right - stage.right,
    stage.top - bounds.top,
    bounds.bottom - stage.bottom,
    0,
  );
}

/**
 * 色を敷く範囲。**映像の枠を `spread` (`reach`) ぶん広げ、`bounds` (はみ出してよい範囲) で切る。**
 * どちらも画面の座標 (`getBoundingClientRect`)。`bounds` は `<main>` の縦の範囲と窓の横幅 —
 * ページの巻き取れる長さを増やさない
 */
export function region(stage: Rect, bounds: Rect, spread: number): Rect {
  const left = Math.max(bounds.left, stage.left - spread);
  const top = Math.max(bounds.top, stage.top - spread);
  const right = Math.min(bounds.right, stage.right + spread);
  const bottom = Math.min(bounds.bottom, stage.bottom + spread);
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
  };
}

/**
 * 範囲を、**枠に重ならない4本の帯** (上・下・左・右) に分ける。幅か高さが無い帯は返さない。
 *
 * 光を枠の後ろに1枚で敷くと、映像が1コマ進むたびに枠の下の光まで合成し直すことになる
 * (GPU の無いヘッドレスの Chromium では、1枚で敷くと光が止まっていても CPU が 1 秒あたり 0.6 秒ほど増えた)。
 * 帯なら映像のコマで描き直される所に光が無い。帯はどれも同じ1枚の光を切り出すので、継ぎ目は出ない
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
 * 光を描く canvas の細かさ。**枠の幅を 96 画素として描き、CSS で引き伸ばす。**
 * 光は canvas の中で作るので、引き伸ばすだけで済む (CSS の `filter: blur` は使わない —
 * GPU の無い端末では、入れ替えのたびに画面の大きさでぼかし直すことになる)
 */
const GLOW_UNITS = 96;

/** 光の canvas の中での置き場 (画素)。`width`・`height` は canvas の大きさ */
export interface GlowLayout {
  width: number;
  height: number;
  /** 枠の位置と大きさ */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 光の届く幅 (`reach`) */
  reach: number;
  /** 色をならす箱ぼかしの半径 (`boxRadius`) */
  radius: number;
}

/** 光の届く範囲 `area` と枠 `stage` (画面の座標) から、canvas の中の置き場を決める */
export function glowLayout(
  area: Rect,
  stage: Rect,
  reachPx: number,
): GlowLayout {
  const stageWidth = Math.max(1, stage.right - stage.left);
  const k = GLOW_UNITS / stageWidth;
  const spread = reachPx * k;
  return {
    width: Math.max(1, Math.ceil((area.right - area.left) * k)),
    height: Math.max(1, Math.ceil((area.bottom - area.top) * k)),
    x: (stage.left - area.left) * k,
    y: (stage.top - area.top) * k,
    w: stageWidth * k,
    h: (stage.bottom - stage.top) * k,
    reach: spread,
    radius: boxRadius(Math.min(spread * 0.3, GLOW_UNITS * 0.08)),
  };
}

/**
 * **光を作る。** 写した1枚 (`frame`、`width`x`height` の RGBA) から、`at` の大きさの RGBA を返す。
 *
 * - 色は**いちばん近い枠の縁の色** — 枠の外の点を枠の中へ寄せた位置の色を取る。上の光は上の縁、
 *   左の光は左の縁の色になり、角は角の色になる
 * - 濃さは**枠からの距離** (角では丸く測る) で `falloff` に沿って薄くする。枠を中心に、どの辺も同じ形で消える
 * - 最後に軽くぼかして、縁に沿った色の移り変わりをならす (`blurPixels`)
 */
export function glowPixels(
  frame: Uint8ClampedArray,
  width: number,
  height: number,
  at: GlowLayout,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(at.width * at.height * 4);
  /*
   * 枠の奥は描かない (枠に隠れる)。ぼかしが届く深さ (3回ぶん) より奥だけを飛ばすので、縁の色は変わらない。
   * 描くのは枠の周りの輪だけになり、手間は枠の面積に比例しない
   */
  const deep = 3 * at.radius + 2;
  for (let py = 0; py < at.height; py++) {
    const cy = py + 0.5;
    const ny = Math.min(at.y + at.h, Math.max(at.y, cy));
    const v = Math.min(
      height - 1,
      Math.max(0, ((ny - at.y) / at.h) * height - 0.5),
    );
    const y0 = Math.floor(v);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = v - y0;
    const insideY = Math.min(cy - at.y, at.y + at.h - cy);
    for (let px = 0; px < at.width; px++) {
      const cx = px + 0.5;
      if (Math.min(insideY, Math.min(cx - at.x, at.x + at.w - cx)) > deep)
        continue;
      const nx = Math.min(at.x + at.w, Math.max(at.x, cx));
      const strength = falloff(Math.hypot(cx - nx, cy - ny) / at.reach);
      if (strength <= 0) continue;
      const u = Math.min(
        width - 1,
        Math.max(0, ((nx - at.x) / at.w) * width - 0.5),
      );
      const x0 = Math.floor(u);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = u - x0;
      const a = (y0 * width + x0) * 4;
      const b = (y0 * width + x1) * 4;
      const c = (y1 * width + x0) * 4;
      const d = (y1 * width + x1) * 4;
      const i = (py * at.width + px) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = frame[a + ch]! + (frame[b + ch]! - frame[a + ch]!) * fx;
        const bottom = frame[c + ch]! + (frame[d + ch]! - frame[c + ch]!) * fx;
        out[i + ch] = top + (bottom - top) * fy;
      }
      out[i + 3] = out[i + 3]! * strength;
    }
  }
  blurPixels(out, at.width, at.height, at.radius);
  return out;
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
export function blurPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const size = width * height;
  const channels = [0, 1, 2, 3].map(() => new Float32Array(size));
  const [r, g, b, a] = channels as [
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
  ];
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

/** テーマごとの色の濃くし方 (`vivid`)。彩度は何倍にするか、明るさは何倍にするか */
const TONE = {
  dark: { saturate: 1.8, gain: 1.25 },
  light: { saturate: 3, gain: 0.95 },
} as const;

/**
 * **色を濃くする。** 写した1枚に、ぼかす前に掛ける (`ImageData` の並び。乗算していない)。
 *
 * - 彩度を上げる — 明るさ (BT.709 の輝度) から各色を `saturate` 倍に離し、明るさを `gain` 倍にする。
 *   ぼかすと色が混ざって鈍るので、先に濃くしておく
 * - **明るいテーマでは、色の薄い所ほど透明にする。** 灰色・黒・白のまま白い地に乗せると、灰色の汚れに
 *   見えた。色の付いた所だけが光になる (帯は `mix-blend-mode: multiply` で地に掛ける。`AmbientGlow.svelte`)
 */
export function vivid(data: Uint8ClampedArray, theme: "dark" | "light"): void {
  const { saturate, gain } = TONE[theme];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = (y + (r - y) * saturate) * gain;
    data[i + 1] = (y + (g - y) * saturate) * gain;
    data[i + 2] = (y + (b - y) * saturate) * gain;
    if (theme === "light") {
      const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      data[i + 3] = data[i + 3]! * Math.min(1, chroma * 2.5);
    }
  }
}

/**
 * 色を敷く地の明るさ (相対輝度) の上限・下限。**上に載る字が 4.5 以上で読めるように決めてある。**
 *
 * 字は色の上に直に載る (縦に積んだときの番組の中身、二段組の見出しと右の列)。
 *
 * - 暗いテーマ: 字は `--dp-muted` (#9aa3b5、輝度 0.36)。(0.36 + 0.05) / 4.5 − 0.05 ≈ 0.041 なので 0.035 まで
 * - 明るいテーマ: 字は `--dp-primary-text` (#02659a、輝度 0.12)。4.5 × (0.12 + 0.05) − 0.05 ≈ 0.72 なので 0.75 から
 */
export const WASH_LUMINANCE = { dark: 0.035, light: 0.75 } as const;

export type Rgb = [number, number, number];

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function gamma(value: number): number {
  const c =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** 相対輝度 (WCAG) */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * **地に敷く色。** 映像の色を濃くし (`vivid`)、明るさだけを `limit` に収める。
 * 暗いテーマは光の強さ (線形) を落とし、明るいテーマは白へ寄せる — どちらも色相は変えない
 */
export function washTone(
  color: Rgb,
  theme: "dark" | "light",
  limit: { dark: number; light: number },
): Rgb {
  const pixel = new Uint8ClampedArray([...color, 255]);
  // 明るいテーマは白へ寄せると色が抜けるので、先に強く濃くしておく (`TONE`)
  vivid(pixel, theme);
  let lin = [linear(pixel[0]!), linear(pixel[1]!), linear(pixel[2]!)];
  const now = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  if (theme === "dark") {
    if (now > limit.dark) lin = lin.map((v) => (v * limit.dark) / now);
  } else if (now < limit.light) {
    const t = (limit.light - now) / (1 - now);
    lin = lin.map((v) => v + (1 - v) * t);
  }
  return [gamma(lin[0]!), gamma(lin[1]!), gamma(lin[2]!)];
}

/**
 * 写した1枚 (RGBA) の色を、地に敷く色に直す (`washTone`)。**明るいテーマでは色の薄い所ほど透明にする** —
 * 灰色・黒・白のまま白い地に敷くと、灰色の汚れに見える
 */
export function toneFrame(
  data: Uint8ClampedArray,
  theme: "dark" | "light",
  limit: { dark: number; light: number },
): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const [tr, tg, tb] = washTone([r, g, b], theme, limit);
    data[i] = tr;
    data[i + 1] = tg;
    data[i + 2] = tb;
    if (theme === "light") {
      const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      data[i + 3] = data[i + 3]! * Math.min(1, chroma * 2.5);
    }
  }
}

/** 明るいテーマで帯を地に掛ける濃さ (`AmbientGlow.svelte` の `.band` の `opacity`。変えるときは両方) */
export const LIGHT_OPACITY = 0.6;

/**
 * **ページの上の端に見える色。** ブラウザの枠の色 (`theme-color`) にして、枠とすぐ下の画素をつなげる。
 *
 * 光の canvas (`glowPixels` が出したもの、幅 `width`) のいちばん上の行を透明度で重みを付けて平均し、地
 * (`background`) にページと同じ描き方で重ねる — 暗いテーマはそのまま重ね、明るいテーマは `multiply` を
 * `LIGHT_OPACITY` の濃さで掛ける。枠の色は1色なので、横は平均する。
 * 縦に積むときは上の端が映像の上の縁になるので、その縁の色を延ばした色になる
 */
export function washTop(
  pixels: ArrayLike<number>,
  width: number,
  background: Rgb,
  theme: "dark" | "light",
): Rgb {
  const sum = [0, 0, 0];
  let cover = 0;
  for (let x = 0; x < width; x++) {
    const alpha = pixels[x * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) sum[c]! += pixels[x * 4 + c]! * alpha;
    cover += alpha;
  }
  const n = Math.max(1, width);
  const a = cover / n;
  return background.map((bg, c) => {
    const p = sum[c]! / n;
    const out =
      theme === "dark"
        ? p + bg * (1 - a)
        : bg * (1 - LIGHT_OPACITY * a) + (LIGHT_OPACITY * bg * p) / 255;
    return Math.round(Math.min(255, Math.max(0, out)));
  }) as Rgb;
}

/**
 * **枠の色を変えるほどの違い** (各色 0〜255 の差のいちばん大きいもの)。これより小さければ変えない —
 * 枠の色を書き換えるとブラウザが枠を描き直すので、見て分からない違いでは触らない
 */
export const TOOLBAR_STEP = 3;

/** 2色の違い (各色の差のいちばん大きいもの) */
export function colorStep(a: Rgb, b: Rgb): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

/** `#rrggbb` を色に。読めなければ null */
export function fromHex(text: string): Rgb | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text.trim());
  return m === null
    ? null
    : [
        Number.parseInt(m[1]!, 16),
        Number.parseInt(m[2]!, 16),
        Number.parseInt(m[3]!, 16),
      ];
}

/** 色を `#rrggbb` に */
export function toHex(color: Rgb): string {
  return `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
