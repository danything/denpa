/**
 * EPGStation の録画を denpa に引き継ぐ。
 *
 * 数百GBのコピーになるので、リクエストの中では終わらない。開始だけ受けて
 * 裏で進め、進捗は {@link status} から読む。入口は設定画面だけ
 * (`/settings` の「EPGStation からの引き継ぎ」)。使い方は docs/migrate.md。
 *
 * ファイルは既定でコピーする。元のPVCを消すまで EPGStation 側もそのまま動くので、
 * 取り込みが済んで中身を確認してから消せる。容量が無いときは move を使う。
 *
 * 何度実行しても同じ結果になる。取り込み済みのものは EPGStation 側のIDで判別して飛ばす。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SQL } from 'bun';
import { and, eq, isNull } from 'drizzle-orm';
import { parseSearchFields, SEARCH_FIELDS } from '$lib/search';
import { now, orm } from './db';
import { emit } from './events';
import { libraryPath, recordedPath } from './library';
import { writeThumbnail } from './metadata';
import { reserve } from './reservations';
import { programs, recordings, rules, services } from './schema';
import { parseTitle, toHalfWidth } from './title';

const env = (key: string, fallback: string) => process.env[key] ?? fallback;

/**
 * EPGStation の MariaDB。**繋ぐのは bun 自身** (`Bun.SQL`)。
 *
 * `mysql2` を入れていたが、bun が MySQL を話せるので外した。使っているのは
 * **引数の無い SELECT を3本と、開いて閉じるだけ** — そのために依存を1つ
 * 抱える理由が無い。
 *
 * 読むだけで、書き込みはしない ([migrate.md](../../../docs/migrate.md))。
 */
const connectionConfig = {
    adapter: 'mysql' as const,
    hostname: env('EPGSTATION_DB_HOST', 'db'),
    port: Number(env('EPGSTATION_DB_PORT', '3306')),
    username: env('EPGSTATION_DB_USER', 'root'),
    password: env('EPGSTATION_DB_PASSWORD', 'epgstation'),
    database: env('EPGSTATION_DB_NAME', 'epgstation'),
    /*
     * **繋がらないときに待たせない。**
     *
     * `Bun.SQL` は**断られても繋ぎ直しに行く**ので、宛先が居ないと既定の30秒を
     * 使い切ってから諦める (`mysql2` は ECONNREFUSED をその場で返していた)。
     * 引き継ぎ元は同じクラスタの中に居るものなので、5秒あれば足りる。
     * 待たせたぶんだけ「押したのに何も起きない」時間が延びるだけ
     */
    connectionTimeout: 5,
};

export const source = {
    host: connectionConfig.hostname,
    /** EPGStation のPVCを denpa 側にマウントした場所 */
    recordedDir: env('EPGSTATION_RECORDED_DIR', '/epgstation-recorded'),
};

/** 引き継ぎ元が見えているか。マウントしていなければ設定画面から実行させない */
export function available(): boolean {
    return existsSync(source.recordedDir);
}

export interface MigrateOptions {
    /** false なら何が起きるかを出すだけでファイルもDBも触らない */
    apply: boolean;
    /** コピーではなく移動する。元のPVCに空きが無いとき用 */
    move: boolean;
}

