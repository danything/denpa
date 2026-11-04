import {
  LOWEST_RUNG,
  type Pace,
  type Rung,
  RUNG_AUDIO_KBPS,
  RUNG_SPECS,
  rungLabel,
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
 * - ライブで、放送に対する遅れ (`lag`) が 4 秒で 0.6 秒以上伸びた。届く速さが流している段の 85% ほどを切ると伸びる。
 *   サーバの `backlog` は、溜まりが中継・カーネル・リバースプロキシに隠れると 0 のままなので、画面が測れるこれも使う
 * - 観る画面で、測った速さ × 0.7 がいまの段に足りない状態が 10 秒続いた (先を 60 秒溜めるので、溜まりを使い切る前に下げる)
 *
 * 下げ先は「測った速さ × 0.7 − 音声」に収まるいちばん高い段。速さを測れていなければ 2 段下げる。
 * 段 3 で、直近 15 秒のうち 3 割以上が足りない状態なら音声だけにする (車で聞くこともあるので、自動の最後の手)。
 * 「途切れずに 10 秒」では数えない。細い回線では止まっては少し動くを繰り返し、動いている刻みで数え直しになるため。
 * 段 3 に移って 10 秒たつまでは決めない。
 *
 * ## 上げる
 *
 * - 観る画面 (速さを測れる): 次の段の 2 倍以上の速さが 20 秒続いたら 1 段上げる
 * - ライブ・MPEG-2: 足りない兆しが 30 秒無く、そのあと画面が測った回線の速さ (`capacity`。流れている段 + 別に取った
 *   試しのデータの速さ) が次の段の 1.2 倍以上なら 1 段上げる。ライブは実時間でしか送られないので、受け取りの速さを見ても
 *   余裕は分からない。時間がたっただけでは上げない (溜まりが外に隠れると、足りない段へ上げて長く止まる)。
 *   測りたいときは `wantProbe` が次の段を返す。測って足りなければ上げずに待ち直す (待ちは倍にしない)
 *
 * 上げて 1 分以内に足りなくなったら、上げる前の段に戻し、次に上げるまでの待ちを倍にする (上限 5 分)。
 * 上げた段が `PROBE_START` たっても映り始めなければ、同じく戻す (`abandon`)。
 * どの切り替えのあとも 20 秒は動かさない (上げてみて足りなかったときだけは、すぐ戻す)。上限は段 0。
 *
 * ## 段 0 がファイルの直再生・MPEG-2 のとき
 *
 * 段 0 から下げるのは「変換に移る」こと。段 0 へ上げ直すのは、速さが段 0 のビットレート (`baseKbps`) の
 * 2 倍以上で続いたとき。どちらの経路に移すかは画面が決める。
 *
 * ## 下げないとき
 *
 * - サーバのエンコードが実時間に追いつかない (`Pace.speed` が 0 より大きく 1 未満。0 は測れていないと読む) 間は、詰まっても回線のせいにしない。
 *   3 秒続いたら段は下げずに `encode` を返す (画面は断り書きを出すだけ。ライブはサーバが自分で軽い組み合わせに作り直す。
 *   `server/live.ts` の `Session.lighten`)
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
  /**
   * ライブで、放送に対する遅れがここ `LAG_SPAN` で伸びた長さ (秒。`live-adapt.ts` の `LagMeter`)。測れなければ null・省略。
   * 届いた映像の端の時刻と実時間の差なので、溜まりが回線のどこに隠れていても、届く速さが足りなければ伸びる
   */
  lag?: number | null;
  /**
   * ライブで、画面が測った回線の速さ (bit/s) と測った時刻 (ms)。流れている段の受け取りの速さに、別に取った試しのデータ
   * (`GET /api/playback/probe`) の速さを足したもの。無ければ null・省略。ライブで上げてよいかを決めるのにだけ使う
   */
  capacity?: { bps: number; at: number } | null;
}

/**
 * 段を動かしたときの断り書き (「回線が細いため、540p に下げました」など) を出しておく長さ (ms)。ライブ・追っかけ・観る画面で同じ。
 * `encode`・`pinned` は、その状態が続く間は刻むたびに出し直す
 */
export const ADAPT_NOTE = 6_000;

