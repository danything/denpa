import { describe, expect, test } from "bun:test";

import { boxAverage } from "../../raw/downscale";
import {
  blurPixels,
  boxRadius,
  changed,
  colorStep,
  ease,
  edgeExtend,
  falloff,
  farthest,
  follow,
  frameDelta,
  fromHex,
  GLANCE,
  glowLayout,
  glowPixels,
  LIGHT_OPACITY,
  luminance,
  plan,
  reach,
  region,
  type Situation,
  STILL,
  storedAmbient,
  strips,
  toHex,
  vivid,
  WASH_LUMINANCE,
  washTone,
  washTop,
} from "./ambient";

const base: Situation = {
  on: true,
  room: true,
  fullscreen: false,
  hidden: false,
  reduced: false,
  playing: true,
  lit: true,
};

describe("アンビエントモード", () => {
  test("既定はオン。切ったことのある端末だけオフ", () => {
    expect(storedAmbient(null)).toBe(true);
    expect(storedAmbient("1")).toBe(true);
    expect(storedAmbient("0")).toBe(false);
  });

  test("再生している間は写し続ける", () => {
    expect(plan(base)).toBe("watch");
    expect(plan({ ...base, lit: false })).toBe("watch");
  });

  test("オフにした・色を敷く場所が無いなら消す", () => {
    expect(plan({ ...base, on: false })).toBe("off");
    expect(plan({ ...base, room: false })).toBe("off");
  });

  test("止めている間は写さず、光は残す。まだ光が無ければ1枚だけ写す", () => {
    expect(plan({ ...base, playing: false })).toBe("hold");
    expect(plan({ ...base, playing: false, lit: false })).toBe("watch");
  });

  test("裏に回った・全画面なら写さない", () => {
    expect(plan({ ...base, hidden: true })).toBe("hold");
    expect(plan({ ...base, fullscreen: true })).toBe("hold");
    expect(plan({ ...base, hidden: true, lit: false })).toBe("hold");
  });

  test("動かさない設定では1枚写したら止める", () => {
    expect(plan({ ...base, reduced: true, lit: false })).toBe("watch");
    expect(plan({ ...base, reduced: true })).toBe("hold");
  });

  test("届く幅は、二段組で枠の幅の 20%、縦に積むと 90% (240px から)", () => {
    expect(reach(1000, true)).toBe(200);
    expect(reach(390, false)).toBe(351);
    expect(reach(200, false)).toBe(240);
  });

  test("濃さは縁で 1、届く幅で 0。その間は薄くなる一方", () => {
    expect(falloff(0)).toBe(1);
    expect(falloff(1)).toBe(0);
    expect(falloff(0.5)).toBeCloseTo(0.354, 2);
    let before = 1;
    for (let t = 0.05; t < 1; t += 0.05) {
      expect(falloff(t)).toBeLessThan(before);
      before = falloff(t);
    }
  });

  test("いちばん遠い端までの距離 (二段組の届く幅)", () => {
    const view = { left: 0, top: 0, right: 1920, bottom: 1080 };
    expect(
      farthest({ left: 24, top: 80, right: 1576, bottom: 953 }, view),
    ).toBe(344);
    expect(farthest({ left: 0, top: 0, right: 1920, bottom: 1080 }, view)).toBe(
      0,
    );
  });

  test("帯は枠に重ならず、範囲を埋める", () => {
    const area = { left: 0, top: 50, right: 1000, bottom: 700 };
    const stage = { left: 24, top: 80, right: 900, bottom: 573 };
    expect(strips(area, stage)).toEqual([
      { left: 0, top: 50, right: 1000, bottom: 80 },
      { left: 0, top: 573, right: 1000, bottom: 700 },
      { left: 0, top: 80, right: 24, bottom: 573 },
      { left: 900, top: 80, right: 1000, bottom: 573 },
    ]);
    // 範囲の端が枠の端と同じなら、その帯は無い
    expect(strips({ ...area, left: 24, top: 80 }, stage)).toHaveLength(2);
  });

  test("箱は枠を広げたもので、はみ出してよい範囲で切る", () => {
    const stage = { left: 100, top: 80, right: 900, bottom: 530 };
    // 広げる幅は上下左右とも 64px
    expect(
      region(stage, { left: 0, top: 0, right: 2000, bottom: 2000 }, 64),
    ).toEqual({
      left: 36,
      top: 16,
      right: 964,
      bottom: 594,
    });
    // はみ出してよい範囲で切る
    expect(
      region(stage, { left: 24, top: 56, right: 920, bottom: 700 }, 64),
    ).toEqual({
      left: 36,
      top: 56,
      right: 920,
      bottom: 594,
    });
  });

  test("範囲が枠より狭くても、箱の幅と高さは負にならない", () => {
    const box = region(
      { left: 100, top: 100, right: 500, bottom: 325 },
      { left: 600, top: 0, right: 550, bottom: 50 },
      64,
    );
    expect(box.right).toBeGreaterThanOrEqual(box.left);
    expect(box.bottom).toBeGreaterThanOrEqual(box.top);
  });
});

