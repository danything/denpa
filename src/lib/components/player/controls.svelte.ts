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

/** 触らなくなってから消えるまで (ms)。**指のほうを長く待つ** */
const LINGER = { mouse: 2500, touch: 5000 };

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
}

export function playerControls(): PlayerControls {
    let touched = $state(Date.now());
    let now = $state(Date.now());
    /** 直前に触ったのが指 (かペン) か。**マウスの繋がっていない端末もある** */
    let byTouch = $state(false);
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
    const shown = $derived(held || keyboard || now - touched < (byTouch ? LINGER.touch : LINGER.mouse));

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
         * **本当に動いたときだけ出す。**
         *
         * ブラウザは、止まっているカーソルの下で中身が動いただけでも
         * `pointermove` を投げてくる。時計は毎秒書き換わるので、**全画面に
         * したまま何もしなくても操作列が消えなくなって**いた (実機のPC)。
         * 座標が変わっていないものは触ったことにしない
         */
        wake(event: PointerEvent): void {
            if (event.clientX === lastX && event.clientY === lastY) return;
            lastX = event.clientX;
            lastY = event.clientY;
            byTouch = event.pointerType !== 'mouse';
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
            touched = 0;
            now = Date.now();
        },
    };
}
