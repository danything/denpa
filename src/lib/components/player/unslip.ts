/**
 * **映像だけ遅れたら、その場へ飛び直す。** ライブ (`live-player.svelte.ts`) と観る画面で同じ決まり。
 *
 * デコードが間に合わないと映像だけ取り残され、Chrome は遅れたまま出し続けて戻らない (実機の Android)。
 * 音と字幕は再生位置に乗るので、口の動きだけずれる。飛び直すとデコーダは積み残しを捨てて出し直す。
 * 遅れは映した 1 枚の時刻 (`requestVideoFrameCallback` の `mediaTime`) と再生位置の差で測る
 * ([frames.ts](frames.ts))。
 */

/**
 * 映像だけがこれだけ遅れたら飛び直す (秒)。声と口のずれが分かりはじめるのが 0.1 秒あたり。
 * 実機で無事なときの遅れは最大 0.058 秒だったので、飛んでばかりにはならない (0.15 では分かるのに直らなかった)
 */
export const SLIP_MOST = 0.1;

/** 飛び直す間隔の下限 (ms)。**デコードが追いつかない状態は飛んでも直らない** */
export const UNSLIP_EVERY = 3_000;
/*
 * コマ落ちでは飛び直さない。実機の Windows Edge は落ち着いたあとでも絶えず 5.6% 落ちていて、合図にすると
 * 3 秒ごとに飛び続けた (飛ぶたびに音が 0.02 秒飛ぶ)。飛んでもコマ落ちは減らなかった
 */

/** 飛び直す幅 (秒)。**同じ値を入れ直すのは飛んだことにならない**ので、1 コマぶんだけ前へ */
export const UNSLIP_STEP = 0.02;

/** 映した 1 枚が再生位置からどれだけ遅れているか (秒。進んでいれば 0) */
export function slipOf(currentTime: number, mediaTime: number): number {
  return Math.max(currentTime - mediaTime, 0);
}

/**
 * 飛び直しの係 (ライブと観る画面で 1 つずつ)。映した 1 枚ごとに `check` を呼ぶ (測るだけなら `measure`、測った遅れで
 * 飛ぶなら `fix`)。遅れが測れなくても飛び直すときは `jump`。どれも飛び直したら true。止めている間・飛んでいる最中は
 * 飛ばない。連発はさせない (`UNSLIP_EVERY`)
 *
 * **飛んだ直後の 1 コマは測らない。** 飛んだあと最初に届くコマは、飛ぶ前のコマの時刻を持っていることがある。
 * 再生位置だけ先へ進んでいるので、遅れが飛んだ幅ぶん (8〜10 秒) に見え、「映像の遅れ 最大」が 8016ms になった
 * (Android のエミュレータ)。自分で飛んだとき (`jump`) と、`seeking` を知らされたとき (`seeked`) に立てる
 */
export function unslipper(now: () => number = Date.now) {
  let after = 0;
  /** 次の 1 コマは飛ぶ前の時刻かもしれない */
  let stale = false;
  function jump(video: HTMLVideoElement): boolean {
    const at = now();
    if (at < after || video.paused || video.seeking) return false;
    after = at + UNSLIP_EVERY;
    video.currentTime += UNSLIP_STEP;
    stale = true;
    return true;
  }
  /** 映した 1 枚の遅れ (秒)。飛んでいる最中と、飛んだ直後の 1 コマは null */
  function measure(video: HTMLVideoElement, mediaTime: number): number | null {
    if (video.seeking) {
      stale = true;
      return null;
    }
    if (stale) {
      stale = false;
      return null;
    }
    return slipOf(video.currentTime, mediaTime);
  }
  /** 測った遅れが `SLIP_MOST` を超えていたら飛ぶ */
  function fix(video: HTMLVideoElement, slip: number): boolean {
    if (slip <= SLIP_MOST) return false;
    return jump(video);
  }
  return {
    check(video: HTMLVideoElement, mediaTime: number): boolean {
      const slip = measure(video, mediaTime);
      return slip !== null && fix(video, slip);
    },
    measure,
    fix,
    jump,
    /** 再生位置が飛んだ (`seeking`)。次の 1 コマは測らない */
    seeked(): void {
      stale = true;
    },
  };
}

