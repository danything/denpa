/**
 * 追っかけ再生の入口 — **録画中の伸びている生TSを読み続ける** (issue #16)。
 *
 * チューナーは掴まない。電波は録画が既に受けていて、ファイルに書き足されて
 * いる (`recorder.ts`)。ここはそのファイルを尻から追い読みして、ライブ視聴と
 * 同じ焼き方 (`live.ts` の Session) に流し込むだけ。何人開いてもチューナー数には
 * 響かず、増えるのは ffmpeg だけ。
 *
 * ## シークはバイト比例で当たりを付ける
 *
 * 生TSには時間→バイトの索引が無い。放送TSはレートがほぼ一定なので、
 * 「これまで録れた秒数とファイルの大きさ」からバイト/秒を出して比例で跳ぶ。
 * 188バイト (TS パケット) に揃えれば、ffmpeg は次の鍵フレームから拾い直す。
 * シークのたびに ffmpeg ごと立て直す (ライブの選局し直しと同じ流儀)。
 */

import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';

/** TS パケットの大きさ。読み出しの頭はこれに揃える (途中から読んでも同期できる) */
const PACKET = 188;

/** 1回に読む量。露骨に小さいと read の回数だけ損する */
const READ_SIZE = 256 * 1024;

/** 書き足されるのを待つ間隔 (ms)。放送は約2MB/秒なので、これで十分細かい */
const WAIT_MORE = 300;

/**
 * 送り込みの上限 — **実時間の倍速まで。**
 *
 * ffmpeg はファイルなら実時間の数倍で焼けるが、そのまま流すと観る側の
 * MSE バッファが際限なく太り (30分の後追いで数百MB)、ブラウザの持ち分を
 * 超えて追記が断られる。倍速なら「観ている先」は常に伸び続け、しかも
 * 観る側に溜まるのは観た速さとの差だけで済む
 */
const PACE = 2;

export interface ChasePlan {
    /** 読み始めるバイト位置 (188 に揃えてある) */
    offset: number;
    /** 実際に始まる再生位置 (秒)。頼まれた位置を録れている範囲に収めた後 */
    at: number;
    /** いま録れている長さ (秒)。シークバーの右端 */
    recordedSec: number;
    /** 送り込みの上限 (バイト/秒)。実測レート × PACE */
    paceBytesPerSec: number;
}

/**
 * どこから読み始めるかを決める。
 *
 * @param size いまのファイルの大きさ (バイト)
 * @param recordedSec いま録れている長さ (秒)。録画中は「録り始めてからの経過」
 * @param atSec 頼まれた再生位置 (秒)
 */
export function chasePlan(size: number, recordedSec: number, atSec: number): ChasePlan {
    const usable = Math.max(1, recordedSec);
    const bytesPerSec = size / usable;
    /*
     * 生の際 (いま書いているところ) ぎりぎりから始めると、鍵フレーム待ちで
     * 何も出ないまま追い付いてしまう。少し手前に置く
     */
    const at = Math.min(Math.max(0, atSec), Math.max(0, usable - 5));
    const offset = Math.floor((at * bytesPerSec) / PACKET) * PACKET;
    return {
        offset: Math.min(offset, Math.max(0, size - PACKET)),
        at,
        recordedSec: usable,
        paceBytesPerSec: Math.max(1_000_000, bytesPerSec) * PACE,
    };
}

/**
 * 伸びているファイルを読み続ける口。
 *
 * 尻 (EOF) に着いたら書き足されるのを待って読み足す。**録画が終わっていて**
 * 尻に着いたら、それが本当の終わり。
 *
 * @param done もう書き足されないか (録画が終わったか)。EOF のたびに訊く
 */
export function followFile(
    path: string,
    offset: number,
    paceBytesPerSec: number,
    done: () => boolean,
): ReadableStream<Uint8Array> {
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            const started = Date.now();
            let sent = 0;
            let position = offset;
            const handle = await open(path, 'r');
            try {
                const buffer = new Uint8Array(READ_SIZE);
                while (!cancelled) {
                    const { bytesRead } = await handle.read(buffer, 0, READ_SIZE, position);
                    if (bytesRead > 0) {
                        position += bytesRead;
                        sent += bytesRead;
                        controller.enqueue(buffer.slice(0, bytesRead));
                        // 倍速より先へは行かない (上の説明)。遅れているぶんは眠らず進む
                        const ahead = sent / paceBytesPerSec - (Date.now() - started) / 1000;
                        if (ahead > 0) await sleep(ahead * 1000);
                        continue;
                    }
                    // 尻に着いた。録画が終わっていれば読み切った、まだなら待って読み足す
                    if (done()) break;
                    await sleep(WAIT_MORE);
                }
                controller.close();
            } catch (error) {
                controller.error(error);
            } finally {
                await handle.close();
            }
        },
        cancel() {
            cancelled = true;
        },
    });
}

/** いまのファイルの大きさ。無ければ null (消された・まだ書き始めていない) */
export function fileSize(path: string): number | null {
    try {
        return statSync(path).size;
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
