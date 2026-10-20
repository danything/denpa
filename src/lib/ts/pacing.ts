/**
 * ライブの再生位置の決め方。**放送は待ってくれないが、目は待てる。**
 *
 * 届いた端でそのまま再生すると、1コマ遅れるたびに映像が止まる。ネットワークも
 * エンコードも一定では届かないので、これは常時起きる。少しだけ貯めてから出し、
 * 離れたら少し速く再生して詰める。飛ぶのは大きく離れたときだけ — 飛ぶと
 * 音が切れるので、常用すると「かくつき」そのものになる。
 *
 * **どれだけ貯めるかは動かす。** 宅内なら 0.2 秒 (`FLOOR`) で足りるが、宅外から
 * 見ると届き方が荒れて止まる。止まったら伸ばし、しばらく無事なら縮める
 * (`nextTarget`)。初めに大きく取ると、開いてから映像が出るまでが遅くなる。
 *
 * **届く間隔も見る** (`cover`)。止まるのを待たずに、ここ数分でいちばん長く空いた
 * 間隔を覆えるだけ貯める。止まってから学ぶだけだった頃は、たまに 0.7 秒空く経路で
 * 2分半に8回止まっていた (#1210)。
 *
 * DOM を触らないので、ここだけ単体で確かめられる。
 */

/**
 * 貯める量の下限。**開いた直後はここから始める。**
 *
 * **そのぶん映像が出るのが遅くなる。** 再生を始める条件は「貯まった尺 ≧ これ」
 * (`pacing` の `play`) で、電波は実時間で届くのだから、0.2 秒貯めるには
 * 0.2 秒かかる。**開いてから映像が出るまでの内訳で、いちばん大きい削り代**
 * ([stream.md](../../../docs/stream.md#開いてから映像が出るまでの内訳)) — 電波のロックも ffmpeg の
 * 立ち上がりもこちらの都合では動かないが、ここは動かせる。
 *
 * **0.2 秒 = 塊4つぶん。** サーバは 0.05 秒ずつ塊を出すので
 * (`server/live.ts` の `-frag_duration`)、4つ貯めてから始めることになる。
 *
 * **小さすぎても壊れない。** 足りずに止まったら 0.6 ずつ増える (`nextTarget`)
 * ので、宅外のように荒れる経路では自分で伸びていく。**ここまで戻ってくるのは
 * 一度も止まらなかったときだけ** — 止まった高さは覚えていて、そこより下へは
 * 戻さない (`PROBE`。`FORGET` 秒無事なら少しずつ下げ直す)。迷ったら小さいほうから始める
 */
export const FLOOR = 0.2;
/** 貯める量の上限。これ以上は、遅れが目に見えて増えるだけ */
export const CEILING = 6;
/** 止まったときに増やす量 */
const GROW = 0.6;
/**
 * 無事だったときに減らす割合。**大きく膨らんだぶんほど速く戻す。**
 *
 * 0.15 秒ずつの決め打ちにしていた頃は、**一度増えた遅れが減っていかない**
 * ように見えた (実機)。1.4 秒まで伸びると 0.2 へ戻るのに 8回 = 40秒かかり、
 * その間にもう一度止まれば振り出しに戻る — 止まりがちな経路では、
 * 事実上ずっと増えっぱなしになる。
 *
 * 割合で減らすと、膨らんだ直後がいちばん大きく戻る (1.4 なら 1回目で 0.28)。
 * 小さいところでは下の `SHRINK_LEAST` が効いて、じわりと詰める
 */
const SHRINK_RATIO = 0.2;
/** 1回で減らす量の下限 (秒)。割合だけだと、小さいところで止まってしまう */
const SHRINK_LEAST = 0.1;
/**
 * これだけ無事なら縮めにかかる (秒)。
 *
 * **戻りが遅すぎると「直っていない」に見える。** 45秒にしていた頃は元に
 * 戻るのに3分かかっていた。30秒でもまだ長い — 止まる間隔のほうが短いと、
 * 縮めにかかる前に次の1回が来て伸びる
 */