describe("光の canvas", () => {
  test("枠の幅を 96 画素にして、範囲ぶんの大きさを取る", () => {
    const stage = { left: 100, top: 100, right: 740, bottom: 460 };
    const area = { left: 0, top: 60, right: 900, bottom: 600 };
    const layout = glowLayout(area, stage, 64);
    // 640px の枠が 96 画素 (1画素 6.67px)
    expect(layout.width).toBe(135);
    expect(layout.height).toBe(81);
    expect(layout.x).toBeCloseTo(15);
    expect(layout.y).toBeCloseTo(6);
    expect(layout.w).toBeCloseTo(96);
    expect(layout.h).toBeCloseTo(54);
    // 届く幅 64px は 9.6 画素
    expect(layout.reach).toBeCloseTo(9.6);
    expect(layout.radius).toBe(boxRadius(9.6 * 0.3));
  });

  test("光の色はいちばん近い縁の色で、枠から離れるほど薄く、届く幅の外は透明", () => {
    // 2x2 のコマ: 左上 赤・右上 緑・左下 青・右下 黄
    const frame = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const at = {
      width: 40,
      height: 30,
      x: 10,
      y: 10,
      w: 20,
      h: 10,
      reach: 8,
      radius: 1,
    };
    const out = glowPixels(frame, 2, 2, at);
    const px = (x: number, y: number) => [
      ...out.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4),
    ];
    // 左上の上: 赤
    const [r, g, b, near] = px(11, 8) as [number, number, number, number];
    expect(r).toBeGreaterThan(g + 100);
    expect(r).toBeGreaterThan(b + 100);
    // 右下の右: 黄
    const yellow = px(31, 19);
    expect(yellow[0]).toBeGreaterThan(200);
    expect(yellow[1]).toBeGreaterThan(200);
    expect(yellow[2]).toBeLessThan(60);
    // 離れるほど薄い
    expect(px(11, 5)[3]).toBeLessThan(near);
    // 届く幅の外 (角から 13 画素) は透明
    expect(px(0, 0)[3]).toBe(0);
  });

  test("枠の奥を飛ばしても、縁の外の光は変わらない", () => {
    const frame = new Uint8ClampedArray(2 * 2 * 4).fill(200);
    // 半径 1 なら奥は縁から 5 画素より内側。幅 8 の枠には奥が無く、幅 40 の枠にはある
    const narrow = {
      width: 30,
      height: 60,
      x: 10,
      y: 10,
      w: 8,
      h: 40,
      reach: 6,
      radius: 1,
    };
    const wide = { ...narrow, width: 62, w: 40 };
    const a = glowPixels(frame, 2, 2, narrow);
    const b = glowPixels(frame, 2, 2, wide);
    for (const x of [5, 7, 9]) {
      const at = (30 * 30 + x) * 4;
      const bt = (62 * 30 + x) * 4;
      expect([...b.slice(bt, bt + 4)]).toEqual([...a.slice(at, at + 4)]);
    }
  });

  test("箱の半径は、3回でその強さに近づくもの", () => {
    expect(boxRadius(0.1)).toBe(1);
    expect(boxRadius(2.6)).toBe(2);
    expect(boxRadius(6)).toBe(6);
  });

  test("一色の面は、中ではそのままの色", () => {
    const width = 20;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++)
      data.set([200, 100, 50, 255], i * 4);
    blurPixels(data, width, height, 2);
    const center = (10 * width + 10) * 4;
    expect([...data.slice(center, center + 4)]).toEqual([200, 100, 50, 255]);
  });

  test("透明の外へ広がっても、色は黒ずまない (薄くなるだけ)", () => {
    const width = 21;
    const height = 21;
    const data = new Uint8ClampedArray(width * height * 4);
    // 真ん中の 3x3 だけ赤
    for (let y = 9; y <= 11; y++)
      for (let x = 9; x <= 11; x++)
        data.set([255, 0, 0, 255], (y * width + x) * 4);
    blurPixels(data, width, height, 2);
    const near = (10 * width + 15) * 4;
    expect(data[near + 3]).toBeGreaterThan(0);
    expect(data[near + 3]).toBeLessThan(255);
    expect(data[near]).toBeGreaterThanOrEqual(254);
    expect(data[near + 1]).toBe(0);
    // 遠い角は透明のまま
    expect(data[3]).toBe(0);
  });
});

