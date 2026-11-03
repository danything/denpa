/**
 * サーバへ取りに行く。**繋がらないと分かっていれば待たず、返事が来なければ見切る。**
 * サービスワーカーが画面とオフラインの入口のデータを取るのに使う (`service-worker/index.ts`)。
 *
 * iPhone の Safari は機内モードで、取りに行ったものが失敗せずに返事待ちのまま止まることがあり、
 * 入口へ移れずにいつまでも読み込み中になっていた。見切るのは次の場合だけ。
 *
 * - 端末が繋がっていないと言っている (`online()` が false)。取りに行かず、すぐ見切る。
 *   この状態は覚えない。繋がり直して `online()` が true に戻れば、次からすぐ取りに行く
 * - 応答のヘッダが `wait` のあいだ届かない。ヘッダが届いたあとの本体は待たない
 *   (遅い画面でも、ヘッダが届けば見切らない)
 *
 * **後者で見切ったあとは `giveUpFor` のあいだだけ取りに行かない。** 開いた画面 → 入口へ移る →
 * 入口のデータ、と続けて取りに行くので、毎回待つと `wait` を 3 回待たせてしまう。
 * 長く覚えるとサーバが遅かっただけのときに、ほかの画面まで開けなくなるので短くする。
 * 応答が 1 つ届いたとき、または `reset()` (繋がり直した知らせ) で、すぐ忘れる。
 */
export interface Reach {
  /** `request` を取りに行く。見切ったら reject する */
  (request: Request): Promise<Response>;
  /** 見切った記憶を捨てる。繋がり直した知らせで呼ぶ */
  reset(): void;
}

export interface ReachOptions {
  /** 実際に取りに行く。`signal` は見切ったときに abort する */
  fetch(request: Request, signal: AbortSignal): Promise<Response>;
  /** 端末が繋がっていると言っているか (`navigator.onLine`) */
  online(): boolean;
  /** ヘッダを待つ時間 (ms) */
  wait: number;
  /** 返事が無くて見切ったあと、取りに行かない時間 (ms) */
  giveUpFor: number;
  /** 時計 (ms)。試験で差し替える */
  now?: () => number;
}

export function reach(options: ReachOptions): Reach {
  const now = options.now ?? Date.now;
  let blockedUntil = 0;

  const run = (request: Request): Promise<Response> => {
    if (!options.online()) return Promise.reject(new Error("オフラインです"));
    if (now() < blockedUntil)
      return Promise.reject(new Error("さっき返事がありませんでした"));
    return new Promise((resolve, reject) => {
      const control = new AbortController();
      const timer = setTimeout(() => {
        blockedUntil = now() + options.giveUpFor;
        control.abort();
        reject(new Error("返事がありません"));
      }, options.wait);
      options.fetch(request, control.signal).then(
        (response) => {
          clearTimeout(timer);
          blockedUntil = 0;
          resolve(response);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  };

  return Object.assign(run, {
    reset: () => {
      blockedUntil = 0;
    },
  });
}