export const SETTLED = 15;
/**
 * 下限を持ち上げる幅 (秒)。**止まった高さのすぐ上を、次の下限にする** (理由は `nextTarget`)。
 * 届く間隔で説明がつく詰まりは下限を動かさず、貯める量をその間隔を覆う高さへ一度に上げる (`cover`)
 */
const PROBE = 0.3;
/**
 * 下限そのものを下げ直すまでの静けさ (秒)。**覚えたままにしない。**
 *
 * 経路は変わる (宅外から宅内へ帰る・混んでいた時間帯が過ぎる)。これだけ無事なら
 * `PROBE` ぶんだけ下げて試し直し、駄目ならまた上がる。
 *
 * **止まる間隔よりずっと長く採る。** 2分にしていた頃は、**止まる間隔とほぼ
 * 同じ**だった (実測で約2分おき) ため、せっかく上げた下限が次の1回の直前に
 * 下がり、覚えていないのと変わらなかった — 8分で3回。
 *
 * 下限は端末に覚えている (live-player の `FLOOR_KEY`) ので、自分で下がらないと
 * 戻らない。今すぐ捨てたいときは `relearn`
 */
const FORGET = 600;

/** これ以上離れたら飛ぶ。別のタブへ行って戻ってきたとき */
export const JUMP = 8;
/** 詰めるときの速さ。上げすぎると音程が分かるほど狂う */
export const CATCH_UP = 1.05;
/**
 * 貯まりが狙いを割ったときの速さ。**止まる前に少しだけ遅くして貯め直す。**
 *
 * dash.js・hls.js・YouTube・Twitch のライブと同じ手当て。3% ならブラウザが音程を
 * 保つので (既定の `preservesPitch`)、聞いても分からない。止まるよりずっと目立たない
 */
export const SLOW_DOWN = 0.97;

/**
 * 届く間隔を覚えておく長さ (秒)。**たまにしか来ない長い空きも覚えておく。**
 *
 * 15〜30秒おきに 0.7 秒空く経路 (#1210) なら、この中に必ず何回か入る。
 * 短くすると空きと空きの間で忘れて、また止まる
 */
export const GAP_WINDOW = 180;
/**
 * 間隔として数える上限 (秒)。**これより長いのは揺れではなく途絶え。**
 *
 * サーバの入れ替えや電波の途切れで数秒空いたのを覆おうとすると、そのたびに
 * 遅延が何秒も伸びる。覆いきれないものは止まるしかない
 */
export const GAP_MOST = 2;
/** 空いた間隔に掛ける余裕。**ちょうどでは足りない** (塊の尺・描くまでの間) */
const GAP_MARGIN = 1.2;
/** 余裕に足す量 (秒) */
const GAP_PAD = 0.1;

export interface Buffered {
    /** 持っている中でいちばん古い時刻 */
    start: number;
    /** いちばん新しい時刻 = 放送の今 */
    end: number;
    /** いま再生している時刻 */
    at: number;
    /** もう再生を始めているか */
    playing: boolean;
    /** どれだけ貯めてから出すか */
    target: number;
    /**
     * 追っかけ再生か。**放送の今を追わない。**
     *
     * 止めて見ていたり、シークバーを戻したりして**わざと遅れて見ている**状態。
     * ここで勝手に飛ぶと、見ようとしていた場面を飛ばすことになる
     */
    chasing: boolean;
    /** 追っかけ中の速さ。見ている人が選ぶ。ライブに戻れば使わない */
    speed: number;
    /**
     * ここしばらくの貯まりの**いちばん低いところ** (秒)。省けばいまの貯まり (`end - at`)。
     *
     * **届いた瞬間の貯まりで決めない。** 塊が届いた直後は貯まりがいちばん多く、束で届けば
     * 届くたびに跳ねる。そこで「多すぎる」と見て速めると、次の塊が遅れたときに使い切って止まる (#1210)。
     * 見るのは次が届く直前の低いところに、ここ数秒の届く間隔 (`dip`) を足したもの —
     * 滑らかに届いていれば今までの「届いた直後の貯まり」と同じ高さになり、遅延は変わらない
     */
    low?: number | undefined;
    /**
     * ここ数秒でいちばん長く空いた届く間隔 (秒)。`low` に足す (**低いところから届いた直後までの差**)。
     * 何分も前の長い空きは入れない — そちらは `target` が覆う (`cover`)。足さないと二重に貯めて遅れる
     */
    dip?: number;
    /** いまの再生の速さ。省けば 1。**速めているのか遅くしているのかで、戻す境目が違う** (`steer`) */
    rate?: number;
}

