import {
  LOWEST_RUNG,
  type Pace,
  type Rung,
  RUNG_AUDIO_KBPS,
  RUNG_SPECS,
} from "./rungs";

/**
 * **回線に合わせて画質の段を上げ下げするかを決める** (段の表は `rungs.ts`)。
 *
 * 画面が刻むたびに測った値を渡し、動かすときだけ次の段と理由を受け取る。決めるだけで、
 * リクエストし直すのは画面の役目。DOM も時計も触らない (時刻は引数で受け取る) ので、ここだけ単体で確かめられる。
 * 端末のデコードが間に合うかは `raw/budget.ts` が見る。回線とは混ぜない。
 *
 * ## 下げる
 *
 * 次のどれかで「足りない」と見る。
 *
 * - 詰まった (`waiting`)
 * - 先の溜まりが 2 秒を切って、減り続けている
 * - サーバの `backlog` が 3 秒続けて伸びた、または映像の塊を捨てた
 * - 観る画面で、測った速さ × 0.7 がいまの段に足りない状態が 10 秒続いた (先を 60 秒溜めるので、溜まりを使い切る前に下げる)
 *
 * 下げ先は「測った速さ × 0.7 − 音声」に収まるいちばん高い段。速さを測れていなければ 2 段下げる。
 * 段 3 でも 10 秒続けて足りなければ音声だけにする (車で聞くこともあるので、自動の最後の手)。
 *
 * ## 上げる
 *
 * - 観る画面 (速さを測れる): 次の段の 2 倍以上の速さが 20 秒続いたら 1 段上げる
 * - ライブ・MPEG-2 (実時間でしか送られないので余裕を測れない): 足りない兆しが 30 秒無ければ 1 段上げてみる
 *
 * 上げて 1 分以内に足りなくなったら、上げる前の段に戻し、次に上げるまでの待ちを倍にする (上限 5 分)。
 * どの切り替えのあとも 20 秒は動かさない (上げてみて足りなかったときだけは、すぐ戻す)。上限は段 0。
 *
 * ## 段 0 がファイルの直再生・MPEG-2 のとき
 *
 * 段 0 から下げるのは「変換に移る」こと。段 0 へ上げ直すのは、速さが段 0 のビットレート (`baseKbps`) の
 * 2 倍以上で続いたとき。どちらの経路に移すかは画面が決める。
 *
 * ## 下げないとき
 *
 * - サーバのエンコードが実時間に追いつかない (`Pace.speed` が 1 未満) 間は、詰まっても回線のせいにしない。
 *   3 秒続いたら段は下げずに `encode` を返す (サーバ側で軽い組み合わせに替える)
 * - 形式を手で選んでいる間は段を動かさず、足りないときに `pinned` だけを返す
 */

/** 段のほかに、映像を止めて音声だけにする */
export type Step = Rung | "audio";

/**
 * どの経路で受け取っているか。
 *
 * - `watch`: 観る画面の HTTP fMP4。受け取る速さが送る側に縛られないので、余裕を測れる
 * - `live`: WebSocket (ライブ・追っかけ・MPEG-2)。実時間でしか送られないので、速さは余裕を表さない
 */
export type AdaptRoute = "watch" | "live";

/**
 * 画面に返す理由 (断り書きに使う)。
 *
 * - `slow`: 回線が細いので下げた
 * - `restored`: 回線が戻ったので上げた
 * - `encode`: サーバのエンコードが間に合わない。段はそのまま
 * - `pinned`: 回線が細いが、形式を手で選んでいるので段を動かさない
 */
export type AdaptReason = "slow" | "restored" | "encode" | "pinned";

export interface AdaptDecision {
  /** 次の段。`encode` と `pinned` ではいまの段のまま */
  step: Step;
  reason: AdaptReason;
}

