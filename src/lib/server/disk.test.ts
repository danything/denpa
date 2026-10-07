import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
config.rawDir = dir;
config.encodedDir = dir;
config.dbPath = join(dir, 'denpa.db');

const { capacity, checkDisk } = await import('./disk');
const { orm } = await import('./db');
const { recordings } = await import('./schema');

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

/**
 * 録画の見出しに出す空きと残り時間 (`capacity`)。時間は**最近の録画が1時間あたりに
 * 置いていった量**で割る。残した生TSも足す
 */
describe('空きと残り時間', () => {
    const HOUR = 3_600_000;
    const GB = 1024 ** 3;
    const row = (id: number, extra: Partial<typeof recordings.$inferInsert> = {}) => ({
        id,
        service_id: 1,
        name: `番組${id}`,
        start_at: id * HOUR,
        end_at: (id + 1) * HOUR,
        finished_at: (id + 1) * HOUR,
        duration_ms: HOUR,
        ts_size: GB,
        library_path: join(dir, `${id}.mkv`),
        created_at: 0,
        updated_at: 0,
        ...extra,
    });

    test('本数が足りなければ空きだけ', () => {
        orm().delete(recordings).run();
        orm()
            .insert(recordings)
            .values([row(1), row(2)])
            .run();
        const room = capacity();
        expect(room?.free).toBeGreaterThan(0);
        expect(room?.hours).toBeNull();
    });

    test('1時間あたりの量で空きを割る。残した生TSも数え、消したものと短いものは数えない', () => {
        orm().delete(recordings).run();
        // 1本は生TSも残している (焼いた 1GB + 生TS 3GB)
        const raw = join(dir, 'kept.ts');
        writeFileSync(raw, Buffer.alloc(3 * 1024));
        orm()
            .insert(recordings)
            .values([
                row(1),
                row(2),
                row(3, { ts_path: raw, ts_size: GB - 3 * 1024 }),
                row(4, { deleted_at: 1, ts_size: 100 * GB }),
                row(5, { duration_ms: 60_000, ts_size: 100 * GB }),
            ])
            .run();
        const room = capacity()!;
        // 3時間で 3GB (生TSのぶんは ts_size から引いてあるので、足して 3GB ちょうど)
        expect(room.hours).toBeCloseTo(room.free / GB, 5);
    });
});