/** 選局・シーク・切り替えの直後はこれだけ数えない (ms)。立ち上がりで溜まりが空なのを「足りない」と読まない */
export const GRACE = 3_000;
/** 切り替えのあと、これだけ動かさない (ms)。行き来を止める */
export const HOLD = 20_000;
/** 先の溜まりがこれを切って減り続けたら足りない (秒)。詰まる前に下げる */
const LOW = 2;
/** 溜まりがこれだけ続けて減ったら「減り続けている」(ms) */
const FALL = 2_000;
/**
 * 減り続けた間の平均で、`FALL` あたりこれより少なく減ったなら数えない (秒)。ライブが遅れを詰めるために少し速く再生すると
 * 1 秒に 0.05 秒ほど減る。回線が半分しか出ないと 1 秒に 0.5 秒減るので、2 秒で 0.5 秒あれば読み分けられる
 */
const FALL_LEAST = 0.5;
/** サーバの `backlog` がこれだけ続けて伸びたら足りない (ms)。`pace` は 2 秒ごとなので、2 回続けて伸びたのを見る */
const BACKLOG_GROW = 3_000;
/** 測った速さのうち、映像と音声に使ってよい割合。残りは揺れとほかの通信のぶん */
const HEADROOM = 0.7;
/**
 * 上げるのは、次の段の何倍の速さが続いたときか。観る画面は速さ × 0.7 がいまの段に足りないと下げる (いまの段の 1/0.7 ≈ 1.43 倍未満)。
 * 2 倍ならその間が 4 割ほど空き、上げた直後に速さが揺れても上げる前の段へ戻さない
 */
const UP_MARGIN = 2;
/** 観る画面で上げるまでの待ち (ms) */
export const UP_WAIT_WATCH = 20_000;
/** ライブで上げてみるまでの待ち (ms)。余裕を測れないので、観る画面より長く待つ */
export const UP_WAIT_LIVE = 30_000;
/** 上げるまでの待ちを倍にしていく上限 (ms) */
export const UP_WAIT_MOST = 300_000;
/** 上げてからこれだけの間に足りなくなったら、上げたのが早かったと見る (ms) */
export const PROBE = 60_000;
/** 段 3 に移ってからこれだけたつまでは、音声だけにしない (ms) */
export const AUDIO_AFTER = 10_000;
/**
 * 段 3 で足りない割合を数える窓 (ms)。この中で `AUDIO_SHARE` 以上の時間が足りない状態なら音声だけにする。
 * 細い回線では 1〜2 秒止まって 1 秒ほど動くのを繰り返す (手元で 0.25 Mbit/s に絞って 360p を流したとき)。
 * 途切れずに続くのを待つと、動いている刻みで数え直しになり、いつまでも音声だけにならなかった
 */
export const AUDIO_WINDOW = 15_000;
/** `AUDIO_WINDOW` のうち、これ以上の割合が足りない状態なら音声だけにする。15 秒のうち 4.5 秒止まるのは観ていられない */
export const AUDIO_SHARE = 0.3;
/** 1 回の刻みとして数える長さの上限 (ms)。画面が裏に回って刻みが空いたとき、空いた間をまとめて数えない */
const TICK_MOST = 2_000;
/**
 * 放送に対する遅れの伸びを見る長さ (ms。`live-adapt.ts` の `LagMeter` が測る)。`LAG_GROW` と合わせて、届く速さが
 * 流している段の 85% ほどを切ると足りないと見る (4 秒で 0.6 秒)。キーフレームの塊が遅れて届くぶんの揺れより大きくとる
 */
export const LAG_SPAN = 4_000;
/** `LAG_SPAN` の間に遅れがこれだけ伸びたら足りない (秒) */
export const LAG_GROW = 0.6;
/**
 * ライブで上げるのは、測った回線の速さが次の段の何倍のときか。測るのは短い間なので、揺れのぶん多めに見る。
 * 観る画面の `UP_MARGIN` (2 倍) より小さいのは、こちらは流れている段のぶんも足した回線全体の値で、余りではないため
 */
export const LIVE_UP_MARGIN = 1.2;
/** 測った回線の速さを使ってよい間 (ms)。これより古ければ測り直す */
export const CAPACITY_FRESH = 15_000;
/**
 * 上げた段が、リクエストしてからこれだけたっても映り始めなければ戻す (ms。`abandon`)。上げた先は変換の立ち上がり
 * (1 秒ほど) とキーフレームを待つので、ふつうは 2〜3 秒で映る。足りない段だと最初のキーフレームが届かず、手元では
 * 22 秒映らなかった
 */
export const PROBE_START = 6_000;
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
export function stepOrder(step: Step): number {
  return step === "audio" ? LOWEST_RUNG + 1 : step;
}