export interface MigrateStatus extends MigrateOptions {
    state: 'idle' | 'running' | 'done' | 'failed';
    /** 録画の対象の総数。走り出すまでは 0 */
    total: number;
    imported: number;
    skipped: number;
    missing: number;
    /** ルールと手動予約。録画と違ってファイルを触らないので、下見でも件数だけ数える */
    rules: { imported: number; skipped: number };
    reservations: { imported: number; skipped: number };
    /** いま扱っている録画の名前 */
    current: string | null;
    /** 直近の記録。全部残すと際限が無いので後ろから 200 件だけ持つ */
    log: string[];
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

const LOG_LIMIT = 200;

/** まっさらな進み具合。起動時と、走らせ直すたびに (`run`) この形に戻す */
function freshStatus(over: Partial<MigrateStatus> = {}): MigrateStatus {
    return {
        state: 'idle',
        apply: false,
        move: false,
        total: 0,
        imported: 0,
        skipped: 0,
        missing: 0,
        rules: { imported: 0, skipped: 0 },
        reservations: { imported: 0, skipped: 0 },
        current: null,
        log: [],
        error: null,
        startedAt: null,
        finishedAt: null,
        ...over,
    };
}

let status_: MigrateStatus = freshStatus();

export function status(): MigrateStatus {
    return {
        ...status_,
        log: [...status_.log],
        rules: { ...status_.rules },
        reservations: { ...status_.reservations },
    };
}

function record(message: string): void {
    status_.log.push(message);
    if (status_.log.length > LOG_LIMIT) status_.log.splice(0, status_.log.length - LOG_LIMIT);
}

interface Row {
    id: number;
    name: string;
    description: string | null;
    startAt: number;
    endAt: number;
    channelId: number | null;
    channelName: string | null;
    serviceId: number | null;
    networkId: number | null;
    filePath: string | null;
    fileType: string | null;
    fileSize: number | null;
}

/**
 * EPGStation が持つパスを、こちらから見えるパスに直す。
 * 相対パスで持っていることも絶対パスのこともあるので両方を見る。
 */
function sourcePath(filePath: string): string | null {
    const candidates = [
        join(source.recordedDir, filePath),
        filePath.startsWith('/') ? filePath : join(source.recordedDir, filePath.replace(/^\.?\//, '')),
        join(source.recordedDir, filePath.split('/').pop() ?? ''),
    ];
    return candidates.find((path) => existsSync(path)) ?? null;
}

async function fetchRows(): Promise<Row[]> {
    const db = new SQL(connectionConfig);
    try {
        // EPGStation v2 のテーブル構成。エンコード済みがあればそちらを優先して取る
        const rows = (await db.unsafe(
            `SELECT r.id, r.name, r.description, r.startAt, r.endAt,
                    r.channelId, c.name AS channelName, c.serviceId, c.networkId,
                    v.filePath, v.type AS fileType, v.size AS fileSize
             FROM recorded r
             LEFT JOIN channel c ON c.id = r.channelId
             LEFT JOIN video_file v ON v.recordedId = r.id
             WHERE r.isRecording = 0
             ORDER BY r.startAt`,
        )) as Row[];
        // 1つの録画に生TSとエンコード済みが両方あることがある。エンコード済みを優先
        const best = new Map<number, Row>();
        for (const row of rows) {
            const current = best.get(row.id);
            if (current === undefined || (current.fileType !== 'encoded' && row.fileType === 'encoded')) {
                best.set(row.id, row);
            }
        }
        return [...best.values()];
    } finally {
        await db.close();
    }
}

/** 1件を取り込む。取り込めたかどうかを返す */
async function importOne(row: Row, options: MigrateOptions): Promise<'imported' | 'skipped' | 'missing'> {
    // 取り込み済みは EPGStation 側のIDで判別する
    const already = orm()
        .select({ id: recordings.id })
        .from(recordings)
        .where(and(eq(recordings.program_id, -row.id), isNull(recordings.reservation_id)))
        .get();
    if (already !== undefined) return 'skipped';

    if (row.filePath === null) {
        record(`ファイルが無い: ${row.name}`);
        return 'missing';
    }
    const from = sourcePath(row.filePath);
    if (from === null) {
        record(`見つからない: ${row.filePath} (${row.name})`);
        return 'missing';
    }

    const name = toHalfWidth(row.name);
    record(`${options.apply ? '取り込む' : '取り込む(予定)'}: ${name}`);
    if (!options.apply) return 'imported';

    const parsed = parseTitle(name);
    // 局が分からない行 (networkId / serviceId が NULL) は照合しない。局名だけ写す
    const service =
        row.networkId === null || row.serviceId === null
            ? undefined
            : orm()
                  .select({ id: services.id, name: services.name })
                  .from(services)
                  .where(and(eq(services.network_id, row.networkId), eq(services.service_id, row.serviceId)))
                  .get();

    const at = now();
    // program_id は EPGStation のIDの符号を反転して入れる。
    // denpa の番組IDと衝突せず、二重取り込みの判定にも使える
    const { id } = orm()
        .insert(recordings)
        // 録り終えた時刻を入れておく。あとでファイルの置き場所が入れば「視聴可能」になる
        .values({
            reservation_id: null,
            program_id: -row.id,
            service_id: service?.id ?? 0,
            service_name: service?.name ?? toHalfWidth(row.channelName ?? ''),
            name,
            series: parsed.series,
            subtitle: parsed.subtitle,
            description: toHalfWidth(row.description ?? ''),
            start_at: Number(row.startAt),
            end_at: Number(row.endAt),
            finished_at: at,
            created_at: at,
            updated_at: at,
        })
        .returning({ id: recordings.id })
        .get()!;
    const recording = orm().select().from(recordings).where(eq(recordings.id, id)).get()!;

    /*
     * 生TSは保存先ではなく作業領域へ置く。
     *
     * EPGStation の video_file.type は 'ts'(未エンコード) か 'encoded'。
     * 生TSを保存先に置くと denpa からは「エンコード済み」に見えてしまい、
     * 録り直せず、プレイヤーにも巨大な MPEG-2 が並ぶ。denpa 自身が録ったときと
     * 同じ形 (生TSは recorded、完成品は library) に揃える
     */
    const raw = row.fileType !== 'encoded';
    const extension = from.slice(from.lastIndexOf('.')) || (raw ? '.m2ts' : '.mkv');
    const to = raw ? recordedPath(recording, extension) : libraryPath(recording, extension);

    mkdirSync(dirname(to), { recursive: true });
    if (options.move) {
        try {
            renameSync(from, to);
        } catch {
            // PVCをまたぐと rename は使えない
            copyFileSync(from, to);
            unlinkSync(from);
        }
    } else {
        copyFileSync(from, to);
    }

    const placed = raw ? { ts_path: to } : { library_path: to };
    orm()
        .update(recordings)
        .set({ ...placed, ts_size: statSync(to).size, updated_at: now() })
        .where(eq(recordings.id, id))
        .run();

    // サムネイルは保存先に置いたものにだけ付ける。作業領域は画面に出ない
    if (!raw) {
        await writeThumbnail(to, (Number(row.endAt) - Number(row.startAt)) / 1000);
    }
    return 'imported';
}

interface RuleRow {
    id: number;
    keyword: string | null;
    ignoreKeyword: string | null;
    GR: number;
    BS: number;
    CS: number;
    SKY: number;
    channelIds: string | null;
    genres: string | null;
    isFree: number;
    enable: number;
    isTimeSpecification: number;
    /** キーワードを当てる範囲。EPGStation も同じ3つを持っている */
    name: number;
    description: number;
    extended: number;
}

interface ReserveRow {
    programId: number | null;
    ruleId: number | null;
    startAt: number;
    endAt: number;
    name: string | null;
}

/** EPGStation のチャンネルIDは networkId * 100000 + serviceId */
function serviceIdFor(channelId: number): number | undefined {
    const service = orm()
        .select({ id: services.id })
        .from(services)
        .where(
            and(
                eq(services.network_id, Math.floor(channelId / 100000)),
                eq(services.service_id, channelId % 100000),
            ),
        )
        .get();
    return service?.id;
}

/**
 * EPGStation のジャンル指定を denpa の書き方に直す。
 *
 * 向こうは `[{ "genre": 7, "subGenre": 0 }]`。subGenre は**あったり無かったり**で、
 * 「アニメ全部」なら大分類だけになる。denpa は文字列で `"7"`(大分類だけ)と
 * `"7-0"`(中分類まで)を持つので、そこへ写す。
 *
 * 数字でないものは捨てる。ここで素通しすると、画面のジャンル欄に
 * 引ける名前の無い値が並ぶことになる。
 */
export function parseGenres(json: string | null): string[] {
    if (json === null || json === '') return [];
    try {
        const list = JSON.parse(json) as unknown;
        if (!Array.isArray(list)) return [];
        return list
            .map((item) => {
                // 昔の形式で数値の配列になっていることもある
                if (typeof item === 'number') return Number.isInteger(item) ? String(item) : null;
                if (item === null || typeof item !== 'object') return null;
                const { genre, subGenre } = item as { genre?: unknown; subGenre?: unknown };
                if (typeof genre !== 'number' || !Number.isInteger(genre)) return null;
                return typeof subGenre === 'number' && Number.isInteger(subGenre)
                    ? `${genre}-${subGenre}`
                    : String(genre);
            })
            .filter((value): value is string => value !== null);
    } catch {
        return [];
    }
}

/**
 * 自動予約ルールを引き継ぐ。
 *
 * EPGStation のルールには denpa に無い項目(正規表現、時刻指定、録画先の指定、
 * 重複回避など)がある。落ちるものは落ちると分かるように記録に残す。
 * 時刻指定のルールは番組を探すのではなく時計で録るもので、denpa に対応がないので飛ばす。
 */
async function importRules(connection: SQL, options: MigrateOptions): Promise<void> {
    const rows = (await connection.unsafe(
        `SELECT id, keyword, ignoreKeyword, GR, BS, CS, SKY, channelIds, genres,
                isFree, enable, isTimeSpecification, name, description, extended
         FROM rule ORDER BY id`,
    )) as RuleRow[];

    for (const row of rows) {
        const source = `epgstation:${row.id}`;
        if (orm().select({ id: rules.id }).from(rules).where(eq(rules.source, source)).get() !== undefined) {
            status_.rules.skipped++;
            continue;
        }
        if (row.isTimeSpecification) {
            record(`時刻指定のルールは取り込めません: #${row.id}`);
            status_.rules.skipped++;
            continue;
        }

        const keyword = toHalfWidth(row.keyword ?? '').trim();
        const types = (['GR', 'BS', 'CS', 'SKY'] as const).filter((t) => row[t] === 1);
        const genreIds = parseGenres(row.genres);

        let channels: number[] = [];
        if (row.channelIds !== null) {
            try {
                channels = (JSON.parse(row.channelIds) as number[])
                    .map(serviceIdFor)
                    .filter((id): id is number => id !== undefined);
            } catch {
                channels = [];
            }
        }

        if (keyword === '' && types.length === 0 && genreIds.length === 0 && channels.length === 0) {
            // 条件が空だと全番組にマッチしてしまう。EPGStation 側で他の条件
            // (正規表現や時間帯)だけで絞っていたものがここに来る
            record(`条件が空になるので取り込めません: #${row.id}`);
            status_.rules.skipped++;
            continue;
        }

        const name = keyword !== '' ? keyword : `EPGStation #${row.id}`;
        record(`${options.apply ? 'ルール' : 'ルール(予定)'}: ${name}`);
        if (!options.apply) {
            status_.rules.imported++;
            continue;
        }

        // 焼き方は引き継がない。エンコードもCMも全体設定で、焼くときに読む
        orm()
            .insert(rules)
            .values({
                name,
                keyword,
                ignore_keyword: toHalfWidth(row.ignoreKeyword ?? '').trim(),
                // 当てる範囲も向こうから引き継ぐ。既定に寄せると黙って当たらなくなる
                search_fields: parseSearchFields(
                    SEARCH_FIELDS.filter((field) => row[field] === 1).join(','),
                ).join(','),
                service_ids: channels.length === 0 ? null : JSON.stringify(channels),
                service_types: types.length === 0 ? null : JSON.stringify(types),
                genres: genreIds.length === 0 ? null : JSON.stringify(genreIds),
                enabled: row.enable ? 1 : 0,
                priority: 1,
                source,
                created_at: now(),
            })
            .run();
        status_.rules.imported++;
    }
}

/**
 * 手で入れた予約だけ引き継ぐ。
 *
 * ルール由来の予約は、ルールを取り込んだあとに denpa が自分で立て直すので触らない。
 * EPGStation の programId は denpa の番組ID (`programKey`) と作り方が同じなので、直に照合できる。
 */
async function importReservations(connection: SQL, options: MigrateOptions): Promise<void> {
    const rows = (await connection.unsafe(
        `SELECT programId, ruleId, startAt, endAt, name
         FROM reserve WHERE ruleId IS NULL AND isSkip = 0 ORDER BY startAt`,
    )) as ReserveRow[];

    const at = now();
    for (const row of rows) {
        if (row.programId === null || row.endAt <= at) {
            status_.reservations.skipped++;
            continue;
        }
        const program =
            row.programId === null
                ? undefined
                : orm()
                      .select({ id: programs.id })
                      .from(programs)
                      .where(eq(programs.id, row.programId))
                      .get();
        if (program === undefined) {
            // 番組表を取り込む前だと出る。EPG を取り直してからもう一度実行すれば入る
            record(`番組表に無いので取り込めません: ${toHalfWidth(row.name ?? String(row.programId))}`);
            status_.reservations.skipped++;
            continue;
        }

        record(`${options.apply ? '予約' : '予約(予定)'}: ${toHalfWidth(row.name ?? '')}`);
        if (options.apply) await reserve(program.id);
        status_.reservations.imported++;
    }
}

/**
 * 取り込みを走らせる。進捗は {@link status} に入る。
 *
 * 呼び出し側を待たせないので、CLI から使うときは返り値を await すること。
 */
export async function run(options: MigrateOptions): Promise<MigrateStatus> {
    status_ = freshStatus({
        state: 'running',
        apply: options.apply,
        move: options.move,
        startedAt: Date.now(),
    });
    emit('migrate');

    try {
        // ルールと手動予約を先に入れる。録画のコピーは時間がかかるので、
        // 先にこちらを済ませておけば途中で止めても予約は動き出す
        const connection = new SQL(connectionConfig);
        try {
            await importRules(connection, options);
            await importReservations(connection, options);
        } finally {
            await connection.close();
        }
        record(
            `ルール 取り込み ${status_.rules.imported} 件 / 対象外 ${status_.rules.skipped} 件、` +
                `予約 取り込み ${status_.reservations.imported} 件 / 対象外 ${status_.reservations.skipped} 件`,
        );
        emit('migrate');

        const rows = await fetchRows();
        status_.total = rows.length;
        record(`対象 ${rows.length} 件`);
        emit('migrate');

        for (const row of rows) {
            status_.current = toHalfWidth(row.name);
            const result = await importOne(row, options);
            status_[result]++;
            emit('migrate');
        }
        status_.current = null;
        status_.state = 'done';
    } catch (error) {
        status_.state = 'failed';
        status_.error = String(error);
        record(`失敗: ${status_.error}`);
    }
    status_.finishedAt = Date.now();
    emit('migrate');
    return status();
}

/**
 * 設定画面から呼ぶ入口。走り出したことだけ返し、終わるのは待たない。
 * 二重に走ると同じファイルを2つのコピーが掴むので、走っている間は断る。
 */
export function start(options: MigrateOptions): { started: boolean; message: string } {
    if (status_.state === 'running') {
        return { started: false, message: 'すでに実行中です' };
    }
    if (!available()) {
        return {
            started: false,
            message: `引き継ぎ元 ${source.recordedDir} が見えません。EPGStation のPVCをマウントしてください`,
        };
    }
    void run(options);
    return { started: true, message: options.apply ? '取り込みを開始しました' : '下見を開始しました' };
}