describe("色を濃くする", () => {
  const pixel = (r: number, g: number, b: number) =>
    new Uint8ClampedArray([r, g, b, 255]);

  test("暗いテーマでは彩度と明るさを上げる。灰色は灰色のまま明るくなるだけ", () => {
    const color = pixel(120, 60, 60);
    vivid(color, "dark");
    expect(color[0]! - color[1]!).toBeGreaterThan(60);
    expect(color[3]).toBe(255);
    const gray = pixel(100, 100, 100);
    vivid(gray, "dark");
    expect([...gray]).toEqual([125, 125, 125, 255]);
  });

  test("明るいテーマでは、色の薄い所ほど透明にする", () => {
    const gray = pixel(90, 90, 90);
    vivid(gray, "light");
    expect(gray[3]).toBe(0);
    const red = pixel(200, 40, 40);
    vivid(red, "light");
    expect(red[3]).toBe(255);
    const pale = pixel(140, 120, 120);
    vivid(pale, "light");
    expect(pale[3]).toBeGreaterThan(0);
    expect(pale[3]).toBeLessThan(255);
  });
});

describe("地に敷く色", () => {
  type Rgb = [number, number, number];
  const hex = (h: string): Rgb =>
    [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
  const contrast = (a: Rgb, b: Rgb) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [
      number,
      number,
    ];
    return (x + 0.05) / (y + 0.05);
  };
  /** sRGB のまま混ぜる (CSS の重ね・入れ替えの途中と同じ) */
  const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
    [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;
  const frames = [
    "#ffffff",
    "#000000",
    "#ff0000",
    "#ffff00",
    "#00ffff",
    "#0000ff",
    "#808080",
    "#36c8c0",
    "#0b3550",
  ].map(hex);
  const text = {
    dark: [hex("#9aa3b5"), hex("#e6e8ec")],
    light: [hex("#555e70"), hex("#02659a")],
  };

  test("番組の中身・見出し・右の列の字は、どんな映像の色の上でも 4.5 以上で読める (混ぜた途中も)", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const a of frames) {
        for (const b of frames) {
          const toneA = washTone(a, theme, WASH_LUMINANCE);
          const toneB = washTone(b, theme, WASH_LUMINANCE);
          for (const color of [toneA, mix(toneA, toneB, 0.5)]) {
            for (const t of text[theme])
              expect(contrast(color, t)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  test("縦に積んだ操作バーは、暗幕 (明るいテーマ 60%・暗いテーマ 30%) の上で白い字が 4.5 以上", () => {
    const white = hex("#ffffff");
    const black = hex("#000000");
    for (const frame of [...frames, hex("#ffffff")]) {
      const light = washTone(frame, "light", WASH_LUMINANCE);
      expect(contrast(mix(light, black, 0.6), white)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrast(mix(hex("#ffffff"), black, 0.6), white),
      ).toBeGreaterThanOrEqual(4.5);
      const dark = washTone(frame, "dark", WASH_LUMINANCE);
      expect(contrast(mix(dark, black, 0.3), white)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  test("色相は残す (赤は赤みのまま、青は青みのまま)", () => {
    const red = washTone(hex("#ff0000"), "light", WASH_LUMINANCE);
    expect(red[0]).toBeGreaterThan(red[1]);
    const blue = washTone(hex("#0000ff"), "dark", WASH_LUMINANCE);
    expect(blue[2]).toBeGreaterThan(blue[0]);
  });
});

describe("入れ替え", () => {
  test("写した2枚の違いは色の差の平均で、透明度は見ない", () => {
    expect(frameDelta([10, 20, 30, 255], [10, 20, 30, 0])).toBe(0);
    expect(frameDelta([10, 20, 30, 255], [13, 17, 30, 255])).toBe(2);
    expect(STILL).toBeGreaterThan(0);
  });

  test("平均の違いが小さくても、一部だけ大きく変わったら入れ替える", () => {
    const before = new Uint8ClampedArray(32 * 18 * 4).fill(80);
    const noise = before.map((v, i) => (i % 4 === 3 ? v : v + (i % 3) - 1));
    expect(changed(before, noise)).toBe(false);
    // 字幕が出て 10 画素だけ 100 明るくなった (平均では 2 に届かない)
    const caption = Uint8ClampedArray.from(before);
    for (let p = 0; p < 10; p++) caption.set([180, 180, 180], p * 4);
    expect(frameDelta(before, caption)).toBeLessThan(STILL);
    expect(changed(before, caption)).toBe(true);
  });

  test("入れ替えは始めと終わりがゆっくり", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });
});

describe("映像の中の動き", () => {
  /** 偽の放送 (`FAKE_MOTION`) と同じ: 止まった地の上を、真ん中と上の端で四角 (4x4 マス) が横切る 32x18 */
  const frame = (n: number, middleOnly = false): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4);
    for (let y = 0; y < GLANCE.height; y++) {
      for (let x = 0; x < GLANCE.width; x++) {
        const middle = middleOnly
          ? y >= 7 && y < 11 && x >= 8 + n && x < 12 + n
          : y >= 8 && y < 12 && x >= 2 * n && x < 2 * n + 4;
        const top = !middleOnly && y < 2 && x >= 28 - 2 * n && x < 32 - 2 * n;
        data.set(
          middle
            ? [240, 60, 200, 255]
            : top
              ? [250, 220, 40, 255]
              : [60, 140, 110, 255],
          (y * GLANCE.width + x) * 4,
        );
      }
    }
    return data;
  };
  const at = {
    width: 140,
    height: 90,
    x: 22,
    y: 18,
    w: 96,
    h: 54,
    reach: 20,
    radius: 3,
  };
  /** 入れ替えるたびに、光の色がどれだけ動いたか (色の差の平均) */
  const variance = (outputs: Uint8ClampedArray[]) => {
    let sum = 0;
    for (let i = 1; i < outputs.length; i++)
      sum += frameDelta(outputs[i - 1]!, outputs[i]!);
    return sum / (outputs.length - 1);
  };

  /** 写した色を作り (`source`)、時間でならして光にしたものを並べる */
  const glow = (
    source: (n: number) => Uint8ClampedArray,
    w: number,
    h: number,
  ) => {
    let state: Float32Array | null = null;
    return Array.from({ length: 14 }, (_, n) => {
      state = follow(state, source(n), 200);
      return glowPixels(Uint8ClampedArray.from(state), w, h, at);
    });
  };

  test("真ん中の動きは、縁を延ばした光には入らない (4x3 の格子に平均していた頃より揺れない)", () => {
    const edges = variance(
      glow((n) => edgeExtend(frame(n, true)), GLANCE.width, GLANCE.height),
    );
    const grid = variance(
      glow(
        (n) => boxAverage(frame(n, true), GLANCE.width, GLANCE.height, 4, 3),
        4,
        3,
      ),
    );
    expect(edges).toBeLessThan(0.01);
    expect(edges).toBeLessThan(grid / 3);
  });

  test("縁を小さなものが横切っても、外周の1マスから取っていた頃の半分より揺れない", () => {
    // 1 マスの点が上の端を横切る
    const dot = (n: number) => {
      const data = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4);
      for (let i = 0; i < GLANCE.width * GLANCE.height; i++)
        data.set([60, 140, 110, 255], i * 4);
      // oxlint-disable-next-line oxc/erasing-op -- 0 行目 (行と列で書いておく)
      data.set([250, 220, 40, 255], (0 * GLANCE.width + 4 + 2 * n) * 4);
      return data;
    };
    const rim = variance(
      Array.from({ length: 14 }, (_, n) =>
        glowPixels(dot(n), GLANCE.width, GLANCE.height, at),
      ),
    );
    const edges = variance(
      glow((n) => edgeExtend(dot(n)), GLANCE.width, GLANCE.height),
    );
    expect(edges).toBeLessThan(rim / 2);
  });

  test("縁の色は辺に沿って細かく残る (左が赤・右が緑なら、上の光も左は赤・右は緑)", () => {
    const data = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4);
    for (let y = 0; y < GLANCE.height; y++) {
      for (let x = 0; x < GLANCE.width; x++)
        data.set(
          x < 16 ? [220, 30, 30, 255] : [30, 200, 60, 255],
          (y * GLANCE.width + x) * 4,
        );
    }
    const extended = edgeExtend(data);
    const topLeft = extended.slice(4 * 4, 4 * 4 + 4);
    const topRight = extended.slice(27 * 4, 27 * 4 + 4);
    expect(topLeft[0]).toBeGreaterThan(200);
    expect(topRight[1]).toBeGreaterThan(180);
    // 上が赤・下が緑なら、左の辺は上寄りが赤・下寄りが緑、下の辺は緑
    for (let y = 0; y < GLANCE.height; y++) {
      for (let x = 0; x < GLANCE.width; x++)
        data.set(
          y < 9 ? [220, 30, 30, 255] : [30, 200, 60, 255],
          (y * GLANCE.width + x) * 4,
        );
    }
    const split = edgeExtend(data);
    const at = (x: number, y: number) =>
      split.slice((y * GLANCE.width + x) * 4, (y * GLANCE.width + x) * 4 + 4);
    expect(at(0, 3)[0]).toBeGreaterThan(200);
    expect(at(0, 15)[1]).toBeGreaterThan(180);
    expect(at(31, 15)[1]).toBeGreaterThan(180);
    expect(at(16, 17)[1]).toBeGreaterThan(180);
  });

  test("入れ替えを見送っても、ならした色は進むので、小さな違いもいずれ入れ替わる", () => {
    const shown = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4).fill(
      100,
    );
    const target = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4).fill(
      103,
    );
    let smoothed: Float32Array | null = Float32Array.from(shown);
    let current = Float32Array.from(shown);
    let swaps = 0;
    for (let i = 0; i < 10; i++) {
      smoothed = follow(smoothed, target, 200);
      if (changed(current, smoothed)) {
        current = Float32Array.from(smoothed);
        swaps++;
      }
    }
    expect(swaps).toBe(1);
    expect(current[0]).toBeGreaterThan(102);
  });

  test("ならすのは小さな違いだけ。場面が変わったら、すぐ新しい色にする", () => {
    const dark = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4).fill(
      20,
    );
    const bright = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4).fill(
      220,
    );
    const state = follow(Float32Array.from(dark), bright, 200);
    expect([...state].every((v) => v === 220)).toBe(true);
    // 小さな違い (10) は、200ms で 55% ほど寄る
    const near = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4).fill(
      30,
    );
    expect(follow(Float32Array.from(dark), near, 200)[0]).toBeCloseTo(
      20 + 10 * (1 - Math.exp(-200 / 250)),
      3,
    );
  });
});

