/**
 * 操作列を出しておくか消すかの決め方。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
 *
 * 絵の上に居座るものなので、触っていない間は引っ込める。**止めていても引っ込めます** —
 * 一時停止するのは、たいてい**絵の中の文字をじっくり見る**ためで、そこに帯が
 * 残っていては止めた意味が無い。以前は止めている間だけ残していた
 * (「出すためにもう一度押すことになる」という理屈だった) が、**押せば出るものを
 * 残しておくより、押さないと消せないほうが邪魔**だった。
 *
 * 残すのは**キーボードで触っている間だけ**。あちらは絵を押して出し直す手が無い。
 *
 * ここを2箇所に持っていた頃は、ライブは「動かせば出る」まで作り込んであるのに、
 * 観る画面は**押したときにしか出なかった**。実機では隠れている帯の上を押すと
 * 下の絵が受け取って再生が止まり、送りを押したいだけなのに一度止めることに
 * なっていた。
 *
 * 出す・消すを決めるだけで、DOM も映像も触りません
 */

/**
 * 触らなくなってから消えるまで (ms)。**指もマウスも同じ長さ。**
 *
 * 指だけは時計を持たせず、押すまで留めていた時期がある — 「出したのが意思なら、
 * 消すのも意思のはず」という理屈だった。**実機で使うと、消したいときに毎回
 * 絵を押すことになった。** 絵の上に居座るものを引っ込めるのに操作が要るのでは、
 * 引っ込む意味が薄い。**出し方は指とマウスで違ってよいが、消え方は同じでいい**
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
    /** 押される直前に出ていたか。`toggle` が読む */
    let wasShown = false;
    let keyboard = $state(false);
    /** 前に居た場所。**動いていない `pointermove` を捨てる**のに使う (`wake`) */
    let lastX = Number.NaN;
    let lastY = Number.NaN;

    /*
     * **見るのは「触ったか」だけ** (キーボードを除く)。再生や一時停止の状態を
     * 混ぜていた頃は、繋いでいる間ずっと出たままになり、消える経路を
     * 確かめようが無かった
     */
    const shown = $derived(keyboard || now - touched < LINGER);

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
        /**
         * **指とマウスで別の出し方をする。**
         *
         * *指* … 押したときだけ出す。指を滑らせただけ (`pointermove`) では
         * 何もしない — 出し入れは押したときの1回で決める。**消えるまでは
         * マウスと同じ長さ** (`LINGER` の項)。
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
                // 巻き直す前に読む。`toggle` は「押す前に出ていたか」で決める
                wasShown = shown;
                touched = Date.now();
                now = touched;
                return;
            }
            if (event.clientX === lastX && event.clientY === lastY) return;
            lastX = event.clientX;
            lastY = event.clientY;
            byTouch = false;
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
        /*
         * **押す前に出ていたかで決める。** いまの状態で決めていた頃は、
         * 押した瞬間に `wake` が出したものを見て「出ている→消す」と読み、
         * **指では二度と出せなかった**
         */
        toggle(): void {
            if (!byTouch) return;
            if (!wasShown) return;
            touched = 0;
            now = Date.now();
        },
    };
}
