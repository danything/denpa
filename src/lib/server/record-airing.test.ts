import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

/**
 * **いま流れている番組を録る** (`recordAiring`) と、番組ごとの予約の状態 (`reservationStates`)。
 *
 * 画面のライブの録画ボタンとアプリの `POST /api/services/<id>/record` が同じものを使う。
 * `GET /api/services` の `now.reserved` / `now.recording` も `reservationStates` を読む。
 *
 * チューナーの口は手元に立てた偽物 (`tuners` を返すだけ)。予約のあとの数え直し
 * (`resolveConflicts`) がこれを読む。地上波1本にしておけば「予約はできたが録らない」(競合) も作れる
 */
const tuners = [{ types: ['GR'] }];
const agent = Bun.serve({
    port: 0,
    fetch: () =>
        Response.json({
            tuners: tuners.map((tuner, index) => ({
                index,
                name: `T${index}`,
                types: tuner.types,
                disabled: false,
                device: null,
                lnb: null,
                channel: null,
                users: [],
                pid: null,
            })),
        }),
});
afterAll(() => agent.stop(true));

const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-record-airing-')), 'denpa.db');
config.agentUrl = `http://127.0.0.1:${agent.port}`;

const { orm } = await import('./db');
const { programs, recordings, reservations, services } = await import('./schema');
const { recordAiring, reservationStates } = await import('./reservations');

const MINUTE = 60_000;
const NOW = Date.now();
const SERVICE = 3_273_701_032;
const OTHER = 3_273_601_024;

orm()
    .insert(services)
    .values([
        {
            id: SERVICE,
            service_id: 1032,
            network_id: 32_736,
            name: 'NHK総合',
            type: 'GR',
            channel: '27',
            updated_at: 0,
        },
        {
            id: OTHER,
            service_id: 1024,
            network_id: 32_736,
            name: 'NHK Eテレ',
            type: 'GR',
            channel: '26',
            updated_at: 0,
        },
    ])
    .run();

function program(id: number, startAt: number, endAt: number, name = `番組${id}`): void {
    orm()
        .insert(programs)
        .values({
            id,
            service_id: SERVICE,
            network_id: 32_736,
            event_id: id,
            start_at: startAt,
            end_at: endAt,
            name,
            updated_at: 0,
        })
        .run();
}

function reset(): void {
    orm().delete(reservations).run();
    orm().delete(recordings).run();
    orm().delete(programs).run();
}

describe('いま流れている番組を録る', () => {
    test('いまを跨ぐ番組を予約する。前後の番組は選ばない', async () => {
        reset();
        program(1, NOW - 60 * MINUTE, NOW - 10 * MINUTE);
        program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE, 'ニュース');
        program(3, NOW + 20 * MINUTE, NOW + 60 * MINUTE);

        const result = await recordAiring(SERVICE, NOW);
        expect(result).toEqual({ ok: true, programId: 2, name: 'ニュース', state: 'scheduled' });
        const rows = orm().select().from(reservations).all();
        expect(rows.map((row) => row.program_id)).toEqual([2]);
        expect(rows[0]?.manual).toBe(true);
    });

    test('2度押しても予約は1本のまま', async () => {
        reset();
        program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE);
        await recordAiring(SERVICE, NOW);
        await recordAiring(SERVICE, NOW);
        expect(orm().select().from(reservations).all()).toHaveLength(1);
    });

    test('番組表にいまの番組が無ければ 404', async () => {
        reset();
        program(3, NOW + 20 * MINUTE, NOW + 60 * MINUTE);
        expect(await recordAiring(SERVICE, NOW)).toEqual({
            ok: false,
            status: 404,
            message: 'いま流れている番組が番組表に見つかりません',
        });
        expect(orm().select().from(reservations).all()).toHaveLength(0);
    });

    test('予約できない番組は 400 と理由', async () => {
        reset();
        // 「いま」を過去に置いて引かせ、予約の側 (いまの時計) では終わっている番組にする
        program(4, NOW - 60 * MINUTE, NOW - 30 * MINUTE);
        expect(await recordAiring(SERVICE, NOW - 45 * MINUTE)).toEqual({
            ok: false,
            status: 400,
            message: 'この番組は放送が終わっています',
        });
    });

    test('チューナーが足りなければ競合として返す (予約は残る)', async () => {
        reset();
        // 地上波1本を、先に始まった別の物理チャンネルの予約が掴んでいる
        orm()
            .insert(reservations)
            .values({
                program_id: 99,
                service_id: OTHER,
                name: '先の予約',
                start_at: NOW - 20 * MINUTE,
                end_at: NOW + 40 * MINUTE,
                created_at: 0,
                updated_at: 0,
            })
            .run();
        program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE);
        expect(await recordAiring(SERVICE, NOW)).toMatchObject({ ok: true, programId: 2, state: 'conflict' });
        expect(orm().select().from(reservations).all()).toHaveLength(2);
    });
});

describe('番組ごとの予約の状態', () => {
    function reservation(
        programId: number,
        state: 'scheduled' | 'canceled',
        startedAt: number | null = null,
    ) {
        orm()
            .insert(reservations)
            .values({
                program_id: programId,
                service_id: SERVICE,
                name: `番組${programId}`,
                start_at: NOW - 10 * MINUTE,
                end_at: NOW + 20 * MINUTE,
                state,
                started_at: startedAt,
                created_at: 0,
                updated_at: 0,
            })
            .run();
        return orm().select().from(reservations).where(eq(reservations.program_id, programId)).get()!.id;
    }

    test('予約だけ・録画中・取り消し・予約無しを見分ける', () => {
        reset();
        reservation(1, 'scheduled');
        const started = reservation(2, 'scheduled', NOW - 5 * MINUTE);
        reservation(3, 'canceled');
        // 録画中 = 終わった時刻も理由も無い行 (state は生成列)
        orm()
            .insert(recordings)
            .values({
                reservation_id: started,
                program_id: 2,
                service_id: SERVICE,
                name: '番組2',
                start_at: NOW - 10 * MINUTE,
                end_at: NOW + 20 * MINUTE,
                ts_path: '/recorded/2.m2ts',
                created_at: 0,
                updated_at: 0,
            })
            .run();

        const states = reservationStates([1, 2, 3, 4]);
        expect(states.get(1)).toBe('scheduled');
        expect(states.get(2)).toBe('recording');
        expect(states.has(3)).toBe(false);
        expect(states.has(4)).toBe(false);
        expect(reservationStates([]).size).toBe(0);
    });
});
