import { invalidateAll } from '$app/navigation';
import { navigating } from '$app/state';

/**
 * 画面の読み直しと、**画面遷移が終わったかどうか**。
 *
 * ## `invalidateAll` は、走っている遷移を黙って畳む
 *
 * SvelteKit は遷移にも読み直しにも同じ「いま有効な札」(`token`) を使っていて、
 * `invalidateAll()` はそれを**自分のものに書き換える**。読み込みから戻ってきた
 * 遷移は札が違うのを見て、そこで**何もせずに降りる**。
 *
 * つまり読み直しが遷移に重なると:
 *
 * - **押した先へ行かない。** 行き先を読み終えているのに捨てるので、番組表を
 *   押したのにダッシュボードのまま、といったことになる
 * - **ローディングバーが出たまま残る。** 降りる側は `navigating` を下ろさず、
 *   下ろすのは*最後まで行った*遷移だけ。読み直しは `navigating` を触らないので、
 *   誰も下ろさないまま真になり続ける
 *
 * 読み直しは知らせ (`liveUpdates`) と復帰 (`+layout.svelte`) から来る。どちらも
 * こちらの都合では鳴らないので、**いつ重なるかは運**。「削除したときローディングが
 * 消えないことがある」のはこれで、観る画面の削除は一覧へ戻る遷移 (303) を伴うぶん、
 * ちょうど重なりやすい。
 *
 * 直し方は2つ。**片方では足りない**:
 *
 * - **重ねない** (`reload`)。遷移の最中に来た読み直しは、終わってから流す。
 *   行き先の読み込みはどのみち新しいので、待たせて損は無い
 * - **遷移そのものの終わりを見る** (`moving`)。`navigating` に任せず、その遷移が
 *   持っている約束 (`complete`) が**通っても畳まれても**下ろす。
 *
 *   `reload` だけでは塞ぎきれない — **フォームの送信は SvelteKit が成功のたびに
 *   自分で `invalidateAll` を呼ぶ** (`enhance`)。こちらから呼んでいないので
 *   待たせようが無く、遷移の最中に何か送れば同じように畳まれる。行き先へ
 *   行けないのは直せないが、バーが出たきりになるのはこれで防げる
 */

/** 遷移の最中か。**畳まれた遷移でもちゃんと下りる** */
let active = $state(false);
/** 遷移の最中に来た「読み直して」。終わってから1回だけ流す */
let owed = false;

export const moving = {
    get active(): boolean {
        return active;
    },
};

function flush(): void {
    if (!owed) return;
    owed = false;
    void invalidateAll();
}

/**
 * 遷移の始まりと終わりを追う。**`+layout.svelte` から1度だけ**呼ぶ
 * (土台は画面遷移で作り直されないので、ここが全部の遷移を見ていられる)。
 */
export function followNavigation(): void {
    $effect(() => {
        const done = navigating.complete;
        if (done === null) {
            active = false;
            flush();
            return;
        }
        active = true;
        let stale = false;
        const settle = (): void => {
            // 次の遷移がもう始まっているなら、下ろすのはあちらの仕事
            if (stale) return;
            active = false;
            flush();
        };
        // 畳まれた遷移は `complete` が転ぶ。どちらでも同じように下ろす
        void done.then(settle, settle);
        return () => {
            stale = true;
        };
    });
}

/**
 * 画面を読み直す。**遷移の最中なら、終わるまで待つ。**
 *
 * 待つかどうかは `navigating` を直に見る — `active` は効果が回ってから真に
 * なるので、始まった直後の一拍を取りこぼす。
 */
export function reload(): void {
    if (navigating.complete !== null) {
        owed = true;
        return;
    }
    void invalidateAll();
}
