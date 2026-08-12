import { expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ディスク残量の見張り。**境目をまたいだ一度だけ鳴らす**のが要点なので、そこを見る。
 *
 * webhook は差し替える (本物は DB とネットワークを触る)。閾値を実際の空きより
 * 上下させて「下回る/戻る」を作り、鳴った回数を数える
 */
const posted: { event: string }[] = [];
mock.module('./webhook', () => ({ notify: (payload: { event: string }) => posted.push(payload) }));

const { config } = await import('./config');
// 生TSの置き場とエンコード済みの置き場を同じ実在ディレクトリへ。重複は畳まれて1つになる
const dir = mkdtempSync(join(tmpdir(), 'denpa-disk-'));
config.recordedDir = dir;
config.libraryDir = dir;

const { checkDisk } = await import('./disk');

/** その時点の空きより大きい閾値 = 必ず「残りわずか」になる */
const HUGE = Number.MAX_SAFE_INTEGER;

test('下回ったら鳴らし、戻るまで鳴らし直さない', () => {
    posted.length = 0;

    // 下回る → 1回鳴る
    config.diskLowThreshold = HUGE;
    checkDisk();
    expect(posted.filter((p) => p.event === 'disk.low')).toHaveLength(1);

    // まだ下回ったまま → 鳴らし直さない
    checkDisk();
    checkDisk();
    expect(posted.filter((p) => p.event === 'disk.low')).toHaveLength(1);

    // 閾値より上へ戻す → 覚えを消すだけ (復帰は鳴らさない)
    config.diskLowThreshold = 1;
    checkDisk();
    expect(posted.filter((p) => p.event === 'disk.low')).toHaveLength(1);

    // 再び下回る → もう一度鳴る
    config.diskLowThreshold = HUGE;
    checkDisk();
    expect(posted.filter((p) => p.event === 'disk.low')).toHaveLength(2);
});

test('0 のときは見張らない', () => {
    posted.length = 0;
    config.diskLowThreshold = 0;
    checkDisk();
    expect(posted).toHaveLength(0);
});
