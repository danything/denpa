import { untrack } from 'svelte';
import type { Notice } from '#lib/components/Toasts.svelte';

/**
 * ピクチャーインピクチャー (PiP)。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
 *
 * 絵だけを小窓にして、他の画面・他のアプリを触りながら観る。出すのは `<video>` そのもの
 * なので、**字幕 (canvas に重ねている) と操作列は小窓に付いていかない**。
 *
 * ## ボタンを出さないところ
 *
 * - **iPhone / iPad のホーム画面から開いたもの (PWA)。** Safari が許していない。
 *   口は有るように見える (`pictureInPictureEnabled` が立つ) のに押しても出ないので、
 *   `navigator.standalone` (Apple の端末にしか無い) で見分けて、ボタンごと出さない
 * - **ページから小窓を開かせる口 (`requestPictureInPicture`) が無いブラウザ。** 押しても
 *   何も起きないボタンを並べない。ブラウザ自身の小窓の切り替えは、ページと関係なく使える
 * - **生 (MPEG-2) の絵の流れを取れないブラウザ (Firefox)**。生の間だけ出さない (下)
 *
 * Safari は標準の口のほかに `webkitSetPresentationMode` を持っていて、古い iOS の
 * Safari にはそちらしか無い。標準が無ければそちらで出す。
 *
 * ## 生 (MPEG-2) で見ているとき
 *
 * **絵は worker の canvas に居て、`<video>` は空** (`raw/engine.ts`)。そのまま出すと
 * 黒い小窓になる。worker が描いた絵の流れを別の `<video>` に映し、それを小窓にする
 * (流れの取り方は `RawEngine.pipStream`。Chrome は worker が直に書き込み、Safari は
 * canvas から取る。Firefox はどちらもできない)。音は今までどおりページ (`AudioContext`) から鳴る。
 *
 * **代わりの `<video>` は生に入った時点で用意しておく** (`prepare`)。押されてから
 * 流れを繋いで1枚目を待っていた頃は、iPhone の Safari で必ず断られていた
 * (`NotAllowedError: The request is not triggered by a user activation.`) — 待っている
 * 間に「押された直後」が切れる。小窓を頼むのは押されたその場でなければならず、
 * そのためには1枚目が既に届いている (`HAVE_METADATA`) 必要がある。
 * 1枚目が届いたら流れを切っておき (`enabled = false`)、押されたら戻す。
 * 小窓に出していない間まで絵を写し続けない
 *
 * ## 止める・再開する
 *
 * 小窓にもブラウザの再生ボタンがあり、押すと `<video>` を直に止める。**ライブと
 * 追っかけは「止めているか」を player 側で持っている** (`live-player` の `paused`) ので、
 * 渡された `paused` / `toggle` で合わせる。観る画面は `<video>` の `play`/`pause` を
 * そのまま見ているので要らない
 *
 * ## OS・ブラウザが自分で小窓にするのを止める
 *
 * バックグラウンド再生を切っている間 (`auto` が false。`background.svelte.ts`) は
 * `disablePictureInPicture` を立てておく。全画面からホームへ戻る (iPhone)・タブを移る
 * (Chrome) だけで勝手に小窓が出て、裏で鳴り続けていた。**押して開く小窓には効かせない** —
 * 頼む直前に下ろし (`enter`)、出している間は下ろしたまま (立てると小窓が閉じる)
 */

interface Options {
    /** 映像の `<video>` */
    video: () => HTMLVideoElement | null;
    /** 生で見ているか。立っている間は `capture` の流れを出す */
    raw?: () => boolean;
    /** 生の絵の流れ (`live-player` の `capture`) */
    capture?: () => MediaStream | null;
    /** 生の絵を流すか (`live-player` の `captureFlow`)。小窓に出していない間は止める */
    flow?: (on: boolean) => void;
    /** 止めているか (ライブ・追っかけ)。**小窓で押された止める・再開を合わせる先** */
    paused?: () => boolean;
    toggle?: () => void;
    /** OS・ブラウザが自分で小窓にするのを許すか (バックグラウンド再生)。渡さなければ許す */
    auto?: () => boolean;
}

/** どこで断られたか。**押しても何も起きない、で終わらせない** — 端末ごとに転ぶ所が違う */
class Refused extends Error {}

function reason(error: unknown): string {
    if (error instanceof Refused) return error.message;
    if (error instanceof DOMException) return `ブラウザに断られました (${error.name}: ${error.message})`;
    return String(error);
}

export interface Pip {
    /** この端末・いまの見え方で出せるか。**出せなければボタンを出さない** */
    readonly available: boolean;
    /** 小窓で出しているか */
    readonly active: boolean;
    toggle: () => void;
    /** 出せなかった理由 (トーストへ混ぜる)。出せていれば空 */
    readonly notices: Notice[];
    dismiss: (key: string) => void;
}

/** Safari だけの口 */
type WebkitVideo = HTMLVideoElement & {
    webkitSupportsPresentationMode?: (mode: string) => boolean;
    webkitSetPresentationMode?: (mode: string) => void;
    webkitPresentationMode?: string;
};