describe("washTop (ページの上の端の色 = ブラウザの枠の色)", () => {
  /** 幅 `width` の1行。色と透明度は全部同じ */
  const row = (width: number, [r, g, b]: [number, number, number], a: number) =>
    Uint8ClampedArray.from(
      { length: width * 4 },
      (_, i) => [r, g, b, a][i % 4]!,
    );
  const dark: [number, number, number] = [11, 12, 15];
  const white: [number, number, number] = [255, 255, 255];

  test("色が無ければ地のまま", () => {
    expect(washTop(row(8, [200, 0, 0], 0), 8, dark, "dark")).toEqual(dark);
    expect(washTop(row(8, [200, 0, 0], 0), 8, white, "light")).toEqual(white);
  });

  test("暗いテーマはそのまま重ねる (濃さ 1 なら色そのもの、半分なら地との間)", () => {
    expect(washTop(row(8, [40, 20, 10], 255), 8, dark, "dark")).toEqual([
      40, 20, 10,
    ]);
    const half = washTop(row(8, [41, 21, 11], 128), 8, dark, "dark");
    expect(half).toEqual([26, 17, 13]);
  });

  test("明るいテーマは multiply を LIGHT_OPACITY の濃さで掛ける", () => {
    const [r, g, b] = washTop(row(4, [255, 0, 128], 255), 4, white, "light");
    expect(r).toBe(255);
    expect(g).toBe(Math.round(255 * (1 - LIGHT_OPACITY)));
    expect(b).toBe(Math.round(255 * (1 - LIGHT_OPACITY) + LIGHT_OPACITY * 128));
  });

  test("横は透明度で重みを付けて平均する", () => {
    // 左半分は赤で濃さ 1、右半分は透明 (緑でも混ざらない)
    const pixels = new Uint8ClampedArray([
      ...[255, 0, 0, 255, 255, 0, 0, 255],
      ...[0, 255, 0, 0, 0, 255, 0, 0],
    ]);
    expect(washTop(pixels, 4, [0, 0, 0], "dark")).toEqual([128, 0, 0]);
  });

  test("16進とのやりとりと、違いの大きさ", () => {
    expect(toHex([11, 12, 255])).toBe("#0b0cff");
    expect(fromHex("#0B0CFF")).toEqual([11, 12, 255]);
    expect(fromHex("#fff")).toBeNull();
    expect(colorStep([10, 10, 10], [12, 7, 10])).toBe(3);
  });
});
