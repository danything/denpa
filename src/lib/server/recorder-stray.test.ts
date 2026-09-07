import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

/**
 * 持ち主の居ない「録画中」を畳むところ。
 *
 * 掴んでいる録画はプロセスの中にしか無い (`active`) ので、**畳む間もなく殺される**と
 * DB の行だけが録画中で残る。その行は**予約の一覧に居座り、録画の一覧には出てこない**
 * (どちらの振り分けも `recordings.state = 'recording'` で決まる) ので、放送が終わって
 * いるものは失敗に倒す。
 *
 * 環境変数ではなく設定そのものを書き換えている (files.test.ts と同じ理由)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-stray-')), 'denpa.db');
config.endMargin = 15_000;

const { orm } = await import('./db');
const { recordings } = await import('./schema');
const { failStrayRecordings } = await import('./recorder');

const MINUTE = 60_000;
/** 終了時刻を過ぎてから畳むまでの猶予 (recorder.ts の STRAY_GRACE) */
const GRACE = MINUTE;
/** 基準の時刻。番組はこれより前に終わっている */
const NOW = Date.UTC(2026, 8, 7, 3, 0, 0);

/** 前の試験の行を持って帰る。残っていると次の試験がそれを畳んでしまう */
function reset(): void {
    orm().delete(recordings).run();
}

/** 録画中の行を1つ置く。**終わった時刻も理由も入れない** = 録画中 (state は生成列) */
function recording(id: number, endAt: number, recordTo: number | null = null): void {
    orm()
        .insert(recordings)
        .values({
            id,
            service_id: 1,
            name: `番組${id}`,
            start_at: endAt - 30 * MINUTE,
            end_at: endAt,
            record_to: recordTo,
            ts_path: `/recorded/${id}.m2ts`,
            created_at: 0,
            updated_at: 0,
        })
        .run();
}

const rowOf = (id: number) =>
    orm()
        .select({
            state: recordings.state,
            error: recordings.error,
            finished_at: recordings.finished_at,
        })
        .from(recordings)
        .where(eq(recordings.id, id))
        .get()!;

describe('持ち主の居ない録画を畳む', () => {
    test('終了時刻も猶予も過ぎていれば失敗にする。終わった時刻も入る', () => {
        reset();
        recording(1, NOW - 10 * MINUTE);

        expect(failStrayRecordings(NOW)).toBe(1);
        const row = rowOf(1);
        expect(row.state).toBe('failed');
        expect(row.error).toBe('録画が中断されたまま終了時刻を過ぎました');
        // 終わった時刻が入らないと、いつまでのぶんが録れているのか読めない
        expect(row.finished_at).not.toBeNull();

        // 二度目は何もしない (もう録画中ではない)
        expect(failStrayRecordings(NOW)).toBe(0);
    });

    /*
     * **掴んでいるものに手を出さない。** ここを外すと、走っている録画が
     * 見回りのたびに失敗へ倒される (放送は二度と来ない)
     */
    test('掴んでいるものには触らない', () => {
        reset();
        recording(2, NOW - 10 * MINUTE);

        expect(failStrayRecordings(NOW, new Set([2]))).toBe(0);
        expect(rowOf(2).state).toBe('recording');
    });

    test('まだ放送中のものには触らない', () => {
        reset();
        recording(3, NOW + 10 * MINUTE);

        expect(failStrayRecordings(NOW)).toBe(0);
        expect(rowOf(3).state).toBe('recording');
    });

    /*
     * 止めてから終わりを書くまでの間に畳まない。実際には続けて終わるので重ならないが、
     * 急いで畳んで得るものが無い
     */
    test('終了時刻を過ぎていても、猶予の内は触らない', () => {
        // 終わりのマージンは過ぎたが、猶予はまだ
        reset();
        recording(4, NOW - config.endMargin - GRACE / 2);

        expect(failStrayRecordings(NOW)).toBe(0);
        expect(rowOf(4).state).toBe('recording');
    });

    /*
     * **尻を譲っていればそこまで** (`record_to`)。番組の終わりを待つと、
     * 次の録画に渡したはずのチューナーぶん長く「録画中」が残る
     */
    test('尻を譲っているものは、譲った時刻で見る', () => {
        // 番組はまだ続いているが、譲った時刻はとうに過ぎている
        reset();
        recording(5, NOW + 30 * MINUTE, NOW - 10 * MINUTE);

        expect(failStrayRecordings(NOW)).toBe(1);
        expect(rowOf(5).state).toBe('failed');
    });
});