export interface Pacing {
    /** ここへ移る。移らないなら null */
    seek: number | null;
    /** ここで再生を始める */
    play: boolean;
    /** 再生の速さ。**null は今のまま** (毎回入れ直すと往復する) */
    rate: number | null;
    /** 追っかけが放送の今に追いついた。**呼ぶ側はライブに戻す** */
    caught: boolean;
}

/**
 * 次にどうするかを決める。
 *
 * **頭出しは自分で合わせる。** チャンネルを変えるとMediaSource を作り直すので、再生位置が
 * 新しい範囲の外に取り残される。何もしないとそのままで、1コマも出ない。
 *
 * ## 追っかけ中は飛ばない
 *
 * 追っかけかどうかで**別のものを見ている**。ライブは「放送の今」を追うので、
 * 大きく離れたら飛んで詰めるのが正しい (別のタブから戻ってきたとき)。
 * 追っかけは**わざと遅れて見ている**ので、飛ぶと見ようとしていた場面が飛ぶ。
 *
 * 分けていなかった頃は、**止めて再開すると勝手に放送の今へ飛んで**いた —
 * 「止めた所から見られる」と謳っておきながら、8秒より長く止めると戻れなかった。
 */
export function pacing({
    start,
    end,
    at,
    playing,
    target,
    chasing,
    speed,
    low,
    dip,
    rate,
}: Buffered): Pacing {
    // 範囲の外にいる。チャンネルを変えた直後もここを通る
    if (at < start || at > end) return { seek: start, play: false, rate: 1, caught: false };

    // まだ貯まっていない。始めると、すぐ足りなくなって止まる
    if (!playing) return { seek: null, play: end - at >= target, rate: 1, caught: false };

    const lag = end - at;

    if (chasing) {
        /*
         * **追いついた。** ここから先はライブと同じ扱いにする — 選んだ速さのまま
         * だと放送を追い越してしまい、溜まりを使い切って止まる
         */
        if (lag <= target * 1.1) return { seek: null, play: true, rate: 1, caught: true };
        // 飛ばない。選ばれた速さのまま進む
        return { seek: null, play: true, rate: speed, caught: false };
    }

    // 大きく離れた。**詰めきれないので飛ぶ** — 別のタブから戻ってきたとき
    if (lag > target + JUMP) return { seek: end - target, play: true, rate: 1, caught: false };
    // 少し離れた・少し足りない。速さで寄せる。飛ばないので音は切れない
    const level = low === undefined ? lag : low + (dip ?? 0);
    return { seek: null, play: true, rate: steer(level, target, rate), caught: false };
}

/**
 * 速さを決める。**貯まり (届く直前の低いところ + 届く間隔。`pacing` の `low`) を狙いに寄せる。**
 *
 * - 狙いの 1.5 倍より多い … 速めて詰める (`CATCH_UP`)。**幅を狭く採る。** 2.5倍まで
 *   放っておいた頃は、実機で 0.4 秒を狙って 0.70 秒に居着いていた — 始めた直後は
 *   必ず狙いより溜まる (再生を指示してから実際に映像が出るまでの間にも届く) ので、
 *   放っておくとそこから下りてこない
 * - 狙いを割った … 少し遅くして貯め直す (`SLOW_DOWN`)。止まってから伸ばすより先に効く
 * - 遅くしていたなら、狙いに戻ったところですぐ等速に戻す (遅延を足すのは足りない間だけ)
 * - 速めていたなら、狙いの 1.1 倍まで下りたところで等速に戻す。**その間は今のまま** (境目で戻すと、速める・戻すを往復する)
 *
 * @param low 貯まり (秒)
 * @param rate いまの速さ
 * @returns 次の速さ。null は今のまま
 */
