/**
 * SIGTERM を受けて、録画が終わるまで居座っている最中か (runtime.ts の drain)。
 *
 * 居座りの間も始まる録画は始める (始めないでいた頃は番組の頭が丸ごと落ちた。
 * `scheduler.ts`) ので、この印は止めるためではなく、記録に「止まる途中で始めた」と
 * 書くためだけにある — なぜ入れ替えが降りてこないのかを外から読めるように。
 *
 * 別モジュールなのは、runtime と scheduler の読み込みが輪にならないため。
 */

let draining = false;

export function beginDraining(): void {
    draining = true;
}

export function isDraining(): boolean {
    return draining;
}
