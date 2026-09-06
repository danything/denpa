import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq, sql } from 'drizzle-orm';

/**
 * 古い履歴の片付け。
 *
 * 本物の pruneHistory を動かす。DBの置き場は一時ファイルへ向ける。
 *
 * 環境変数ではなく設定そのものを書き換えている。環境変数は config の
 * 読み込み時に1度だけ見られるので、同じプロセスで走る別のテストが先に
 * config を読んでいると効かない (bun test はファイルをまたいでモジュールを使い回す)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-files-')), 'denpa.db');
config.historyRetention = 14 * 24 * 60 * 60 * 1000;

const { orm } = await import('./db');
const { encodeJobs, recordings, reservations } = await import('./schema');
const { pruneHistory, reconcile } = await import('./files');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function seed(): void {
    orm().delete(reservations).run();
    orm().delete(recordings).run();
    orm().delete(encodeJobs).run();

    /*
     * 「終わった予約」は取り消し・録り逃しか、録り始めたもの (started_at が入る)。
     * 予約の行に 'done' や 'failed' は入らない — 顛末は録画の行が持っている
     */
    const reservation = (
        id: number,
        name: string,
        at: number,
        state: 'scheduled' | 'canceled',
        started_at: number | null,
    ) => ({
        id,
        program_id: id,
        service_id: 1,
        name,
        start_at: at,
        end_at: at,
        state,
        started_at,
        created_at: now,
        updated_at: now,
    });
    orm()
        .insert(reservations)
        .values([
            reservation(1, '古い完了', now - 30 * DAY, 'scheduled', now - 30 * DAY),
            reservation(2, '古い取り消し', now - 30 * DAY, 'canceled', null),
            reservation(3, 'これから', now + DAY, 'scheduled', null),
            reservation(4, '最近の完了', now - DAY, 'scheduled', now - DAY),
        ])
        .run();

    // state は生成列なので入れられない。録り終えた時刻と保存先で「視聴可能」になる
    const recording = (id: number, name: string, at: number, deleted_at: number | null) => ({
        id,
        service_id: 1,
        name,
        start_at: at,
        end_at: at,
        finished_at: at,
        library_path: '/library/x.mkv',
        deleted_at,
        created_at: now,
        updated_at: now,
    });
    orm()
        .insert(recordings)
        .values([
            recording(1, '古い削除済み', now - 30 * DAY, now - 30 * DAY),
            recording(2, '最近の削除済み', now - DAY, now - DAY),
            recording(3, '残っている録画', now - 30 * DAY, null),
        ])
        .run();

    const job = (id: number, recording_id: number, state: 'done' | 'failed', at: number) => ({
        id,
        recording_id,
        state,
        created_at: at,
        finished_at: at,
    });
    orm()
        .insert(encodeJobs)
        .values([
            // 消える録画にぶら下がっているもの
            job(1, 1, 'done', now),
            // 残る録画の、古い失敗と新しい成功。古いほうだけ消えて、最新は残る
            job(2, 3, 'failed', now - 30 * DAY),
            job(3, 3, 'done', now - 30 * DAY),
        ])
        .run();
}

const ids = (table: typeof reservations | typeof recordings | typeof encodeJobs) =>
    orm()
        .select({ id: sql<number>`id` })
        .from(table)
        .orderBy(sql`id`)
        .all()
        .map((row) => row.id);

describe('古い履歴の片付け', () => {
    test('2週間より古い「終わったもの」だけ消える', () => {
        seed();
        expect(pruneHistory()).toEqual({ reservations: 2, recordings: 1, jobs: 1 });
        // 残るのは「これから」と最近のもの
        expect(ids(reservations)).toEqual([3, 4]);
        // ファイルが残っている録画は、古くても消さない
        expect(ids(recordings)).toEqual([2, 3]);
    });

    test('録画の行と一緒にエンコードの記録も消える', () => {
        seed();
        pruneHistory();
        // 1 は録画ごと消えた。2 は古い失敗なので消える。
        // 3 はその録画の最新なので、古くても残す (一覧の状態表示がこれを見ている)
        expect(ids(encodeJobs)).toEqual([3]);
    });

    test('何度やっても同じ', () => {
        seed();
        pruneHistory();
        expect(pruneHistory()).toEqual({ reservations: 0, recordings: 0, jobs: 0 });
    });
});

/**
 * 実体との照合。**両方向を見る。**
 *
 * 行はあるが実体が無いものは削除済みに倒す。逆に、動画が消えたあとに残った
 * 付き添い (索引・NFO・サムネイル) は片付ける。**動画そのものには触らない** —
 * 手で置いたものかもしれないので、数えるだけ。
 */
