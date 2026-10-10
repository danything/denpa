import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eitSection, packetize, stream } from '../ts/synth';

/**
 * 半角に寄せて取り込んでいた頃の録画を、生TSの EIT から放送のとおりの幅に戻す。
 * 環境変数ではなく設定そのものを書き換えている (files.test.ts と同じ理由)
 */
const { config } = await import('./config');
const dir = mkdtempSync(join(tmpdir(), 'denpa-restore-width-'));
config.dbPath = join(dir, 'denpa.db');
config.rawDir = join(dir, 'raw');

const { orm } = await import('./db');
const { recordings, services, settings } = await import('./schema');
const { readBroadcastText, restoredText, restoreWidths, widthOf } = await import('./restore-width');

const HOUR = 3600_000;
const START = Date.UTC(2026, 9, 1, 12);

/** 放送のとおりの番組 (英数は全角、詳細の区切りは全角のコロン) */
const AIRED = {
    eventId: 77,
    startAt: START,
    duration: HOUR / 2,
    name: '［新］Ｖｅｎｕｅ１０１　＃３「ゲスト」',
    description: 'ゲストはＡＢＣ　ＤＥＦ！',
    extended: { 出演者: '司会：テスト太郎' },
};

/** その頃の取り込みが DB に入れていた形 (題名と概要だけ半角に寄せていた) */
const STORED = {
    name: '[新]Venue101 #3「ゲスト」',
    series: 'Venue101',
    subtitle: 'ゲスト',
    description: 'ゲストはABC DEF!',
    extended: { 出演者: '司会：テスト太郎' },
};

/** EIT p/f (現在と次) を流す TS。録画の頭は前の番組が「現在」で、録る番組は「次」 */
function tsFile(name: string): string {
    const pf = (sectionNumber: number, event: Parameters<typeof eitSection>[0]['events'][number]) =>
        packetize(
            0x12,
            eitSection({
                tableId: 0x4e,
                serviceId: 1024,
                transportStreamId: 0x0408,
                originalNetworkId: 0x7fe0,
                sectionNumber,
                lastSectionNumber: 1,
                events: [event],
            }),
        );
    const path = join(dir, name);
    writeFileSync(
        path,
        stream(
            pf(0, { eventId: 76, startAt: START - HOUR, duration: HOUR, name: '前の番組', runningStatus: 4 }),
            pf(1, AIRED),
        ),
    );
    return path;
}

describe('幅だけ戻す (restoredText)', () => {
    test('寄せて同じ欄を放送の字にする。作品名と副題は戻した題名から切り出す', () => {
        expect(restoredText(STORED, AIRED)).toEqual({
            name: AIRED.name,
            series: 'Ｖｅｎｕｅ１０１',
            description: AIRED.description,
        });
    });

    test('外字を文字列に開いていた頃の録画 ([新]) も、放送の字 (🈟) と揃えて戻す', () => {
        const stored = {
            ...STORED,
            name: '[新]彼方から #1「目覚め」',
            series: '彼方から',
            subtitle: '目覚め',
        };
        expect(restoredText(stored, { ...AIRED, name: '🈟彼方から　＃１「目覚め」' })).toMatchObject({
            name: '🈟彼方から　＃１「目覚め」',
        });
    });

    test('字が違う欄は触らない (録ったあとに番組表が書き換わった)', () => {
        const changed = { ...AIRED, name: '［新］Ｖｅｎｕｅ１０１　＃３「別のゲスト」' };
        expect(restoredText(STORED, changed)).toEqual({ description: AIRED.description });
    });

    test('詳細は見出しも本文も全部そろうときだけ', () => {
        const stored = { ...STORED, extended: { 出演者: '司会:テスト太郎' } };
        expect(restoredText(stored, AIRED)?.extended).toEqual({ 出演者: '司会：テスト太郎' });
        expect(restoredText({ ...stored, extended: { 出演者: '別の人' } }, AIRED)?.extended).toBeUndefined();
    });

    test('もう放送のとおりなら何もしない', () => {
        expect(
            restoredText({ ...STORED, ...AIRED, series: 'Ｖｅｎｕｅ１０１', subtitle: 'ゲスト' }, AIRED),
        ).toBeNull();
    });

    test('切り出せなければ null (切り出し方を変える前の作品名)', () => {
        expect(widthOf('Venue101 3', AIRED.name)).toBeNull();
        expect(widthOf('venue101', AIRED.name)).toBeNull();
        expect(widthOf('Venue101', AIRED.name)).toBe('Ｖｅｎｕｅ１０１');
    });
});

