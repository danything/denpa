/**
 * 操作列を出しておくか消すかの決め方。**ライブと観る画面で同じもの。**
 *
 * 絵の上に居座るものなので、触っていない間は引っ込める。**止めている間と、
 * キーボードで触っている間は残す** — 止めて眺めているときに操作が消えると、
 * 出すためだけにもう一度押すことになる。
 *
 * ここを2箇所に持っていた頃は、ライブは「動かせば出る・指は長めに残る」まで
 * 作り込んであるのに、観る画面は**押したときにしか出なかった**。実機では
 * 隠れている帯の上を押すと下の絵が受け取って再生が止まり、10秒送りを
 * 押したいだけなのに一度止めることになっていた。
 *
 * 出す・消すを決めるだけで、DOM も映像も触りません
 */

/**
 * 触らなくなってから消えるまで (ms)。**これはマウスだけの話。**
 *
 * 指には時計を持たせない (`pinned`)。マウスは絵の上を通り過ぎるだけでも
 * 出てしまうので放っておけば消えてほしいが、**指は押さなければ何も起きない** —
 * 出したのが意思なら、消すのも意思のはず
 */
const LINGER = 2500;

/** 消す時刻を跨ぐためだけの目覚まし。出ている間しか回さない */
const TICK = 250;

export interface PlayerControls {
    /** いま出ているか */
    readonly shown: boolean;
    /** 押されたり動かされたりしたとき。出して、時計を巻き直す */
    wake: (event: PointerEvent) => void;
    /** 出ていく先で消す。**指のときは消さない** */
    away: (event: PointerEvent) => void;
    /** キーボードで触っている間は残す */
    keyboard: boolean;
    /** 止めている間は残す。呼ぶ側が入れる */
    held: boolean;
    /** その場で出し直す (ボタンを押した直後など) */
    stir: () => void;
    /** その場で消す (指で1回押して引っ込めるとき) */
    hide: () => void;
    /**
     * 指で絵を押した。**押す前に出ていたかで決める** (`wake` の項)。
     * マウスのときは何もしない
     */
    toggle: () => void;
}

export function playerControls(): PlayerControls {
    let touched = $state(Date.now());
    let now = $state(Date.now());
    /** 直前に触ったのが指 (かペン) か。**マウスの繋がっていない端末もある** */
    let byTouch = $state(false);
    /**
     * 指で出したまま留めているか。**指には時計を持たせない** (`LINGER` の項)。
     * 降ろすのは、もう一度絵を押されたときだけ (`toggle`)
     */
    let pinned = $state(false);
    /** 押される直前に出ていたか。`toggle` が読む */
    let wasShown = false;
    let keyboard = $state(false);
    let held = $state(false);
    /** 前に居た場所。**動いていない `pointermove` を捨てる**のに使う (`wake`) */
    let lastX = Number.NaN;
    let lastY = Number.NaN;

    /*
     * **見るのは「触ったか」と「止めているか」だけ。** 再生できているかどうかを
     * 混ぜていた頃は、繋いでいる間ずっと出たままになり、消える経路を
     * 確かめようが無かった
     */
    const shown = $derived(held || keyboard || pinned || now - touched < LINGER);

    $effect(() => {
        if (!shown) return;
        const timer = setInterval(() => (now = Date.now()), TICK);
        return () => clearInterval(timer);
    });

    return {
        get shown(): boolean {
            return shown;
        },
        get keyboard(): boolean {
            return keyboard;
        },
        set keyboard(value: boolean) {
            keyboard = value;
        },
        get held(): boolean {
            return held;
        },
        set held(value: boolean) {
            held = value;
        },
        /**
         * **指とマウスで別の出し方をする。**
         *
         * *指* … 押したときだけ出して、**そのまま留める** (`pinned`)。時計で
         * 消していた頃は、押した数秒後に必ず引っ込むので、**止めない限り
         * 出しっぱなしにできなかった** (実機のタブレット)。指を滑らせただけ
         * (`pointermove`) では何もしない — 出し入れは押したときの1回で決める。
         *
         * *マウス* … 動かせば出て、しばらくで消える。**本当に動いたときだけ** —
         * ブラウザは、止まっているカーソルの下で中身が動いただけでも
         * `pointermove` を投げてくる。時計は毎秒書き換わるので、**全画面に
         * したまま何もしなくても操作列が消えなくなって**いた (実機のPC)
         */
        wake(event: PointerEvent): void {
            if (event.pointerType !== 'mouse') {
                if (event.type !== 'pointerdown') return;
                byTouch = true;
                // 留める前に読む。`toggle` は「押す前に出ていたか」で決める
                wasShown = shown;
                pinned = true;
                return;
            }
            if (event.clientX === lastX && event.clientY === lastY) return;
            lastX = event.clientX;
            lastY = event.clientY;
            byTouch = false;
            pinned = false;
            touched = Date.now();
            now = touched;
        },
        /*
         * 指を離すとブラウザはその場でポインタを取り下げるので、`pointerleave` が
         * **触った直後に必ず飛ぶ**。マウスと同じに扱っていた頃は、タッチの端末で
         * **触った瞬間に操作列が消えて**いた。マウスは絵の外へ出たなら本当に
         * 離れているので、そちらは今までどおり消す
         */
        away(event: PointerEvent): void {
            if (event.pointerType === 'mouse') touched = 0;
        },
        stir(): void {
            touched = Date.now();
            now = touched;
        },
        hide(): void {
            pinned = false;
            touched = 0;
            now = Date.now();
        },
        /*
         * **押す前に出ていたかで決める。** いまの状態で決めていた頃は、
         * 押した瞬間に `wake` が出したものを見て「出ている→消す」と読み、
         * **指では二度と出せなかった** (止めている間だけ `held` で残っていた)
         */
        toggle(): void {
            if (!byTouch) return;
            if (!wasShown) return;
            pinned = false;
            touched = 0;
            now = Date.now();
        },
    };
}