const MODE = 'picture-in-picture';

/** 標準の口が使えるか */
function standard(): boolean {
    return document.pictureInPictureEnabled === true;
}

/** Safari の口が使えるか (標準が無い古い Safari) */
function webkit(video: WebkitVideo): boolean {
    return (
        typeof video.webkitSupportsPresentationMode === 'function' &&
        video.webkitSupportsPresentationMode(MODE)
    );
}

function supported(): boolean {
    // iPhone / iPad のホーム画面から開いたもの。Safari が小窓を許していない
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return false;
    return standard() || webkit(document.createElement('video'));
}

/** 小窓で出しているか (その video が) */
function shown(video: WebkitVideo): boolean {
    return document.pictureInPictureElement === video || video.webkitPresentationMode === MODE;
}

export function pictureInPicture(options: Options): Pip {
    /** 開いた端末で決まる。サーバで組むときは無いので、開いてから測る */
    let able = $state(false);
    /** 小窓に出している video (本体か、生のときの代わり)。出していなければ null */
    let on = $state<HTMLVideoElement | null>(null);
    /** 生のときに小窓へ出す代わりの video。要るときに作る */
    let proxy: HTMLVideoElement | null = null;
    /**
     * 用意できなかった理由 (`prepare`)。**立っている間はボタンを出さない** — Firefox は生の
     * 絵の流れを取れず、押せても必ず断られる
     */
    let unprepared = $state<Refused | null>(null);
    /** 出せなかった理由 */
    let refused = $state<Notice | null>(null);

    const canCapture =
        typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
    const raw = (): boolean => options.raw?.() ?? false;

    $effect(() => {
        able = supported();
    });

    /** 出た・引っ込んだを拾う。**閉じるのは小窓の × からも来る** ので、こちらで押したかに頼らない */
    function listen(video: WebkitVideo): () => void {
        const update = () => {
            if (shown(video)) on = video;
            else if (on === video) on = null;
            if (video === proxy && on !== proxy) flowing(false);
        };
        video.addEventListener('enterpictureinpicture', update);
        video.addEventListener('leavepictureinpicture', update);
        video.addEventListener('webkitpresentationmodechanged', update);
        return () => {
            video.removeEventListener('enterpictureinpicture', update);
            video.removeEventListener('leavepictureinpicture', update);
            video.removeEventListener('webkitpresentationmodechanged', update);
        };
    }

    /**
     * **小窓で押された止める・再開を player に伝える。**
     *
     * 小窓に出している間だけ。それ以外の `pause` まで拾うと、押していないのに止まった
     * ことになる。**生へ移るときも拾わない** — player は焼いたほうの `<video>` を止めるが
     * (`startRaw`)、`pause` が届くのは小窓が閉じきる前で、まだ `on` に居る。
     * player が自分で止めた・再開したときは、その時点で `paused` が既に合っているので何もしない
     */
    function follow(video: HTMLVideoElement): () => void {
        const { paused, toggle } = options;
        if (paused === undefined || toggle === undefined) return () => {};
        const sync = () => {
            if (on !== video || (video === proxy) !== raw()) return;
            if (video.paused !== paused()) toggle();
        };
        video.addEventListener('pause', sync);
        video.addEventListener('play', sync);
        return () => {
            video.removeEventListener('pause', sync);
            video.removeEventListener('play', sync);
        };
    }

    $effect(() => {
        const video = options.video();
        if (video === null) return;
        const unlisten = listen(video);
        const unfollow = follow(video);
        return () => {
            unlisten();
            unfollow();
        };
    });

    /**
     * **生に移った・焼いたものに戻ったら小窓を閉じる。** 出しているほうにはもう絵が
     * 流れてこない (生では `<video>` は空、戻れば canvas は畳まれる)。黙って残すと、
     * 止まった絵の小窓が居座る
     */
    $effect(() => {
        const wantProxy = raw();
        if (on !== null && (on === proxy) !== wantProxy) leave();
    });

    /** 生に入ったら代わりの video を用意しておく。出たら畳む (canvas ごと無くなる) */
    $effect(() => {
        if (!able || !raw() || !canCapture || options.capture === undefined) return;
        untrack(prepare);
        return release;
    });

    /** 押さずに小窓にされないようにする (上の説明)。出している video は下ろしたまま */
    function guard(): void {
        const allow = options.auto?.() ?? true;
        for (const video of [options.video(), proxy])
            if (video !== null) video.disablePictureInPicture = !allow && on !== video;
    }
    $effect(guard);

    /** 生のとき、代わりの video も止める・再開を合わせる (押されたのが帯のボタンのとき) */
    $effect(() => {
        const paused = options.paused?.() ?? false;
        if (proxy === null || on !== proxy) return;
        if (paused) proxy.pause();
        else void proxy.play().catch(() => undefined);
    });

    /*
     * 画面を離れたら閉じる。player は止まるので、小窓に残しても絵は来ない。
     * **流れもここで止める** — 生の `$effect` の後始末が先に走るとは限らない
     */
    $effect(() => () => {
        leave();
        release();
        proxy?.remove();
        proxy = null;
    });

    /** 代わりの video を用意する。**画面の外に、見えない大きさで置く** (文書に居ないと出せない) */
    function makeProxy(): HTMLVideoElement {
        if (proxy !== null) return proxy;
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('aria-hidden', 'true');
        video.dataset['testid'] = 'pip-raw';
        video.style.cssText =
            'position:fixed; left:0; top:0; width:1px; height:1px; opacity:0; pointer-events:none;';
        document.body.append(video);
        listen(video);
        follow(video);
        proxy = video;
        guard();
        return video;
    }

    /**
     * 代わりの video に流れを繋いで、1枚目まで受け取っておく。**押されてからでは遅い** (上の説明)。
     * 1枚目が来たら流れを切る — 小窓に出すまで写し続けない
     */
    function prepare(): void {
        unprepared = null;
        const stream = options.capture?.() ?? null;
        if (stream === null) {
            unprepared = new Refused('MPEG-2 の絵を取り出せません (captureStream)');
            return;
        }
        if (stream.getVideoTracks().length === 0) {
            unprepared = new Refused('MPEG-2 の絵の流れが空です');
            return;
        }
        const video = makeProxy();
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', () => on !== video && flowing(false), { once: true });
        void video.play().catch((error: unknown) => {
            unprepared = new Refused(`代わりの映像を再生できません (${reason(error)})`);
        });
    }

    /** 代わりの video へ絵を流すか。**切っても1枚目の大きさは覚えたまま** (`readyState` は下がらない) */
    function flowing(flow: boolean): void {
        const stream = proxy?.srcObject;
        if (stream instanceof MediaStream) for (const track of stream.getVideoTracks()) track.enabled = flow;
        options.flow?.(flow);
    }

    /** 代わりの video を畳む。生を出たとき (canvas ごと無くなる) */
    function release(): void {
        if (proxy === null) return;
        const stream = proxy.srcObject;
        if (stream instanceof MediaStream) for (const track of stream.getTracks()) track.stop();
        proxy.srcObject = null;
    }

    /**
     * 小窓に出す。**頼むまでに `await` を挟まない** — 挟むと Safari は「押された直後」と
     * 見なさなくなって断る (`NotAllowedError`)
     */
    async function enter(): Promise<void> {
        let video: WebkitVideo | null = options.video();
        if (raw()) {
            if (unprepared !== null) throw unprepared;
            if (proxy === null || proxy.srcObject === null)
                throw new Refused('MPEG-2 の絵を用意できていません');
            if (proxy.readyState < HTMLMediaElement.HAVE_METADATA)
                throw new Refused('MPEG-2 の絵がまだ届いていません。少し待ってから押し直してください');
            video = proxy;
            flowing(true);
            if (options.paused?.() === true) video.pause();
            else void video.play().catch(() => undefined);
        }
        if (video === null) return;
        // 押して開くものは止めない (勝手に開かせないための印。上の説明)
        video.disablePictureInPicture = false;
        if (standard()) await video.requestPictureInPicture();
        else if (webkit(video)) {
            /*
             * Safari の口は断っても何も言わない。切り替わったかを見て言う。
             * **一度でも切り替わったかで見る** — 1秒の間に閉じられた・画面を離れたものまで
             * 「切り替わらなかった」と言っていた
             */
            const target = video;
            let reached = false;
            const mark = () => {
                if (shown(target)) reached = true;
            };
            target.addEventListener('webkitpresentationmodechanged', mark);
            target.webkitSetPresentationMode?.(MODE);
            setTimeout(() => {
                target.removeEventListener('webkitpresentationmodechanged', mark);
                if (!reached && on !== target)
                    refuse(new Refused('Safari が小窓に切り替えませんでした (webkitSetPresentationMode)'));
            }, 1000);
        }
    }

    /** 出せなかった理由を言う。**コンソールにも残す** (端末によってはトーストより読みやすい) */
    function refuse(error: unknown): void {
        console.warn('[pip]', error);
        refused = {
            key: `pip-${Date.now()}`,
            kind: 'error',
            text: `小窓を出せませんでした: ${reason(error)}`,
        };
        flowing(false);
        // 頼む前に下ろした印を戻す (`enter`)
        guard();
    }

    function leave(): void {
        const video = on as WebkitVideo | null;
        if (video === null) return;
        if (document.pictureInPictureElement === video)
            void document.exitPictureInPicture().catch(() => undefined);
        else if (video.webkitPresentationMode === MODE) video.webkitSetPresentationMode?.('inline');
        if (video === proxy) flowing(false);
    }

    return {
        get available() {
            return able && (!raw() || (canCapture && options.capture !== undefined && unprepared === null));
        },
        get active() {
            return on !== null;
        },
        toggle() {
            refused = null;
            if (on !== null) leave();
            else void enter().catch(refuse);
        },
        get notices() {
            return refused === null ? [] : [refused];
        },
        dismiss(key: string) {
            if (refused?.key === key) refused = null;
        },
    };
}
