import { beforeNavigate, goto } from '$app/navigation';
import { page } from '$app/state';
import { exitNative, fullscreenMode, nativeFullscreenElement, requestNative } from './fullscreen';

/**
 * 舞台 (`PlayerStage`) の全画面。**3画面 (ライブ・追っかけ・録画) で同じもの** (#471)。
 *
 * 入り方は端末の口で決める (`fullscreen.ts`)。本物の全画面 (標準・webkit) が無い
 * iPhone の Safari では**枠を画面いっぱいに広げて代わりにする** (以下「広げる」)。
 * 押す口・ボタンの絵・`f` キーはどれでも同じ。
 *
 * ## 広げる (iPhone)
 *
 * - 枠を `position: fixed` で画面いっぱいに (`PlayerStage` の `data-pseudo`)。
 *   重ねもの (字幕・データ放送・操作列) は枠の大きさから測るので、そのまま付いてくる
 * - 後ろのページは**転がらないようにし、周りを黒に** (`html[data-stage-fullscreen]`、`app.css`)。
 *   横持ちの切り欠きの帯は Safari がページの地の色で塗るので、それも黒になる
 * - 出口は**同じボタン・Esc・戻る**。本物の全画面なら OS が持っている「戻る」を、
 *   こちらでは**履歴を1段積んで** (`page.state.fullscreen`) 作る — 戻るで広げたのを
 *   畳み、もう一度戻るで前の画面へ。ボタン・Esc で出たときは積んだ段を戻して消す
 * - 別の画面へ移るときは畳む (`beforeNavigate`)。録画から次の録画へ行くときは
 *   部品が作り直されないので、黙っていると広げたまま残る
 * - 向きは固定しない — iPhone の Safari は `screen.orientation.lock` を持たない。
 *   横に持てば横いっぱいになる
 */
export interface StageFullscreen {
    /** 全画面か (本物でも広げたのでも) */
    readonly active: boolean;
    /** 広げているか (iPhone) */
    readonly pseudo: boolean;
    enter: () => void;
    exit: () => void;
    toggle: () => void;
}

export function stageFullscreen(target: () => HTMLElement | null): StageFullscreen {
    let native = $state(false);
    let pseudo = $state(false);

    $effect(() => {
        const update = () => (native = nativeFullscreenElement(document) !== null);
        update();
        document.addEventListener('fullscreenchange', update);
        document.addEventListener('webkitfullscreenchange', update);
        return () => {
            document.removeEventListener('fullscreenchange', update);
            document.removeEventListener('webkitfullscreenchange', update);
        };
    });

    /*
     * 広げている間: 後ろを止めて黒く、Esc で出る。**枠の中のメニューが開いていれば
     * そちらに譲る** — Bits UI は document で Esc を受けて `preventDefault` するので、
     * window まで上がってきたときには印が付いている
     */
    $effect(() => {
        if (!pseudo) return;
        const root = document.documentElement;
        root.setAttribute('data-stage-fullscreen', '');
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            exit();
        };
        window.addEventListener('keydown', onKey);
        return () => {
            root.removeAttribute('data-stage-fullscreen');
            window.removeEventListener('keydown', onKey);
        };
    });

    /*
     * **戻るで畳む。** 積んだ段 (`fullscreen: true`) から降りたら広げたのをやめる。
     * 見るのは「立っていた札が下りた」ときだけ — 積む前 (`goto` が済むまで) は
     * 札がまだ無いので、それを「降りた」と取り違えない
     */
    let stacked = false;
    $effect(() => {
        const on = page.state.fullscreen === true;
        if (stacked && !on) pseudo = false;
        stacked = on;
    });

    /** 段を積んでいる最中か。済む前に出て入り直したとき、二重に積まない */
    let pushing = false;

    beforeNavigate((navigation) => {
        if (navigation.to?.url.pathname !== navigation.from?.url.pathname) pseudo = false;
    });

    function enter(): void {
        const element = target();
        if (element === null) return;
        const mode = fullscreenMode(element, document);
        if (mode !== 'pseudo') {
            void requestNative(element, mode);
            return;
        }
        if (pseudo) return;
        pseudo = true;
        // 札が残っている段 (よそから戻ってきた) なら積み増さない。戻ればそのまま下の段へ降りる
        if (page.state.fullscreen === true || pushing) return;
        pushing = true;
        /*
         * 積めなくても広げたまま (開いた直後で道案内がまだ動いていないなど)。ボタン・Esc で出られる。
         * **積み終わる前に出られたら、積んだ段をそこで戻す** — 出た時点では段がまだ無く
         * `exit` は戻さないので、放っておくと何も広げていない段が1つ残る
         */
        goto(location.href, { state: { ...page.state, fullscreen: true }, shallow: true }).then(
            () => {
                pushing = false;
                if (!pseudo && page.state.fullscreen === true) history.back();
            },
            () => {
                pushing = false;
            },
        );
    }

    function exit(): void {
        if (native) {
            void exitNative(document);
            return;
        }
        if (!pseudo) return;
        pseudo = false;
        if (page.state.fullscreen === true) history.back();
    }

    return {
        get active() {
            return native || pseudo;
        },
        get pseudo() {
            return pseudo;
        },
        enter,
        exit,
        toggle: () => (native || pseudo ? exit() : enter()),
    };
}