/** 刻むたびに画面が渡すもの */
export interface AdaptSample {
  /** いまの時刻 (ms) */
  now: number;
  route: AdaptRoute;
  /** いま流している段。画面が切り替えたら次から新しい段を渡す (変わったことをここで読み取る) */
  current: Step;
  /** 形式を手で選んでいるか */
  manual: boolean;
  /**
   * 測った受け取りの速さ (bit/s)。測れないなら null。観る画面では読んでいる間 (先が埋まる前) の 5 秒の窓で測り、
   * 先が埋まって読んでいない間は最後に測った値を渡す。`live` で渡した値は下げ先を決めるのにだけ使う
   * (足りないときの受け取りの速さは回線の上限に近い)
   */
  throughput: number | null;
  /** 先に溜まっている長さ (秒) */
  ahead: number;
  /** 詰まって止まっているか */
  waiting: boolean;
  /**
   * サーバから届いた最後の `pace`。無い経路は null。**届くたびに新しいオブジェクトを渡す**
   * (同じオブジェクトの `dropped` は 1 回だけ数える)
   */
  pace: Pace | null;
  /** 段 0 の映像と音声を合わせたビットレート (kbit/s)。ファイルや MPEG-2 の実際の値。分からなければ null */
  baseKbps: number | null;
}

/** 選局・シーク・切り替えの直後はこれだけ数えない (ms)。立ち上がりで溜まりが空なのを「足りない」と読まない */
export const GRACE = 3_000;
/** 切り替えのあと、これだけ動かさない (ms)。行き来を止める */
export const HOLD = 20_000;
/** 先の溜まりがこれを切って減り続けたら足りない (秒)。詰まる前に下げる */
export const LOW = 2;
/** 溜まりがこれだけ続けて減ったら「減り続けている」(ms) */
export const FALL = 2_000;
/**
 * 減り続けた間の平均で、`FALL` あたりこれより少なく減ったなら数えない (秒)。ライブが遅れを詰めるために少し速く再生すると
 * 1 秒に 0.05 秒ほど減る。回線が半分しか出ないと 1 秒に 0.5 秒減るので、2 秒で 0.5 秒あれば読み分けられる
 */
export const FALL_LEAST = 0.5;
/** サーバの `backlog` がこれだけ続けて伸びたら足りない (ms)。`pace` は 2 秒ごとなので、2 回続けて伸びたのを見る */
export const BACKLOG_GROW = 3_000;
/** 測った速さのうち、映像と音声に使ってよい割合。残りは揺れとほかの通信のぶん */
export const HEADROOM = 0.7;
/**
 * 上げるのは、次の段の何倍の速さが続いたときか。観る画面は速さ × 0.7 がいまの段に足りないと下げる (いまの段の 1/0.7 ≈ 1.43 倍未満)。
 * 2 倍ならその間が 4 割ほど空き、上げた直後に速さが揺れても上げる前の段へ戻さない
 */
export const UP_MARGIN = 2;
/** 観る画面で上げるまでの待ち (ms) */
export const UP_WAIT_WATCH = 20_000;
/** ライブで上げてみるまでの待ち (ms)。余裕を測れないので、観る画面より長く待つ */
export const UP_WAIT_LIVE = 30_000;
/** 上げるまでの待ちを倍にしていく上限 (ms) */
export const UP_WAIT_MOST = 300_000;
/** 上げてからこれだけの間に足りなくなったら、上げたのが早かったと見る (ms) */
export const PROBE = 60_000;
/** 段 3 でもこれだけ続けて足りなければ音声だけにする (ms) */
export const AUDIO_AFTER = 10_000;
/**
 * 観る画面で、測った速さ × `HEADROOM` がいまの段に足りない状態がこれだけ続いたら下げる (ms)。
 * 速さは 5 秒の窓で測るので、窓 2 つぶん続いたのを見る。先は 60 秒溜まるので、10 秒待っても詰まる前に下げられる
 */
export const THIN = 10_000;
/** エンコードの速さが 1 未満のままこれだけ続いたら `encode` を返す (ms)。`budget.ts` と同じく 1 回の遅れでは動かない */
export const ENCODE_LAG = 3_000;
/**
 * 段 0 のビットレートが分からないときに使う値 (kbit/s)。ふだんのエンコード (1080p60) のハードウェアの固定ビットレート
 * (`hwenc.ts` の `LARGEST`)
 */
export const BASE_GUESS_KBPS = 10_500;

/** 段の並び。数が大きいほど軽い */
function order(step: Step): number {
  return step === "audio" ? LOWEST_RUNG + 1 : step;
}

/** 段の映像と音声を合わせたビットレート (bit/s) */
function stepBps(step: Step, baseKbps: number | null): number {
  if (step === "audio") return RUNG_AUDIO_KBPS * 1000;
  if (step === 0) return (baseKbps ?? BASE_GUESS_KBPS) * 1000;
  return (RUNG_SPECS[step].videoKbps + RUNG_AUDIO_KBPS) * 1000;
}

