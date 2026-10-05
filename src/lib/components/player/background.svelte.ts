import { untrack } from 'svelte';
import { read, write } from '#lib/keep.js';
import { BACKGROUND_KEY, step, storedBackground } from './background';

/**
 * バックグラウンド再生。**3画面 (ライブ・追っかけ・観る画面) で同じもの。既定は切。**
 *
 * ## 切 (既定)
 *
 * - **裏に回ったら止める** (`visibilitychange` で `hidden`、または `pagehide`)。戻ってきたら、
 *   こちらが止めたときだけ再開する。ライブは放送の今へ戻り (張り付いていたとき)、
 *   追っかけ・録画は止めた所から
 * - **OS・ブラウザに勝手に小窓にさせない** (`disablePictureInPicture`。`pip.svelte.ts` の `auto`)。
 *   全画面からホームへ戻っただけで小窓が出て、鳴り続けていた
 * - **生 (MPEG-2) の音は「再生する音」と言わない** (Audio Session を `auto` のまま。`raw/engine.ts`)
 *
 * **押して開いた小窓はそのまま使える。** 出している間は裏に回っても止めない (観たいと
 * 言われている)。閉じた時点でまだ裏なら、そこで止める。
 *
 * ## 入
 *
 * 止めない。生の音は Audio Session を `playback` にして、OS が勝手に小窓にするのも許す。
 *
 * **端末ごとに覚える** (`keep.ts`。速さ・CM 飛ばしと同じ) — 手元のスマホでは裏で
 * 聴きたいが、居間のテレビでは要らない、のように端末で変わる
 */
interface Options {
    /** 押して開いた小窓を出しているか (`pip.active`) */
    pip: () => boolean;
    /** 止めているか */
    paused: () => boolean;
    /** 裏に回ったので止める */
    pause: () => void;
    /** 戻ってきたので再開する */
    resume: () => void;
}

export interface Background {
    /** 入れているか */
    readonly on: boolean;
    toggle: () => void;
}

export function backgroundPlayback(options: Options): Background {
    /** 開いた端末で決まる。サーバで組むときは無いので、開いてから読む */
    let on = $state(false);
    /** こちらが止めたか。戻ってきたときに再開するのはこれだけ */
    let held = false;
    /** `pagehide` のあと。`visibilityState` がまだ `visible` のまま来ることがある */
    let gone = false;

    $effect(() => {
        on = storedBackground(read(BACKGROUND_KEY));
    });

    function check(): void {
        const hidden = gone || document.visibilityState === 'hidden';
        const act = step({ allowed: on, hidden, pip: options.pip(), paused: options.paused(), held });
        if (!hidden) held = false;
        if (act === 'pause') {
            held = true;
            options.pause();
        } else if (act === 'resume') options.resume();
    }

    $effect(() => {
        const hide = () => {
            gone = true;
            check();
        };
        const show = () => {
            gone = false;
            check();
        };
        document.addEventListener('visibilitychange', check);
        window.addEventListener('pagehide', hide);
        window.addEventListener('pageshow', show);
        return () => {
            document.removeEventListener('visibilitychange', check);
            window.removeEventListener('pagehide', hide);
            window.removeEventListener('pageshow', show);
        };
    });

    // 小窓を閉じた時点でまだ裏なら、そこで止める
    $effect(() => {
        options.pip();
        untrack(check);
    });

    return {
        get on() {
            return on;
        },
        toggle() {
            on = !on;
            write(BACKGROUND_KEY, on ? '1' : '0');
        },
    };
}