export function steer(low: number, target: number, rate = 1): number | null {
    if (low > target * 1.5) return CATCH_UP;
    if (low < target) return SLOW_DOWN;
    // 遅くしていたなら、狙いに戻ったところでやめる (遅延を足すのは足りない間だけ)
    if (rate < 1) return 1;
    return low <= target * 1.1 ? 1 : null;
}

/**
 * 追っかけで選べる速さ。**遅くは出さない。**
 *
 * 追っかけは「放送に追いつきたい」ための機能なので、1倍より遅い選択肢は
 * 目的と逆を向く。上は2倍まで — それ以上は音が聞き取れなくなる
 */
export const SPEEDS = [1, 1.25, 1.5, 2] as const;

/**
 * 速さを1段ずつ動かす (キーの順送り。観る画面と追っかけで共通)。端では止まる。
 * **戻る側も持つ** — 行き過ぎたら戻れないと不便。並びに無い速さからは等速の位置から数える
 */
export function stepSpeed(speed: number, by: number): number {
    const at = Math.max(0, SPEEDS.indexOf(speed as (typeof SPEEDS)[number]));
    return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, at + by))] ?? speed;
}

/**
 * 速さのボタンの読み上げ名 (`SpeedMenu`)。**等速のときは `label` だけ、速めているときは速さも読む**
 * (「再生の速さ 1.25倍」)。ボタンの見た目は等速ならメーターのアイコン、速めている間は数字だけなので、
 * 読み上げでも同じことが分かるように
 */
export function speedLabel(label: string, speed: number): string {
    return speed === 1 ? label : `${label} ${speed}倍`;
}

/** 貯める量と、その下限 */
export interface Buffering {
    /** どれだけ貯めてから出すか (秒) */
    target: number;
    /** ここより下へは戻さない (秒)。**止まった高さを覚えている** */
    floor: number;
}

/**
 * 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める。**
 *
 * 宅内と宅外で必要な量が桁違いに違うのに、どちらから見ているかは分からない。
 * 決め打ちにすると、宅内に合わせれば宅外で止まり、宅外に合わせれば宅内が
 * 無駄に遅れる。**実際に止まったかどうかで決める**のがいちばん確か。
 *
 * ## 戻る先を覚える
 *
 * 縮める先をいつも `FLOOR` にしていた頃は、**同じ高さで止まり続けた。**
 * 手元のブラウザ (入口込み・H.264) で8分測ると、こうなっていた —
 *
 * ```
 * 0.4秒まで縮む → 詰まる → 3.1秒に跳ねる → 詰めて 0.4秒 → 詰まる …
 * ```
 *
 * ちょうど60秒ごとに、8分で10回。縮め方をいくら直しても、**戻る先が
 * 「そこでは止まる」と分かっている高さ**なら意味がない。止まった高さの
 * すぐ上 (`PROBE`) を新しい下限にして、そこで打ち止めにする。
 *
 * 下限は据え置きにしない (`FORGET`)。経路は変わるので、長く無事なら
 * 少しずつ下げて試し直す。
 *
 * ## 届く間隔を覆う
 *
 * 止まった高さを覚えるだけだと、**止まるたびに 0.3 秒ずつしか上がらない。**
 * 15〜30秒おきに 0.7 秒空く経路では、下限が 1.5 秒に届くまで 2分半に8回止まった
 * (#1210)。止まる前から、ここ数分でいちばん長く空いた間隔 (`gap`) を覆えるだけ
 * 貯める (`cover`)。止まったときも、その空きを覆う高さまで一度に上げる。
 *
 * **低い遅延のための作りなので、上げるのは証拠のぶんだけ。** 塊が 0.05 秒ごとに届く宅内
 * では `cover` は `FLOOR` のまま。空きが来なくなれば数分 (`GAP_WINDOW`) で忘れて縮む。
 * 空きで説明がつく詰まりは端末に覚える下限を動かさない — 覚えると 10 分に 0.3 秒しか下がらない。
 *
 * 覚えた下限の下げ直しは今までどおりゆっくり。**間隔がまだ空いているうちは、それを覆う高さより
 * 下げない** — 覚えている間隔はそのまま貯める量の下支えにもなる。
 *
 * @param now いまの量と下限
 * @param stalled 前回からこちら、詰まったか
 * @param settledFor 最後に詰まってから経った秒数
 * @param floorFor 下限を最後に動かしてから経った秒数
 * @param gap ここ数分 (`GAP_WINDOW`) でいちばん長く空いた届く間隔 (秒)。詰まりを起こした空きも入る
 */