/** 1 段重い段。段 0 は null */
function upper(step: Step): Step | null {
  if (step === "audio") return LOWEST_RUNG;
  return step === 0 ? null : ((step - 1) as Rung);
}

export class RungAdapter {
  /** 前の刻みで渡された段。最初は null */
  private last: Step | null = null;
  /** これより前 (ms) は数えない */
  private quietUntil = Number.NEGATIVE_INFINITY;
  /** これより前 (ms) は動かさない */
  private holdUntil = Number.NEGATIVE_INFINITY;
  /** 上げてみている間。`from` は上げる前の段 */
  private probe: { from: Step; until: number } | null = null;
  /** 上げてみて足りなかった回数 (待ちを倍にする) */
  private fails = 0;
  private prevAt = Number.NaN;
  private prevAhead: number | null = null;
  private prevBacklog: number | null = null;
  private lastPace: Pace | null = null;
  /** 溜まりが減り始めた時刻と、そのときの溜まり */
  private fall: { at: number; ahead: number } | null = null;
  /** `backlog` が伸び始める前の時刻と、最後に伸びた時刻 */
  private grow: { from: number; lastAt: number } | null = null;
  /** 上げてよい状態が始まった時刻 */
  private upSince: number | null = null;
  /** 段 3 で足りない状態が始まった時刻 */
  private shortSince: number | null = null;
  /** エンコードの速さが 1 を切った時刻 */
  private slowSince: number | null = null;
  /** 観る画面で、測った速さがいまの段に足りなくなった時刻 */
  private thinSince: number | null = null;

  /**
   * 刻むたびに呼ぶ。**段を動かすか、断り書きが要るときだけ返す。** null なら段はそのままで、断り書きも要らない。
   * `encode` と `pinned` は、その状態が続く間は刻むたびに返す
   */
  tick(s: AdaptSample): AdaptDecision | null {
    const { now } = s;
    if (this.last === null) this.reset(now);
    else if (s.current !== this.last) this.switched(now, this.last, s.current);
    this.last = s.current;
    if (this.probe !== null && now >= this.probe.until) {
      // 上げたあと 1 分足りていた。ほかの分岐より先に見て、待ちの倍数をその刻みで戻す
      this.probe = null;
      this.fails = 0;
    }
    if (now < this.quietUntil) {
      this.remember(s);
      return null;
    }

    const speed = s.pace?.speed ?? null;
    if (speed !== null && speed < 1) this.slowSince ??= now;
    else this.slowSince = null;
    if (this.slowSince !== null) {
      // 溜まりが減るのも詰まるのもエンコードが遅いせい。回線のぶんとして数えない
      // この間にサーバが捨てた塊 (`dropped`) も数えない。サーバ側で軽い組み合わせに替えるので、段は下げない
      this.clearStreaks();
      this.remember(s);
      return now - this.slowSince >= ENCODE_LAG
        ? { step: s.current, reason: "encode" }
        : null;
    }

    const short = this.short(s);
    this.remember(s);

    if (s.manual) {
      this.upSince = null;
      this.shortSince = null;
      // 手で選んだ段は上げてみたものではない。手動を外した直後に前の段へ戻さない
      this.probe = null;
      return short ? { step: s.current, reason: "pinned" } : null;
    }

    if (short) {
      this.upSince = null;
      if (this.probe !== null) {
        this.fails++;
        const from = this.probe.from;
        this.probe = null;
        return { step: from, reason: "slow" };
      }
      if (s.current === LOWEST_RUNG) this.shortSince ??= now;
      else this.shortSince = null;
      if (now < this.holdUntil || s.current === "audio") return null;
      if (s.current === LOWEST_RUNG)
        return now - this.shortSince! >= AUDIO_AFTER
          ? { step: "audio", reason: "slow" }
          : null;
      return { step: this.lower(s), reason: "slow" };
    }
    this.shortSince = null;

    const up = upper(s.current);
    if (up === null) return null;
    const ok =
      s.route === "watch" && s.throughput !== null
        ? s.throughput >= UP_MARGIN * stepBps(up, s.baseKbps)
        : (s.pace === null || s.pace.backlog === 0) && !s.waiting;
    if (!ok) {
      this.upSince = null;
      return null;
    }
    this.upSince ??= now;
    if (now < this.holdUntil || now - this.upSince < this.upWait(s.route))
      return null;
    return { step: up, reason: "restored" };
  }

