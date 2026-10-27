import { refreshAll } from "$app/navigation";
import { navigating } from "$app/state";

/**
 * 画面の読み直し。**走っている遷移に重ねない。**
 *
 * 読み直しは通知 (`liveUpdates`) と復帰 (`+layout.svelte`) から来るので、いつ遷移に重なるかは運。
 * 遷移の最中に来たものは、終わってから 1 回だけ流す (行き先はどのみち新しく読むので、待たせて損は無い)。
 * SvelteKit 2 の `invalidateAll` は走っている遷移を黙って畳んでいた (押した先へ行かない) のでこうした。
 * 3 の `refreshAll` は畳まないが、重ねる理由も無いので残してある
 *
 * 終わったかどうかは `navigating` ではなく、その遷移の約束 (`complete`) で見る。
 * 畳まれた遷移は `navigating` を下ろさないが、`complete` は通っても畳まれても必ず片が付く
 */

/** 遷移の最中に来た「読み直して」。終わってから1回だけ流す */
let owed = false;

function flush(): void {
  if (!owed) return;
  owed = false;
  void refreshAll();
}

/**
 * 遷移の始まりと終わりを追う。**`+layout.svelte` から1度だけ**呼ぶ
 * (土台は画面遷移で作り直されないので、ここが全部の遷移を見ていられる)。
 *
 * これを呼んでいないと、遷移中に持ち越した読み直し (`reload`) を流す者が
 * いなくなる。
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
 * 待つかどうかは `navigating` を直に見る。ここは効果の外 (通知のタイマー) から
 * 呼ばれるので、写し取った状態では始まった直後の一拍を取りこぼす。
 */
export function reload(): void {
  if (navigating.complete !== null) {
    owed = true;
    return;
  }
  void refreshAll();
}
