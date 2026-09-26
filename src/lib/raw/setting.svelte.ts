/**
 * **ライブを生で見るか** (docs/stream.md §5.5)。端末ごとの設定で、**既定は切**。
 *
 * 端末ごとに置くのは、決め手が端末の側にあるから — 解けるだけの CPU があるか、
 * 電池で動いているか、その端末をどこで使うか。サーバに置くと、居間の PC で入れた
 * 設定がタブレットにも付いて回る。
 *
 * 入れていても、LAN の外 (サーバが決める) や解けない端末 (`support.ts`) では焼いたものになる。
 */

import { forget, read, write } from '$lib/keep';

const KEY = 'denpa_live_raw';

// サーバで組むときは読めない (`keep.read` が null を返す) ので切のまま。画面では読み込んだ時点の値
let on = $state(read(KEY) === '1');

export const rawSetting = {
    get on(): boolean {
        return on;
    },

    set(next: boolean): void {
        on = next;
        if (next) write(KEY, '1');
        else forget(KEY);
    },
};