/**
 * **映像の遅れが JS から見えない端末か。** Windows のブラウザは映像を DOM と別の面に出すので、`mediaTime` は
 * 再生位置どおりのまま、画面の映像だけ遅れる (`slip` が 0 のままずれる)。こういう端末だけ、詰まったら測らずに飛び直す
 * (ライブの `settle`)。**測れる端末で詰まるたびに飛ぶと、遅れていなくても音が 0.02 秒ずつ飛ぶ** (回線を絞った
 * 手元の再現で、遅れは最大 0.022 秒なのに 20 秒で 5 回飛んだ)。測れる端末の遅れは、映した 1 枚ごとの `check` が直す
 */
export function slipHidden(
  nav:
    | { userAgent: string; userAgentData?: { platform?: string } }
    | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  if (nav === undefined) return false;
  const platform = nav.userAgentData?.platform;
  if (platform !== undefined && platform !== "") return platform === "Windows";
  return /Windows/.test(nav.userAgent);
}

/** 測った遅れで飛び直したのがこの回数… */
export const BEHIND_JUMPS = 3;
/** …この長さ (ms) の中に続いたら、デコードが追いついていない */
export const BEHIND_SPAN = 15_000;
/**
 * 捨てたコマがこの割合を超えたら、デコードが追いついていない。Windows Edge は落ち着いていても 5.6% 捨て続けるので、
 * その 3 倍より上にする。エミュレータで AV1 1080p が追いつかなかったときは約 50% だった
 */
export const BEHIND_DROPS = 0.2;
/** 捨てたコマの割合を見る長さ (ms)。これより短い間と、`BEHIND_FRAMES` に満たない間は数えない */
export const DROP_SPAN = 10_000;
const BEHIND_FRAMES = 150;
/** 遅れたか飛んだあと、これだけ (ms) は再生を速めない */
export const SLIPPING_SPAN = 5_000;

/**
 * **デコードが追いついていないか** (ライブの `<video>`)。飛び直しても遅れが戻るなら、その端末にはその段が重い。
 * エミュレータで AV1 1080p を観たとき、3 秒ごとに 82 回飛び直しても遅れはすぐ戻り、コマも半分捨てていた。
 * 「自動」の画質ならこれを合図に段を下げる (`RungAdapter` の `behind`)。
 * **遅れているあいだは再生を速めない** (`slipping`)。遅れを詰めようと 1.05 倍で回すと、デコードがさらに重くなる。
 * 数えるのは測った遅れで飛んだときだけ (`jumped`)。測れない端末が詰まったときに飛ぶぶん (`slipHidden`) は数えない
 */
export class DecodeLag {
  private jumps: number[] = [];
  private lateAt = Number.NEGATIVE_INFINITY;
  private from: { at: number; total: number; dropped: number } | null = null;
  private share = 0;

  /** 測った遅れが `SLIP_MOST` を超えた (飛んだかどうかによらない) */
  late(now: number): void {
    this.lateAt = now;
  }

  /** 測った遅れで飛び直した */
  jumped(now: number): void {
    this.late(now);
    this.jumps.push(now);
    while (this.jumps.length > 0 && this.jumps[0]! <= now - BEHIND_SPAN)
      this.jumps.shift();
  }

  /** 出したコマと捨てたコマの数 (通し。`getVideoPlaybackQuality`) */
  frames(now: number, total: number, dropped: number): void {
    if (this.from === null || total < this.from.total) {
      this.from = { at: now, total, dropped };
      return;
    }
    if (now - this.from.at < DROP_SPAN) return;
    const shown = total - this.from.total;
    this.share =
      shown >= BEHIND_FRAMES ? (dropped - this.from.dropped) / shown : 0;
    this.from = { at: now, total, dropped };
  }

  /** デコードが追いついていない (段を下げる合図) */
  behind(now: number): boolean {
    const recent = this.jumps.filter((at) => at > now - BEHIND_SPAN).length;
    return recent >= BEHIND_JUMPS || this.share > BEHIND_DROPS;
  }

  /** 遅れている最中 (再生を速めない) */
  slipping(now: number): boolean {
    return now - this.lateAt < SLIPPING_SPAN;
  }

  /** MediaSource を作り直した・段を替えた。前の段のぶんは持ち越さない */
  reset(): void {
    this.jumps = [];
    this.lateAt = Number.NEGATIVE_INFINITY;
    this.from = null;
    this.share = 0;
  }
}
