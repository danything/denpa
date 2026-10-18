import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** ルールの一覧 (`/rules`) の行と、上に出す数 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-rule-list-')), 'denpa.db');

const { now, orm } = await import('./db');
const { listRules, ruleSummary } = await import('./rule-list');
const { recordings, reservations, rules, services } = await import('./schema');

const MX = 3239123608;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function clear(): void {
    orm().delete(recordings).run();
    orm().delete(reservations).run();
    orm().delete(rules).run();
    orm().delete(services).run();
}
afterAll(clear);

beforeEach(() => {
    clear();
    orm()
        .insert(services)
        .values({
            id: MX,
            service_id: 23608,
            network_id: 32391,
            name: 'TOKYO MX1',
            type: 'GR',
            service_type: 1,
            channel: 'T16',
            updated_at: now(),
        })
        .run();
    orm()
        .insert(rules)
        .values([
            { id: 1, name: 'アニメ', keyword: 'アニメ', enabled: true, created_at: now() },
            { id: 2, name: '止めた', keyword: '止めた', enabled: false, created_at: now() },
        ])
        .run();
});

let programId = 1;
function reserve(
    rule: number | null,
    startsIn: number,
    state: 'scheduled' | 'conflict' | 'canceled' = 'scheduled',
) {
    const start = now() + startsIn;
    return orm()
        .insert(reservations)
        .values({
            program_id: programId++,
            rule_id: rule,
            service_id: MX,
            name: 'アニメ',
            description: '',
            start_at: start,
            end_at: start + HOUR,
            priority: 1,
            manual: rule === null,
            state,
            // 過去の放送は録り始めたもの (これから録る数には入らない)
            started_at: startsIn < 0 ? start : null,
            created_at: now(),
            updated_at: now(),
        })
        .returning({ id: reservations.id })
        .get()!.id;
}

function record(reservation: number, startsIn: number, state: 'available' | 'failed' = 'available') {
    const start = now() + startsIn;
    orm()
        .insert(recordings)
        .values({
            reservation_id: reservation,
            service_id: MX,
            service_name: 'TOKYO MX1',
            name: 'アニメ',
            start_at: start,
            end_at: start + HOUR,
            // 状態は生成列。失敗は error、録り終えたものは finished_at から決まる
            ...(state === 'failed' ? { error: '失敗' } : { finished_at: start + HOUR }),
            created_at: now(),
            updated_at: now(),
        })
        .run();
}

describe('ルールの一覧', () => {
    test('予約・競合・次の放送・録画・最後に録れた日を行ごとに数える', () => {
        reserve(1, 5 * HOUR);
        reserve(1, 2 * HOUR, 'conflict');
        reserve(1, 3 * HOUR, 'canceled');
        record(reserve(1, -2 * DAY, 'scheduled'), -2 * DAY);
        record(reserve(1, -1 * DAY, 'scheduled'), -1 * DAY, 'failed');

        const [anime, stopped] = [...listRules()].sort((a, b) => a.id - b.id);
        // これから録るのは 5h と 2h (競合)。取り消したものと録り始めたものは数えない
        expect(anime?.reservations).toBe(2);
        expect(anime?.conflicts).toBe(1);
        expect(anime?.next?.start_at).toBeLessThan(now() + 3 * HOUR);
        expect(anime?.recordings).toBe(1);
        expect(anime?.last_recorded_at).not.toBeNull();
        expect(anime?.next?.service_name).toBe('TOKYO MX1');
        expect(stopped).toMatchObject({
            enabled: false,
            reservations: 0,
            conflicts: 0,
            next: null,
            recordings: 0,
        });
    });

    test('上の数は、これから7日の予約とこの7日に録れた本数', () => {
        reserve(1, 5 * HOUR);
        reserve(null, 2 * DAY);
        reserve(1, 9 * DAY);
        record(reserve(1, -2 * DAY), -2 * DAY);
        record(reserve(1, -10 * DAY), -10 * DAY);
        record(reserve(1, -1 * DAY), -1 * DAY, 'failed');
        expect(ruleSummary()).toEqual({ weekReservations: 2, lastWeekRecordings: 1 });
    });
});
