import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';

/**
 * 旧レイアウト (Season フォルダ + episodedetails + `-thumb.jpg`) をいまの形
 * (`シリーズ/… .mkv` + `-poster.jpg`、NFOなし) へ移す。**本物を動かす。**
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-relayout-')), 'denpa.db');
config.libraryDir = mkdtempSync(join(tmpdir(), 'denpa-relayout-lib-'));

const { orm } = await import('./db');
const { recordings } = await import('./schema');
const { relayoutLibrary } = await import('./relayout');

const START = new Date(2026, 7, 12, 0, 0).getTime();

function put(rel: string, content = 'x'): string {
    const path = join(config.libraryDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
}

const DEFAULTS = {
    id: 1,
    service_name: 'テレ東',
    name: '番組',
    series: '番組',
    subtitle: '',
    description: '概要',
    start_at: START,
    library_path: null as string | null,
    alt_path: null as string | null,
};

function insert(over: Partial<typeof DEFAULTS>): void {
    const row = { ...DEFAULTS, ...over };
    orm()
        .insert(recordings)
        .values({
            id: row.id,
            service_id: 1,
            service_name: row.service_name,
            name: row.name,
            series: row.series,
            subtitle: row.subtitle,
            description: row.description,
            start_at: row.start_at,
            end_at: row.start_at,
            finished_at: row.start_at,
            library_path: row.library_path,
            alt_path: row.alt_path,
            created_at: 0,
            updated_at: 0,
        })
        .run();
}

function reset(): void {
    orm().delete(recordings).run();
    // 実体もまっさらに戻す (テストは同じ libraryDir を使い回すので、前のテストの
    // 残りが「新しい置き場が既に埋まっている」= 衝突として効いてしまう)
    rmSync(config.libraryDir, { recursive: true, force: true });
    mkdirSync(config.libraryDir, { recursive: true });
}

function libPath(id: number): { lib: string | null; alt: string | null } {
    return orm()
        .select({ lib: recordings.library_path, alt: recordings.alt_path })
        .from(recordings)
        .where(eq(recordings.id, id))
        .get()!;
}

const OLD_DIR = '番組/Season 2026';

describe('relayoutLibrary', () => {
    test('Season フォルダ・episodedetails・-thumb.jpg を映画型へ移す', () => {
        reset();
        const av1 = put(`${OLD_DIR}/番組 - 2026-08-12 - 0000.mkv`);
        put(`${OLD_DIR}/番組 - 2026-08-12 - 0000.nfo`, '<episodedetails/>');
        put(`${OLD_DIR}/番組 - 2026-08-12 - 0000-thumb.jpg`, 'jpg');
        put(`${OLD_DIR}/番組 - 2026-08-12 - 0000.bml.jsonl`, 'bml');
        put('番組/tvshow.nfo', '<tvshow/>');
        insert({ id: 1, library_path: av1 });

        relayoutLibrary();

        const newBase = join(config.libraryDir, '番組/番組 - 2026-08-12 - 0000');
        // 本体は Season を抜けて上がる
        expect(libPath(1).lib).toBe(`${newBase}.mkv`);
        expect(existsSync(`${newBase}.mkv`)).toBe(true);
        // サムネは -poster.jpg に化ける
        expect(existsSync(`${newBase}-poster.jpg`)).toBe(true);
        expect(existsSync(`${newBase}-thumb.jpg`)).toBe(false);
        // データ放送ログは連れていく
        expect(existsSync(`${newBase}.bml.jsonl`)).toBe(true);
        // NFO はもう書かない (旧いのを捨てるだけ)
        expect(existsSync(`${newBase}.nfo`)).toBe(false);
        // 旧 Season フォルダと tvshow.nfo は残さない
        expect(existsSync(join(config.libraryDir, OLD_DIR))).toBe(false);
        expect(existsSync(join(config.libraryDir, '番組/tvshow.nfo'))).toBe(false);
    });

    test('命名規則が変わる前の素名はぐれ (孤児) を旧フォルダごと片付ける', () => {
        reset();
        // 主は [1] 付き。素名の同一録画が孤児として旧フォルダに残っている
        const av1 = put(`${OLD_DIR}/番組 - 2026-08-12 - 0000 [1].mkv`);
        put(`${OLD_DIR}/番組 - 2026-08-12 - 0000.mkv`, 'orphan'); // 孤児 (どの列も指さない)
        insert({ id: 1, library_path: av1 });

        relayoutLibrary();

        // 孤児は消え、旧フォルダも畳まれ、本体はきれいな素名で上がる
        expect(existsSync(join(config.libraryDir, OLD_DIR))).toBe(false);
        expect(libPath(1).lib).toBe(join(config.libraryDir, '番組/番組 - 2026-08-12 - 0000.mkv'));
    });

    test('両コーデック: 両方を移し、もう一方(H264)にもポスターを付ける', () => {
        reset();
        const av1 = put(`${OLD_DIR}/番組 - 2026-08-12 - 0000.mkv`);
        const h264 = put(`${OLD_DIR}/番組 - 2026-08-12 - 0000 [H264].mkv`);
        put(`${OLD_DIR}/番組 - 2026-08-12 - 0000-thumb.jpg`, 'jpg');
        insert({ id: 1, library_path: av1, alt_path: h264 });

        relayoutLibrary();

        const row = libPath(1);
        const altBase = join(config.libraryDir, '番組/番組 - 2026-08-12 - 0000 [H264]');
        expect(row.lib).toBe(join(config.libraryDir, '番組/番組 - 2026-08-12 - 0000.mkv'));
        expect(row.alt).toBe(`${altBase}.mkv`);
        expect(existsSync(row.lib as string)).toBe(true);
        expect(existsSync(row.alt as string)).toBe(true);
        // もう一方にもポスター (主を消して繰り上がっても画面のサムネが途切れない)
        expect(existsSync(`${altBase}-poster.jpg`)).toBe(true);
    });

    test('既に新しい形でも、もう一方にポスターが無ければ補う', () => {
        reset();
        const av1 = put('番組/番組 - 2026-08-12 - 0000.mkv');
        put('番組/番組 - 2026-08-12 - 0000-poster.jpg', 'jpg');
        const h264 = put('番組/番組 - 2026-08-12 - 0000 [H264].mkv'); // ポスターなしの裸ファイル
        insert({ id: 1, library_path: av1, alt_path: h264 });

        relayoutLibrary();

        const altBase = join(config.libraryDir, '番組/番組 - 2026-08-12 - 0000 [H264]');
        expect(existsSync(`${altBase}-poster.jpg`)).toBe(true);
        // 本体は動かさない (既に新しい形)
        expect(libPath(1).lib).toBe(av1);
    });

    test('書かなくなった .nfo が残っていれば片付ける', () => {
        reset();
        const av1 = put('番組/番組 - 2026-08-12 - 0000.mkv');
        const nfo = put('番組/番組 - 2026-08-12 - 0000.nfo', '<movie/>');
        insert({ id: 1, library_path: av1 });

        relayoutLibrary();

        expect(existsSync(nfo)).toBe(false);
        expect(existsSync(av1)).toBe(true);
    });

    test('他の録画が使っている置き場所は巻き添えにしない', () => {
        reset();
        const av1 = put(`${OLD_DIR}/番組 - 2026-08-12 - 0000 [1].mkv`);
        // 素名は別の録画 (id 2) のもの。id 1 の掃除で孤児と間違えて消さない
        const others = put(`${OLD_DIR}/番組 - 2026-08-12 - 0000.mkv`, 'others');
        insert({ id: 1, library_path: av1 });
        insert({ id: 2, library_path: others });

        relayoutLibrary();

        // id 2 の中身は失われていない (置き場は移るが、消されずに移し替えられる)
        const moved = libPath(2).lib as string;
        expect(existsSync(moved)).toBe(true);
        expect(readFileSync(moved, 'utf8')).toBe('others');
    });

    test('既に新しい形の録画は動かさない (二度がけしても安全)', () => {
        reset();
        const av1 = put('番組/番組 - 2026-08-12 - 0000.mkv');
        insert({ id: 1, library_path: av1 });

        relayoutLibrary();
        relayoutLibrary();

        expect(libPath(1).lib).toBe(av1);
        expect(existsSync(av1)).toBe(true);
    });
});