describe('実体との照合', () => {
    /** 置き場を作り直して、そこに置いたファイルの一覧を返す */
    function files(): string[] {
        return readdirSync(config.recordedDir).sort();
    }

    /**
     * ファイルを置く。**既定では「書き終えて時間が経ったもの」にする** —
     * 照合は書きたてに触らないので、置いたままだと何も片付かない
     */
    function put(root: string, name: string, settled = true): string {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'x');
        if (settled) {
            const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
            utimesSync(path, old, old);
        }
        return path;
    }

    function fresh(): void {
        const root = mkdtempSync(join(tmpdir(), 'denpa-recon-'));
        config.recordedDir = join(root, 'recorded');
        config.libraryDir = join(root, 'library');
        mkdirSync(config.recordedDir, { recursive: true });
        mkdirSync(config.libraryDir, { recursive: true });
        orm().delete(recordings).run();
    }

    /*
     * chapter_exe と logoframe は TS を直接読むのに dtvindex の索引を作り、
     * `<入力>.dtvi` に置く。生TSを残さない設定だと TS が消えたあとも索引だけが
     * 居座り、録るたびに3MBずつ積もる (実機で9本 22MB)
     */
    test('連れ合いの消えた索引を片付ける', () => {
        fresh();
        put(config.recordedDir, 'のこる.m2ts');
        put(config.recordedDir, 'のこる.m2ts.dtvi');
        put(config.recordedDir, 'きえた.m2ts.dtvi');
        put(config.recordedDir, 'きえた.m2ts.jls.chapterexe.txt');

        expect(reconcile().swept).toBe(2);
        expect(files()).toEqual(['のこる.m2ts', 'のこる.m2ts.dtvi']);
    });

    test('動画の残っている NFO とポスターは残す', () => {
        fresh();
        put(config.libraryDir, '番組/番組 - 1.mkv');
        put(config.libraryDir, '番組/番組 - 1.nfo');
        put(config.libraryDir, '番組/番組 - 1-poster.jpg');

        expect(reconcile().swept).toBe(0);
    });

    /*
     * **もう使わない tvshow.nfo は、動画があっても片付ける。** 映画型に移して
     * シリーズの覚え書きは書かなくなったので、連れ合いの動画を持たない付き添いとして掃く
     */
    test('使わなくなった tvshow.nfo は掃く', () => {
        fresh();
        put(config.libraryDir, '番組/番組 - 1.mkv');
        put(config.libraryDir, '番組/tvshow.nfo');

        expect(reconcile().swept).toBe(1);
        expect(existsSync(join(config.libraryDir, '番組/tvshow.nfo'))).toBe(false);
        expect(existsSync(join(config.libraryDir, '番組/番組 - 1.mkv'))).toBe(true);
    });

    test('動画の消えた NFO とサムネイルは、シリーズごと片付ける', () => {
        fresh();
        put(config.libraryDir, '番組/Season 2026/番組 - 1.nfo');
        put(config.libraryDir, '番組/Season 2026/番組 - 1-thumb.jpg');
        put(config.libraryDir, '番組/tvshow.nfo');

        expect(reconcile().swept).toBe(3);
        expect(existsSync(join(config.libraryDir, '番組'))).toBe(false);
    });

    /*
     * **ファイルの無いフォルダは、掃除の目に入らない。** 付き添いの掃除は
     * ファイルを消した道すがらでしか畳まないので、既に空のフォルダは
     * 一生残っていた (実機の保存先に7組)。フォルダを辿るプレイヤーには
     * 中身の無いシリーズとして並び続ける
     */
    test('すでに空のフォルダも畳む', () => {
        fresh();
        const season = join(config.libraryDir, '消した番組/Season 2026');
        mkdirSync(season, { recursive: true });
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(season, old, old);
        utimesSync(dirname(season), old, old);

        expect(reconcile().pruned).toBe(2);
        expect(existsSync(join(config.libraryDir, '消した番組'))).toBe(false);
    });

    /*
     * **作りたてのフォルダは畳まない。** エンコードが `mkdir` してから
     * ファイルを置くまでの間に照合が走ると、置き場を消してしまう
     */
    test('作りたての空フォルダは畳まない', () => {
        fresh();
        mkdirSync(join(config.libraryDir, '焼いている番組'), { recursive: true });

        expect(reconcile().pruned).toBe(0);
        expect(existsSync(join(config.libraryDir, '焼いている番組'))).toBe(true);
    });

    /** 動画の残っているフォルダは、当然そのまま */
    test('中身のあるフォルダは畳まない', () => {
        fresh();
        put(config.libraryDir, '生きている番組/生きている番組 - 1.mkv');
        // フォルダ自体も古くしておく (作りたて避けに引っかからないように)
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(join(config.libraryDir, '生きている番組'), old, old);

        expect(reconcile().pruned).toBe(0);
        expect(existsSync(join(config.libraryDir, '生きている番組'))).toBe(true);
    });

    test('DBに無い動画は数えるだけ。手で置いたものかもしれない', () => {
        fresh();
        put(config.libraryDir, '手で置いた/手で置いた - 1.mkv');

        const result = reconcile();
        expect(result.strays).toBe(1);
        expect(result.swept).toBe(0);
        expect(existsSync(join(config.libraryDir, '手で置いた/手で置いた - 1.mkv'))).toBe(true);
    });

    /*
     * **焼いている途中のものに触らない。**
     *
     * エンコードは出来上がるまで `<最終の名前>.encoding` に書いていて、その `.mkv` は
     * まだどこにも無い。名前だけで見ると「連れ合いの居ない付き添い」そのものなので、
     * 実機では5分ごとの照合がこれを消し、ffmpeg が書き終えて置き換えるところで
     * `ENOENT ... rename` になっていた
     */
    test('焼いている途中の .encoding は消さない', () => {
        fresh();
        const working = put(config.libraryDir, '番組/番組 - 1.mkv.encoding', false);

        expect(reconcile().swept).toBe(0);
        expect(existsSync(working)).toBe(true);
    });

    test('落ちて取り残された .encoding は、時間が経てば片付く', () => {
        fresh();
        const left = put(config.libraryDir, '番組/番組 - 1.mkv.encoding');

        expect(reconcile().swept).toBe(1);
        expect(existsSync(left)).toBe(false);
    });

    test('切り出したばかりのTSは「実体だけ」に数えない', () => {
        fresh();
        put(config.recordedDir, '番組.m2ts');
        put(config.recordedDir, '番組.m2ts.cut.m2ts', false);

        // 生TSのほうはDBに無いので1件。書きたての .cut.m2ts は数えない
        expect(reconcile().strays).toBe(1);
    });

    /** 両方のコーデックを焼いた録画を1件入れる。返り値は {av1, h264} の実パス */
    function twoCodec(): { av1: string; h264: string } {
        const av1 = put(config.libraryDir, '二本立て/二本立て - 1.mkv');
        const h264 = put(config.libraryDir, '二本立て/二本立て - 1 [H264].mkv');
        orm()
            .insert(recordings)
            .values({
                id: 9,
                service_id: 1,
                name: '二本立て',
                start_at: 0,
                end_at: 0,
                finished_at: 0,
                library_path: av1,
                alt_path: h264,
                created_at: 0,
                updated_at: 0,
            })
            .run();
        return { av1, h264 };
    }

    /*
     * **両方焼いた録画の H.264 は「DBに無い動画」ではない。** known 集合に
     * `alt_path` も入れておかないと、もう一方が野良動画として数えられてしまう
     */
    test('もう一方のコーデックは stray に数えない', () => {
        fresh();
        twoCodec();
        expect(reconcile().strays).toBe(0);
    });

    /*
     * **主が外から消えても、もう一方が残っていれば繰り上げる。** 外のファイル
     * 操作で AV1 のほうだけ消されたときに録画ごと消してしまわないため
     */
    test('主が消えたら、もう一方を主に繰り上げる', () => {
        fresh();
        const { av1, h264 } = twoCodec();
        rmSync(av1);

        const result = reconcile();
        // 削除済みには倒さない
        expect(result.removed).toBe(0);
        const row = orm()
            .select({ lib: recordings.library_path, alt: recordings.alt_path })
            .from(recordings)
            .where(eq(recordings.id, 9))
            .get()!;
        expect(row.lib).toBe(h264);
        expect(row.alt).toBeNull();
    });

    // もう一方 (H.264) だけが消えたときは、控えを外すだけで録画は残る
    test('もう一方が消えたら、控えだけ外す', () => {
        fresh();
        const { av1, h264 } = twoCodec();
        rmSync(h264);

        const result = reconcile();
        expect(result.removed).toBe(0);
        const row = orm()
            .select({ lib: recordings.library_path, alt: recordings.alt_path })
            .from(recordings)
            .where(eq(recordings.id, 9))
            .get()!;
        expect(row.lib).toBe(av1);
        expect(row.alt).toBeNull();
    });
});
