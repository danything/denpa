import { invalidateAll } from '$app/navigation';
import { navigating } from '$app/state';

/**
 * 画面の読み直し。**走っている遷移に重ねない。**
 *
 * ## `invalidateAll` は、走っている遷移を黙って畳む
 *
 * SvelteKit は遷移にも読み直しにも同じ「いま有効な札」(`token`) を使っていて、
 * `invalidateAll()` はそれを**自分のものに書き換える**。読み込みから戻ってきた
 * 遷移は札が違うのを見て、そこで**何もせずに降りる**。
 *
 * つまり読み直しが遷移に重なると、**押した先へ行かない** — 行き先を読み終えて
 * いるのに捨てるので、番組表を押したのにダッシュボードのまま、といったことになる。
 * 「削除したあと画面が変わらないことがある」のはこれで、観る画面の削除は一覧へ
 * 戻る遷移 (303) を伴うぶん、ちょうど重なりやすい。
 *
 * 読み直しは知らせ (`liveUpdates`) と復帰 (`+layout.svelte`) から来る。どちらも
 * こちらの都合では鳴らないので、**いつ重なるかは運**。だから `reload` を通し、
 * 遷移の最中に来たものは**終わってから**流す。行き先の読み込みはどのみち新しい
 * ので、待たせて損は無い。
 *
 * ## 終わったかどうかを `navigating` に訊けない
 *
 * 畳まれた遷移は `navigating` を下ろさない — 下ろすのは*最後まで行った*遷移だけで、
 * 読み直しは `navigating` を触らない。あれを見て待っていると、持ち越した読み直しが
 * **永久に流れない**。そこで、その遷移が持っている約束 (`complete`) を見る。
 * 通っても畳まれても必ず片が付くので、持ち越しは確実に流れる。
 */

/** 遷移の最中に来た「読み直して」。終わってから1回だけ流す */
let owed = false;

function flush(): void {
    if (!owed) return;
    owed = false;
    void invalidateAll();
}

/**
 * 遷移の始まりと終わりを追う。**`+layout.svelte` から1度だけ**呼ぶ
 * (土台は画面遷移で作り直されないので、ここが全部の遷移を見ていられる)。
 *
 * これを呼んでいないと、遷移中に持ち越した読み直し (`reload`) を流す者が
 * 居なくなる。
 */
export function followNavigation(): void {
    $effect(() => {
        const done = navigating.complete;
        // 遷移していない。持ち越しがあれば、いま流す
        if (done === null) {
            flush();
            return;
        }
        let stale = false;
        // 畳まれた遷移は `complete` が転ぶ。どちらでも同じように片を付ける
        const settle = (): void => {
            // 次の遷移がもう始まっているなら、流すのはあちらが終わってから
            if (stale) return;
            flush();
        };
        void done.then(settle, settle);
        return () => {
            stale = true;
        };
    });
}

/**
 * 画面を読み直す。**遷移の最中なら、終わるまで待つ。**
 *
 * 待つかどうかは `navigating` を直に見る。ここは効果の外 (知らせのタイマー) から
 * 呼ばれるので、写し取った状態では始まった直後の一拍を取りこぼす。
 */
export function reload(): void {
    if (navigating.complete !== null) {
        owed = true;
        return;
    }
    void invalidateAll();
}
