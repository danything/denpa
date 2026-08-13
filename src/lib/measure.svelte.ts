/**
 * 画面の高さを読む札を出すかどうか (`components/Measure.svelte`)。
 *
 * **URL だけでは足りない。** ホーム画面から開いたアプリ (PWA) には
 * アドレスバーが無いので、`?measure` を付けたくても打つところがない。
 * 覚えさせておいて、設定画面から入り切りする。
 *
 * **端末ごとの話なのでサーバには置かない。** 見たいのは「この端末の高さ」で、
 * 別の端末や別の人に付いて回るものではない
 */

import { forget, read, write } from '$lib/keep';

const KEY = 'denpa_measure';

let on = $state(false);

export const measure = {
    get on(): boolean {
        return on;
    },

    /** 入り切り。覚えるので、リロードしても消えない (それが要る場面で使う) */
    set(next: boolean): void {
        on = next;
        if (next) write(KEY, '1');
        else forget(KEY);
    },

    /**
     * 読み込み時とページ移動のたびに読み直す。
     *
     * `?measure` は**覚えない** — 1回だけ見たいときの手で、付けた URL を
     * 誰かに渡したときに相手の端末に居座らせない
     */
    start(url: URL): void {
        on = url.searchParams.has('measure') || read(KEY) === '1';
    },
};
