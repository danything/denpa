import { statfsSync } from 'node:fs';
import { config } from './config';
import { notify } from './webhook';

/**
 * ディスクの残量を見張る。**録画が全部失敗して初めて気付く、を防ぐ。**
 *
 * 保存先が埋まると、始まる録画が片っ端から書けずに失敗する。埋まってからでは
 * 遅いので、残量が閾値を下回ったところで一度だけ知らせる。照合と同じ周期で回す
 * (`runtime.ts`)。
 *
 * **境目をまたいだ一度だけ鳴らす。** 毎周期ごとに鳴らすと、空けるまで数分おきに
 * 通知が飛び続ける。下回った置き場を覚えておいて、戻ったら忘れる (次に下回れば
 * また鳴る)。録画の外側の話なので、録画を止めたり消したりは一切しない — 見張って
 * 教えるだけ。
 */

/** いま「残りわずか」を知らせ済みの置き場。またぐたびに1回だけ鳴らすための覚え */
const warned = new Set<string>();

/** その置き場の空きバイト数。読めなければ null (統計が取れない環境もある) */
function freeBytes(dir: string): number | null {
    try {
        const stat = statfsSync(dir);
        return stat.bsize * stat.bavail;
    } catch {
        return null;
    }
}

function gib(bytes: number): string {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

/** 監視する置き場。生TSの作業領域とエンコード済みの保存先 */
function watched(): string[] {
    // 同じパーティションに載っていることもあるので重複は畳む
    return [...new Set([config.recordedDir, config.libraryDir])];
}

export function checkDisk(): void {
    if (config.diskLowThreshold <= 0) return;

    for (const dir of watched()) {
        const free = freeBytes(dir);
        if (free === null) continue;

        if (free < config.diskLowThreshold) {
            // すでに知らせてある置き場は、空けるまで黙る
            if (warned.has(dir)) continue;
            warned.add(dir);
            console.warn(`[disk] 残量わずか: ${dir} (残り ${gib(free)})`);
            notify({
                event: 'disk.low',
                text: `ディスクの残りがわずかです: ${dir} (残り ${gib(free)} / 閾値 ${gib(config.diskLowThreshold)})`,
            });
        } else if (warned.has(dir)) {
            // 閾値より上へ戻った。覚えを消して、次に下回ればまた鳴らす
            warned.delete(dir);
            console.log(`[disk] 残量が戻りました: ${dir} (残り ${gib(free)})`);
        }
    }
}