/**
 * コーデックのメニューの「自動」の行に添える値 (「H.264 540p」「音声だけ」)。段 0 は形式だけ (「MPEG-2」)。
 * `format` は形式の名前 (分からなければ "" で、高さだけになる)。ライブも観る画面もこれを使う
 */
export function stepLabel(step: Step, format: string): string {
  if (step === "audio") return "音声だけ";
  return [format, rungLabel(step) ?? ""].filter((s) => s !== "").join(" ");
}

/**
 * **断り書きに出す文** (docs/writing.md)。段を動かしたときは動かした先、`encode` と `pinned` は段を動かさない理由と、
 * 何をすればどうなるか。`from` は切り替える前の段。ライブも観る画面もこれを使う
 */
export function adaptNote(decision: AdaptDecision, from: Step): string {
  const { step, reason } = decision;
  if (reason === "encode")
    return "サーバのエンコードが追いつかないため、再生が止まります";
  if (reason === "pinned")
    return "回線が細いため、再生が止まります。コーデックを「自動」にすると、画質を下げて再生を続けます";
  // 下げる先は段 1 から下、上げる先は段 3 から上。段 0 へ下げることと、音声だけへ上げることは無い
  if (step === "audio") return "回線が細いため、音声だけにしました";
  const height = rungLabel(step);
  if (reason === "slow") return `回線が細いため、${height ?? ""} に下げました`;
  if (height === null) return "回線が戻ったため、元の画質に戻しました";
  if (from === "audio") return `回線が戻ったため、${height} の映像に戻しました`;
  return `回線が戻ったため、${height} に上げました`;
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
  /** 段 3 に着いた時刻。段 3 でなければ null */
  private lowSince: number | null = null;
  /** 段 3 での刻みごとの長さ (ms) と、足りなかったか。直近 `AUDIO_WINDOW` ぶん */
  private lowTicks: { at: number; ms: number; short: boolean }[] = [];
  /** エンコードの速さが 1 を切った時刻 */
  private slowSince: number | null = null;
  /** 観る画面で、測った速さがいまの段に足りなくなった時刻 */
  private thinSince: number | null = null;
  /** ライブで、足りていたときに測った段ごとの受け取りの速さ (bit/s)。段 0 へ上げてよいかを見るのに使う */
  private readonly rates = new Map<Step, number>();
  /** ライブで、上げる前に測りたい回線の速さ (bit/s。`wantProbe`)。要らなければ null */
  private wanted: number | null = null;

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
    this.wanted = null;
    if (now < this.quietUntil) {
      this.remember(s);
      return null;
    }

    /*
     * 0 は「測れていない」と読む (エンコードの遅れには数えない)。サーバは出した映像の長さで測るので、映像として読めない
     * トラック (#2152 の hvc1) や映像の無いストリームでは、エンコードが進んでいても 0 になる。0 を遅れと読むと、
     * `encode` を返し続けて段がいつまでも動かず、断り書きも出し直され続けた。本当に遅れていれば 0 より大きい値が届く
     */
    const speed = s.pace?.speed ?? null;
    if (speed !== null && speed > 0 && speed < 1) this.slowSince ??= now;
    else this.slowSince = null;
    if (this.slowSince !== null) {
      // 溜まりが減るのも詰まるのもエンコードが遅いせい。回線のぶんとして数えない
      // この間にサーバが捨てた塊 (`dropped`) も数えない (回線のせいではない)
      this.clearStreaks();
      this.clearLow();
      this.remember(s);
      return now - this.slowSince >= ENCODE_LAG
        ? { step: s.current, reason: "encode" }
        : null;
    }

    const short = this.short(s);
    // この刻みが受け持つ長さ。前の刻みが無い (選局・シークの直後) なら 0
    const tickMs = Number.isNaN(this.prevAt)
      ? 0
      : Math.min(TICK_MOST, Math.max(0, now - this.prevAt));
    this.remember(s);

    if (s.manual) {
      this.upSince = null;
      this.clearLow();
      // 手で選んだ段は上げてみたものではない。手動を外した直後に前の段へ戻さない
      this.probe = null;
      return short ? { step: s.current, reason: "pinned" } : null;
    }

    if (s.current === LOWEST_RUNG) this.markLow(now, tickMs, short);
    else this.clearLow();

    if (short) {
      this.upSince = null;
      if (this.probe !== null) {
        this.fails++;
        const from = this.probe.from;
        this.probe = null;
        return { step: from, reason: "slow" };
      }
      if (now < this.holdUntil || s.current === "audio") return null;
      if (s.current === LOWEST_RUNG)
        return this.lowShare(now) ? { step: "audio", reason: "slow" } : null;
      return { step: this.lower(s), reason: "slow" };
    }
    if (s.route === "live" && s.throughput !== null && s.current !== "audio")
      this.rates.set(s.current, s.throughput);

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
    if (s.route === "live") return this.liveUp(s, up, this.upSince);
    return { step: up, reason: "restored" };
  }

  /**
   * ライブで上げてよいか。足りない兆しが無いだけでは上げず、測った回線の速さ (`capacity`) が次の段の `LIVE_UP_MARGIN` 倍に
   * 届いたときだけ上げる。上げてよい状態が始まってから測ったものが無ければ、測ってもらう (`wantProbe`)。
   * 測って足りなければ、上げずに待ち直す。待ちは倍にしない。倍にしていた頃は、細い間に測るたびに待ちが伸び、
   * 回線が戻ってからも 90 秒以上 360p のままだった (上げてみて足りなかったときと違い、止まってはいない)
   */
  private liveUp(
    s: AdaptSample,
    up: Step,
    since: number,
  ): AdaptDecision | null {
    const need = LIVE_UP_MARGIN * this.liveBps(up, s.baseKbps);
    const cap = s.capacity ?? null;
    if (cap === null || cap.at < since || s.now - cap.at > CAPACITY_FRESH) {
      this.wanted = need;
      return null;
    }
    if (cap.bps >= need) return { step: up, reason: "restored" };
    this.upSince = null;
    return null;
  }

  /** ライブの段の映像と音声を合わせたビットレート (bit/s)。段 0 は足りていたときに測った値 (無ければ `stepBps`) */
  private liveBps(step: Step, baseKbps: number | null): number {
    if (step === 0) return this.rates.get(0) ?? stepBps(0, baseKbps);
    return stepBps(step, baseKbps);
  }

  /**
   * ライブで、上げる前に測りたい回線の速さ (bit/s)。流れている段のぶんも含めた回線全体の値。要らなければ null。
   * 刻みの直後に読む (次の刻みで消える)。画面は試しのデータを取り、流れている段の受け取りの速さと足して `capacity` で渡す
   */
  wantProbe(): number | null {
    return this.wanted;
  }

  /**
   * 上げた段が `PROBE_START` たっても映り始めなかった (画面がリクエストし直した段の `tuned` か最初のコマを待っている)。
   * 刻みは映っている間しか呼ばれないので、画面が待ちを数えて呼ぶ。上げてみて足りなかったときと同じく待ちを倍にする。
   * 画面は上げる前の段をリクエストし直す
   */
  abandon(now: number): void {
    this.fails++;
    this.probe = null;
    this.upSince = null;
    this.holdUntil = now + HOLD;
  }

  /** 選局し直したとき・シークしたとき。段・待ちの倍数・上げてみている間は持ち越し、測った値だけ捨てる */
  reset(now: number): void {
    this.quietUntil = now + GRACE;
    this.clearStreaks();
    this.prevAt = Number.NaN;
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
    this.clearLow();
    this.holdUntil = now + HOLD;
    this.probe =
      stepOrder(to) < stepOrder(from) ? { from, until: now + PROBE } : null;
  }

  /** 段 3 の刻みを 1 つ数える。`AUDIO_WINDOW` より古いものは捨てる */
  private markLow(now: number, ms: number, short: boolean): void {
    this.lowSince ??= now;
    this.lowTicks.push({ at: now, ms, short });
    while (
      this.lowTicks.length > 0 &&
      this.lowTicks[0]!.at <= now - AUDIO_WINDOW
    )
      this.lowTicks.shift();
  }

  /** 段 3 に `AUDIO_AFTER` 以上いて、直近 `AUDIO_WINDOW` のうち `AUDIO_SHARE` 以上が足りなかったか */
  private lowShare(now: number): boolean {
    if (this.lowSince === null || now - this.lowSince < AUDIO_AFTER)
      return false;
    let all = 0;
    let short = 0;
    for (const t of this.lowTicks) {
      all += t.ms;
      if (t.short) short += t.ms;
    }
    return all > 0 && short >= AUDIO_SHARE * all;
  }

  private clearLow(): void {
    this.lowSince = null;
    this.lowTicks = [];
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
    // 放送に対する遅れが伸びている。溜まりが外に隠れていても、届く速さが足りなければこれが伸びる
    const lagging = s.route === "live" && (s.lag ?? 0) >= LAG_GROW;

    return s.waiting || falling || growing || dropped || thin || lagging;
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
  }
}