export function nextTarget(
    now: Buffering,
    stalled: boolean,
    settledFor: number,
    floorFor: number,
    gap = 0,
): Buffering {
    const covered = cover(gap);
    if (stalled) {
        /*
         * **空きで説明がつく詰まりなら、空きを覆う高さへ一度に上げる。** 覚えている下限は動かさない —
         * 空きが来なくなれば `GAP_WINDOW` で忘れて、遅延も戻る (1回の空きでずっと遅れて見せない)。
         * 説明がつかない詰まりだけ、今までどおり止まった高さのすぐ上を下限として覚える
         */
        if (covered > now.target) {
            return { target: Math.min(CEILING, Math.max(covered, now.floor)), floor: now.floor };
        }
        const floor = Math.min(CEILING, Math.max(now.floor, now.target + PROBE));
        return { target: Math.min(CEILING, now.target + GROW), floor };
    }
    // 長く無事だった。下限そのものを少し下げて、もう一度試す。**まだ空く間隔を覆う高さより下げない**
    const floor =
        settledFor >= FORGET && floorFor >= FORGET
            ? Math.max(FLOOR, Math.min(now.floor, Math.max(covered, now.floor - PROBE)))
            : now.floor;
    const least = Math.max(floor, covered);
    if (settledFor < SETTLED) return { target: Math.max(least, now.target), floor };
    const shrunk = now.target - Math.max(SHRINK_LEAST, now.target * SHRINK_RATIO);
    return { target: Math.max(least, shrunk), floor };
}

/**
 * 届く間隔 `gap` (秒) を覆うのに要る貯まり (秒)。**1.2 倍に 0.1 秒足す** — ちょうどでは足りない。
 * 宅内のように塊が 0.05 秒ごとに来ていれば `FLOOR` のまま。長すぎる空き (`GAP_MOST`) は途絶えと見て、そこで打ち止め
 */
export function cover(gap: number): number {
    if (!(gap > 0)) return FLOOR;
    return Math.min(CEILING, Math.max(FLOOR, Math.min(gap, GAP_MOST) * GAP_MARGIN + GAP_PAD));
}

/**
 * ここしばらくのいちばん大きい (小さい) 値。**塊は毎秒20個届くので、全部は並べない。**
 *
 * 後から来た値に負ける古い値は、もう答えにならないので捨てる (単調な列)。
 * 届く間隔 (いちばん長い空き) と、貯まりの低いところ (いちばん少ない) に使う
 */
export class Extreme {
    readonly #items: { at: number; value: number }[] = [];
    /**
     * @param span 覚えておく長さ。`at` と同じ単位
     * @param highest 大きいほうを覚えるか。false なら小さいほう
     */
    constructor(
        readonly span: number,
        readonly highest: boolean,
    ) {}

    push(at: number, value: number): void {
        const items = this.#items;
        const beaten = (old: number) => (this.highest ? old <= value : old >= value);
        for (let last = items.at(-1); last !== undefined && beaten(last.value); last = items.at(-1))
            items.pop();
        items.push({ at, value });
        this.#drop(at);
    }

    /** `at` の時点で覚えている中のいちばん。何も無ければ null */
    peek(at: number): number | null {
        this.#drop(at);
        return this.#items[0]?.value ?? null;
    }

    clear(): void {
        this.#items.length = 0;
    }

    #drop(at: number): void {
        const items = this.#items;
        for (let first = items[0]; first !== undefined && first.at < at - this.span; first = items[0])
            items.shift();
    }
}
