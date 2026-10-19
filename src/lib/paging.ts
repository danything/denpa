/*
 * ---- 少しずつ出す一覧の行数 (`Paged`) ----
 * 数えるだけの所はここに置いて単体テストで見る (`Paged` は `$state` を持つので bun のテストでは動かない)
 */

/** 続きを足したあとの行数。全体を越えない */
export function revealed(shown: number, step: number, length: number): number {
    return Math.min(length, shown + step);
}

/**
 * 頭から `count` 行目までは出すときの行数。開いたときに映したい行が、まだ描いていない所にあるとき。
 * 足す単位 (`step`) に切り上げ (下端の印が、すぐまた鳴らないように)、全体を越えず、いま出している数より減らさない
 */
export function shownUpTo(shown: number, count: number, step: number, length: number): number {
    return Math.min(length, Math.max(shown, Math.ceil(count / step) * step));
}