describe('生TSの EIT を読む (readBroadcastText)', () => {
    test('「次」として流れていた番組も event_id で拾う', async () => {
        expect(await readBroadcastText(tsFile('pf.ts'), 1024, 77, true)).toEqual({
            name: AIRED.name,
            description: AIRED.description,
            extended: AIRED.extended,
        });
    });

    test('無い番組・無いファイルは null', async () => {
        expect(await readBroadcastText(tsFile('other.ts'), 1024, 99, false)).toBeNull();
        expect(await readBroadcastText(join(dir, 'missing.ts'), 1024, 77, false)).toBeNull();
    });
});

describe('録画を見て回る (restoreWidths)', () => {
    const at = Date.now();
    const row = (id: number, ts_path: string | null, fields: Partial<typeof STORED> = {}) => ({
        id,
        program_id: (0x7fe0 * 100000 + 1024) * 100000 + 77,
        service_id: 0x7fe0 * 100000 + 1024,
        service_name: 'TOKYO MX1',
        ...STORED,
        ...fields,
        ts_path,
        library_path: join(config.encodedDir, 'Venue101', 'Venue101 - 2026-10-01 - 2100 ゲスト.mkv'),
        start_at: START,
        end_at: START + HOUR / 2,
        finished_at: START + HOUR / 2,
        created_at: at,
        updated_at: at,
    });

    test('生TSから戻す。保存先の名前は動かさない。見た録画は二度と読まない', async () => {
        orm()
            .insert(services)
            .values({
                id: 0x7fe0 * 100000 + 1024,
                service_id: 1024,
                network_id: 0x7fe0,
                name: 'TOKYO MX1',
                type: 'GR',
                service_type: 1,
                channel: 'T16',
                has_logo: false,
                updated_at: at,
            })
            .run();
        orm()
            .insert(recordings)
            .values([
                row(1, tsFile('rec1.ts')),
                // 生TSが消えたもの
                row(2, null),
                // 取り込み直された番組表から録ったもの (もう全角)
                row(3, join(dir, 'missing.ts'), { name: AIRED.name, description: AIRED.description }),
            ])
            .run();

        expect(await restoreWidths()).toEqual({ seen: 3, restored: 1, already: 1, missed: 1 });
        const [first, second] = orm().select().from(recordings).orderBy(recordings.id).all();
        expect(first).toMatchObject({
            name: AIRED.name,
            series: 'Ｖｅｎｕｅ１０１',
            subtitle: 'ゲスト',
            description: AIRED.description,
            extended: AIRED.extended,
            library_path: join(config.encodedDir, 'Venue101', 'Venue101 - 2026-10-01 - 2100 ゲスト.mkv'),
        });
        expect(second?.name).toBe(STORED.name);
        expect(orm().select().from(settings).all()).toMatchObject([
            { key: 'widthRestoredThrough', value: '3' },
        ]);

        // 2回目は何も見ない
        expect(await restoreWidths()).toEqual({ seen: 0, restored: 0, already: 0, missed: 0 });
    });

    test('録画中のものの手前で止まり、録り終えてから見る', async () => {
        orm()
            .insert(recordings)
            .values([{ ...row(4, tsFile('rec4.ts')), finished_at: null }, row(5, tsFile('rec5.ts'))])
            .run();
        expect(await restoreWidths()).toEqual({ seen: 0, restored: 0, already: 0, missed: 0 });

        orm().update(recordings).set({ finished_at: at }).run();
        expect(await restoreWidths()).toEqual({ seen: 2, restored: 2, already: 0, missed: 0 });
    });
});
