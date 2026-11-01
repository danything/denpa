/**
 * **起動の途中に来た止まれの合図 (SIGTERM・SIGINT) を取っておく。** 入口 (`server.js`) が
 * いちばん先に読む。アプリ (`runtime.ts` の `installShutdownHooks`) が合図を引き取るときに、
 * 取っておいたものがあれば受け直す。
 *
 * **コンテナの中で denpa は PID 1 で動く** (Dockerfile の `CMD ["bun", "./server.js"]`)。
 * PID 1 には、受け取る手続きを登録していない合図をカーネルが届けない — 既定の「終わる」も起きず、
 * 黙って捨てられる。アプリが引き取るのは `build/index.js` を読み、DB を開き、前回の録画を
 * 拾ったあとなので、その間に Pod の入れ替えが始まると SIGTERM が消え、
 * `terminationGracePeriodSeconds` (6時間) を使い切るまで Pod が降りなかった (2026-11-01)。
 *
 * ここでは**覚えるだけで何もしない。** 起動の途中で落とすと、拾い直した録画を待たずに
 * 止まってしまう。待つかどうかはアプリが決める (録画が無ければすぐ止まる)。
 *
 * 入口とアプリは別々に読まれる (アプリは `build/` に束ねられる) ので、`globalThis` に置いて渡す。
 * 何も import しない — 読み込みに時間を掛けないため
 */

/** `runtime.ts` が見る名前。あちらと揃えること */
const HELD = "__denpaHeldSignal";

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    const global = globalThis as Record<string, unknown>;
    // 先に来たほうを覚える。2度目からは何もしない
    global[HELD] ??= signal;
    console.log(
      `[boot] 起動の途中で ${signal} を受けました。起動を終えてから止まります`,
    );
  });
}