  /** 選局し直したとき・シークしたとき。段・待ちの倍数・上げてみている間は持ち越し、測った値だけ捨てる */
  reset(now: number): void {
    this.quietUntil = now + GRACE;
    this.clearStreaks();
    this.prevAhead = null;
    this.prevBacklog = null;
    this.slowSince = null;
  }

  /**
   * 画面がリクエストした段にサーバが切り替えなかったとき (変換の枠が埋まっていた) に呼ぶ。`current` が変わらないので
   * 切り替えとして数えられない。そのまま次の刻みでリクエストし直さないように、切り替えのあとと同じく 20 秒動かさない。
   * 測った値は持ち越すので、20 秒たっても足りなければもう一度同じ段を返す
   */
  refused(now: number): void {
    this.holdUntil = now + HOLD;
    this.upSince = null;
  }

  /** 上げるまでの待ち (ms) */
  upWait(route: AdaptRoute): number {
    const base = route === "watch" ? UP_WAIT_WATCH : UP_WAIT_LIVE;
    return Math.min(UP_WAIT_MOST, base * 2 ** this.fails);
  }

  /** 画面が段を切り替えた */
  private switched(now: number, from: Step, to: Step): void {
    this.reset(now);
    this.holdUntil = now + HOLD;
    this.probe = order(to) < order(from) ? { from, until: now + PROBE } : null;
  }

  /** 足りない兆しがあるか。続いているかを見るために、刻むたびに呼ぶ */
  private short(s: AdaptSample): boolean {
    const { now } = s;
    if (this.prevAhead !== null) {
      if (s.ahead < this.prevAhead)
        this.fall ??= { at: this.prevAt, ahead: this.prevAhead };
      else if (s.ahead > this.prevAhead) this.fall = null;
    }
    const falling =
      this.fall !== null &&
      s.ahead < LOW &&
      now - this.fall.at >= FALL &&
      (this.fall.ahead - s.ahead) * FALL >= FALL_LEAST * (now - this.fall.at);

    let growing = false;
    let dropped = false;
    const pace = s.pace;
    if (pace !== null) {
      if (this.grow !== null && now - this.grow.lastAt > BACKLOG_GROW)
        this.grow = null;
      if (this.prevBacklog !== null) {
        if (pace.backlog > this.prevBacklog) {
          this.grow ??= { from: this.prevAt, lastAt: now };
          this.grow.lastAt = now;
        } else if (pace.backlog < this.prevBacklog || pace.backlog === 0)
          this.grow = null;
      }
      growing =
        this.grow !== null && this.grow.lastAt - this.grow.from >= BACKLOG_GROW;
      dropped = pace !== this.lastPace && pace.dropped > 0;
    }
    // 先が埋まっている間の速さは高めに出やすい。外れても下げ遅れるほうなので、そのまま比べる
    if (
      s.route === "watch" &&
      s.throughput !== null &&
      s.current !== "audio" &&
      s.throughput * HEADROOM < stepBps(s.current, s.baseKbps)
    )
      this.thinSince ??= now;
    else this.thinSince = null;
    const thin = this.thinSince !== null && now - this.thinSince >= THIN;

    return s.waiting || falling || growing || dropped || thin;
  }

  /** 下げ先。速さが分かれば収まるいちばん高い段、分からなければ 2 段下 (段 0 からは段 1) */
  private lower(s: AdaptSample): Rung {
    const from = s.current as Rung;
    if (s.throughput === null) {
      // 段 0 (MPEG-2 は 16 Mbit/s ほど) から段 1 (3 Mbit/s) で、もう数分の 1 になる
      return from === 0 ? 1 : (Math.min(LOWEST_RUNG, from + 2) as Rung);
    }
    const room = s.throughput * HEADROOM;
    for (let r = from + 1; r <= LOWEST_RUNG; r++)
      if (stepBps(r as Rung, s.baseKbps) <= room) return r as Rung;
    return LOWEST_RUNG;
  }

  private remember(s: AdaptSample): void {
    this.prevAt = s.now;
    this.prevAhead = s.ahead;
    this.prevBacklog = s.pace?.backlog ?? null;
    this.lastPace = s.pace;
  }

  private clearStreaks(): void {
    this.fall = null;
    this.grow = null;
    this.thinSince = null;
    this.upSince = null;
    this.shortSince = null;
  }
}
