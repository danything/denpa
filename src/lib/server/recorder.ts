import { once } from 'node:events';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { EpgReader } from '../ts/eit';
import { ServiceFilter } from '../ts/service-filter';
import type { Recording, Reservation } from '../types';
import { config } from './config';
import { now, orm } from './db';
import { enqueue } from './encoder';
import { savePrograms } from './epg';
import { emit } from './events';
import { moveFile } from './fsx';
import { libraryPath, recordedPath } from './library';
import { writeThumbnail } from './metadata';
import { programs, recordings, reservations, services } from './schema';
import { chunks } from './stream';
import { parseTitle } from './title';
import { openChannelStream } from './tuner';
import { notify } from './webhook';

/** 録画中のストリームを止めるための口。プロセス内にしか無いので再起動で失われる(起動時に失敗扱いにする) */
const active = new Map<number, AbortController>();

export function activeRecordingIds(): number[] {
    return [...active.keys()];
}

export function stopRecording(recordingId: number): void {
    active.get(recordingId)?.abort();
}

/** 通知用に録画の要点をまとめる */
function summary(recording: Recording) {
    return {
        id: recording.id,
        name: recording.name,
        service: recording.service_name,
        startAt: recording.start_at,
        endAt: recording.end_at,
    };
}

function fail(recordingId: number, error: string): void {
    /*
     * 理由を書けば状態は決まる (recordings.state は生成列)。
     * 掴むのも終わりなので、録り終えた時刻も同時に埋める
     */
    orm()
        .update(recordings)
        .set({ error, finished_at: sql`COALESCE(${recordings.finished_at}, ${now()})`, updated_at: now() })
        .where(eq(recordings.id, recordingId))
        .run();
    const rec = recordingById(recordingId);
    if (rec !== undefined) {
        notify({
            event: 'recording.failed',
            text: `録画に失敗しました: ${rec.name} (${rec.service_name})`,
            recording: summary(rec),
            error,
        });
    }
    // 予約側には何も書かない。失敗したことは録画の行が持っている
}

function recordingById(id: number): Recording | undefined {
    return orm().select().from(recordings).where(eq(recordings.id, id)).get();
}

function createRecording(reservation: Reservation): Recording {
    const service = orm().select().from(services).where(eq(services.id, reservation.service_id)).get();
    const program = orm().select().from(programs).where(eq(programs.id, reservation.program_id)).get();

    /*
     * 名前と概要は**録り始める瞬間の番組表**から取る。
     *
     * 番組表は放送直前まで書き換わる (「[新]」が付く、サブタイトルが入る、
     * 誤字が直る)。予約の行はキーワードで当てた時点の値のままで、時刻が動いた
     * ときにしか更新していないので、そのまま写すと**古い名前で保存先に並ぶ**。
     *
     * 逆に、録り終えたあとは動かさない。番組表の行は24時間で消えるうえ、
     * ファイル名も画面に出す番組情報 (DB) も既に固まっている (docs/data.md)
     */
    const name = program?.name ?? reservation.name;
    const description = program?.description ?? reservation.description;
    // 詳細(拡張形式)は番組表にしか無い。予約の行は持っていないので program からのみ
    const extended = program?.extended ?? null;
    const parsed = parseTitle(name);
    const at = now();

    const { id } = orm()
        .insert(recordings)
        // finished_at を入れないので、この行は「録画中」として読まれる
        .values({
            reservation_id: reservation.id,
            program_id: reservation.program_id,
            service_id: reservation.service_id,
            service_name: service?.name ?? '',
            name,
            series: parsed.series,
            subtitle: parsed.subtitle,
            description,
            extended,
            start_at: reservation.start_at,
            end_at: reservation.end_at,
            /*
             * **譲った区間を写す。** チューナーの取り合いで頭か尻を譲ったときだけ
             * 入っている (`conflict.ts` の「入るところまで録る」)。一覧で
             * 「頭が欠けている」と言うのに要る
             */
            record_from: reservation.record_from,
            record_to: reservation.record_to,
            audio_type: program?.audio_type ?? null,
            // 番組表の行は24時間で消える。録り直しのときにも要るので写しておく
            genre_detail: program?.genre_detail ?? null,
            // 焼いたものの音声トラックに番組表と同じ名前を入れるのに要る (`audioTitles`)
            audios: program?.audios ?? null,
            created_at: at,
            updated_at: at,
        })
        .returning({ id: recordings.id })
        .get()!;
    // ファイル名は録画IDを含めるため、行を作ってからでないと決まらない
    const path = recordedPath({
        id,
        series: parsed.series,
        subtitle: parsed.subtitle,
        start_at: reservation.start_at,
    });
    orm().update(recordings).set({ ts_path: path }).where(eq(recordings.id, id)).run();

    return recordingById(id)!;
}

/**
 * 予約を録画に移す。ストリームの読み出しは待たずにバックグラウンドで走らせ、
 * 呼び出し側(スケジューラのtick)を塞がないようにする。
 */
export async function startRecording(reservation: Reservation): Promise<Recording> {
    const recording = createRecording(reservation);
    emit('recordings');
    const controller = new AbortController();
    active.set(recording.id, controller);

    notify({
        event: 'recording.started',
        text: `録画を開始しました: ${recording.name} (${recording.service_name})`,
        recording: summary(recording),
    });

    void pump(recording, controller).catch((error) => {
        active.delete(recording.id);
        fail(recording.id, String(error));
    });

    return recording;
}

/**
 * チューナーが空くのを少し待つ。
 *
 * 掴めない理由は「本当に足りない」だけとは限らない。番組の頭を数秒落としてでも
 * 録れたほうがいいので、すぐには諦めない。
 */
const OPEN_RETRIES = 5;
const OPEN_RETRY_WAIT = 2000;

async function openWithRetry(
    open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
    signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
    let last: unknown;
    for (let attempt = 0; attempt < OPEN_RETRIES; attempt++) {
        if (signal.aborted) throw new Error('録画が中止されました');
        try {
            return await open(signal);
        } catch (error) {
            last = error;
            if (attempt < OPEN_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_WAIT));
            }
        }
    }
    throw new Error(`チューナーを ${OPEN_RETRIES} 回試して掴めませんでした: ${last}`);
}

/**
 * 放送の延長に追い付く。**録画中のTSに乗っている EIT[p/f] を見る。**
 *
 * **問い合わせる相手が要らない。**
 * いま録っているチャンネルのTSにそのまま流れてくるので、読むだけで分かる。
 *
 * 縮む方向には追わない。番組表が短くなったからといって録画を早く切ると、
 * 実際にはまだ流れていたときに取り返しがつかない。
 */
function extendIfLonger(recording: Recording, endAt: number): void {
    const current = orm()
        .select({ end_at: recordings.end_at })
        .from(recordings)
        .where(eq(recordings.id, recording.id))
        .get();
    if (current === undefined || endAt <= current.end_at) return;

    const at = now();
    orm()
        .update(recordings)
        .set({ end_at: endAt, updated_at: at })
        .where(eq(recordings.id, recording.id))
        .run();
    if (recording.reservation_id !== null) {
        orm()
            .update(reservations)
            .set({ end_at: endAt, updated_at: at })
            .where(eq(reservations.id, recording.reservation_id))
            .run();
    }
    const minutes = Math.round((endAt - current.end_at) / 60000);
    console.log(`[rec] 放送が延びました: ${recording.name} (+${minutes}分)`);
    emit('recordings');
    emit('reservations');
}

/** 実際に録れた長さを足す。再開したぶんも合算するので加算にする */
function addDuration(recordingId: number, ms: number): void {
    if (ms <= 0) return;
    orm()
        .update(recordings)
        .set({ duration_ms: sql`COALESCE(${recordings.duration_ms}, 0) + ${ms}` })
        .where(eq(recordings.id, recordingId))
        .run();
}

/**
 * 録画中に拾った番組表を書き出す間隔。
 *
 * **ただで手に入るぶん。** 録画で開いているチャンネルには EIT[schedule] も
 * 流れてきているので、読んで捨てる理由が無い。番組表集めがそのチャンネルへ
 * 行く手間がまるごと省ける
 */
const EPG_SAVE_INTERVAL = 5 * 60_000;

async function pump(recording: Recording, controller: AbortController): Promise<void> {
    const path = recording.ts_path!;
    mkdirSync(dirname(path), { recursive: true });

    const service = orm().select().from(services).where(eq(services.id, recording.service_id)).get();
    if (service === undefined) {
        fail(recording.id, '局の情報がありません。チャンネルスキャンをやり直してください');
        active.delete(recording.id);
        return;
    }

    /*
     * **物理チャンネルを丸ごと開いて、こちらで局を選り分ける。**
     *
     * エージェントは中身を読まないので、1本の TS にその中継に乗っている局が
     * 全部流れてくる。そのまま保存すると1つの録画に複数の番組が入る
     * (実機の TOKYO MX は MX1 と MX2 が同居している)。
     */
    const filter = new ServiceFilter(service.service_id);
    /*
     * 同じ TS から番組表も読む。**延長の追従はここから。**
     * 番組情報を誰かに聞き直す必要は無い
     */
    const epg = new EpgReader();
    const eventId = recording.program_id === null ? null : recording.program_id % 100000;

    let written = 0;
    // 何を掴んでいるのかがチューナー画面に出る。番組名は載せず、IDだけ渡して向こうで引く
    const use = `rec ${recording.id}` as const;

    try {
        // 追記で開く。再起動をまたいで録画を再開したときに、それまでの分を消さないため
        // (MPEG-TS は 188 バイトのパケットの並びなので、そのまま繋げても読める)
        const sink = createWriteStream(path, { flags: 'a' });
        // 実際に受け取っていた時間を測る。番組表の尺は予定でしかなく、
        // 途中で止めたときや掴むのに手間取ったときは実物と合わない。
        // 再開したときは足していく(ファイルも追記なので合計が実物になる)
        const from = Date.now();
        let savedEpgAt = from;
        let interrupted = 0;

        try {
            /*
             * **選局は自分から切るまで終わらないもの。**
             *
             * 向こうから終わったなら、それは失敗である — 優先度で蹴られたか、
             * デバイスが黙ったか、エージェントごと入れ替わったか。掴み直せば
             * 続きが録れるので、終了時刻が来るまでは何度でも掛け直す。
             *
             * **EOF を「録り終えた」と読んではいけない。** HTTP を1枚挟むと、
             * エージェントが失敗として畳んだストリームも、こちらには正常終了
             * として届く (Bun は接続を壊さず、残りを打ち切るだけ)。ここを
             * 素直に受けていた頃は、蹴られた録画が尻切れのまま「録れた」に
             * なっていた (`agent/conformance.test.ts`)。
             *
             * **途中で例外が飛んだときも同じ扱いにする。** 繋ぎが切れると
             * 読んでいる最中に投げてくる (`The socket connection was closed
             * unexpectedly`)。ここを外へ抜けさせていた頃は、**エージェントの
             * Pod を入れ替えただけで、始まって10秒の30分番組が丸ごと失敗した**
             * (実機)。切れ方が EOF か例外かは向こうの都合で、こちらの
             * 「掴み直せば続きが録れる」は変わらない
             */
            while (!controller.signal.aborted) {
                /** 切れた理由。EOF なら null のまま */
                let broke: unknown = null;

                let stream: ReadableStream<Uint8Array>;
                try {
                    stream = await openWithRetry(
                        (signal) => openChannelStream(service.type, service.channel, signal, use),
                        controller.signal,
                    );
                } catch (error) {
                    // **掴み直せなくても諦めない。** エージェントの Pod 入れ替えは
                    // openWithRetry の数十秒を超えることがあり、そこで失敗にすると
                    // 「終了時刻まで掛け直す」という上の約束を破って番組を丸ごと
                    // 落とす。終了時刻(=自分での abort)が来るまでは待って掛け直す
                    if (controller.signal.aborted) break;
                    interrupted++;
                    console.warn(
                        `[recorder] 録画 ${recording.id}: 選局を掴み直せません (${interrupted} 回目: ${error})。` +
                            `待って掛け直します`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_WAIT));
                    continue;
                }

                try {
                    for await (const chunk of chunks(stream)) {
                        if (config.followOnair && epg.feed(chunk) && eventId !== null) {
                            const present = epg.present.get(service.service_id);
                            if (
                                present !== undefined &&
                                present.eventId === eventId &&
                                present.startAt !== null &&
                                present.duration !== null
                            ) {
                                extendIfLonger(recording, present.startAt + present.duration);
                            }
                            if (Date.now() - savedEpgAt >= EPG_SAVE_INTERVAL) {
                                savedEpgAt = Date.now();
                                savePrograms(epg.all());
                            }
                        }

                        const out = filter.filter(chunk);
                        if (out.length === 0) continue;
                        written += out.byteLength;
                        if (!sink.write(out)) await once(sink, 'drain');
                    }
                } catch (error) {
                    broke = error ?? new Error('不明な理由');
                }

                // 終了時刻に達して自分で切った。ここだけが正常な終わり方
                if (controller.signal.aborted) break;

                interrupted++;
                console.warn(
                    `[recorder] 録画 ${recording.id}: 選局が切れました (${interrupted} 回目` +
                        `${broke === null ? '' : `: ${broke}`})。掴み直します`,
                );
                await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_WAIT));
            }
        } finally {
            if (interrupted > 0) {
                console.warn(`[recorder] 録画 ${recording.id}: 途中で ${interrupted} 回切れました`);
            }
            addDuration(recording.id, Date.now() - from);
            await new Promise<void>((resolve, reject) => {
                sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
            });
            // 途中で終わっても、読めたぶんの番組表は残す
            if (config.followOnair) savePrograms(epg.all());
        }
    } catch (error) {
        // 終了時刻に達して自分で abort した場合は正常終了。それ以外だけ失敗にする
        if (!controller.signal.aborted) {
            active.delete(recording.id);
            fail(recording.id, String(error));
            return;
        }
    } finally {
        active.delete(recording.id);
    }

    let size = written;
    try {
        size = statSync(path).size;
    } catch {
        // 統計が取れなくても書き込み量で代用する
    }

    if (size === 0) {
        fail(recording.id, 'ストリームから1バイトも受信できませんでした');
        return;
    }

    finish(recording.id, size);
}

/** 録画完了。エンコードするならキューに積み、しないならそのまま保存先に置く */
export function finish(recordingId: number, size: number): void {
    const at = now();
    // 録り終えた時刻が入った時点で「録画済み」になる (recordings.state は生成列)
    orm()
        .update(recordings)
        .set({ finished_at: at, ts_size: size, updated_at: at })
        .where(eq(recordings.id, recordingId))
        .run();

    const recording = recordingById(recordingId)!;
    const reservation =
        recording.reservation_id == null
            ? undefined
            : orm()
                  .select({ encode: reservations.encode })
                  .from(reservations)
                  .where(eq(reservations.id, recording.reservation_id))
                  .get();

    emit('recordings');
    notify({
        event: 'recording.finished',
        text: `録画が終わりました: ${recording.name} (${recording.service_name})`,
        recording: summary(recording),
    });

    if (reservation === undefined || reservation.encode) {
        enqueue(recording.id);
        return;
    }

    // エンコードしない設定なら生TSをそのまま保存先へ移す
    const dest = libraryPath(recording, '.m2ts');
    moveFile(recording.ts_path!, dest);
    void writeThumbnail(dest, (recording.end_at - recording.start_at) / 1000);
    // 保存先に置いた時点で「視聴可能」になる
    orm()
        .update(recordings)
        .set({ library_path: dest, ts_path: null, updated_at: now() })
        .where(eq(recordings.id, recording.id))
        .run();
}

/**
 * その録画が終わっているべき時刻。**尻を譲っていればそこまで** (`record_to`)。
 *
 * 止めるとき (`scheduler.tick`)・起動時に拾い直すとき・持ち主の居ない行を畳むとき
 * (`failStrayRecordings`) で同じ物差しを使う。書き写していると、片方だけ直したときに
 * 「止めた時刻」と「終わっているはずの時刻」がずれる
 */
export function recordingUntil(rec: { end_at: number; record_to: number | null }): number {
    return rec.record_to ?? rec.end_at + config.endMargin;
}

/**
 * プロセスが落ちた時点で録画中だった行を拾い直す。
 *
 * AbortController はメモリ上にしか無いので、再起動すると録画は止まったままになる。
 * まだ放送中のものは録り直しに行く。生TSは追記で開くので、落ちるまでに録れていた分は
 * そのまま残り、抜けるのは止まっていた間だけになる。
 * 放送が終わってしまったものは、もう取り返せないので失敗に倒す。
 */
export function recoverOrphanedRecordings(): { resumed: number; failed: number } {
    const orphans = orm().select().from(recordings).where(eq(recordings.state, 'recording')).all();

    let resumed = 0;
    let failed = 0;
    const at = now();
    for (const orphan of orphans) {
        if (orphan.ts_path === null || recordingUntil(orphan) <= at) {
            fail(orphan.id, 'アプリの再起動により録画が中断されました');
            failed++;
            continue;
        }

        const controller = new AbortController();
        active.set(orphan.id, controller);
        void pump(orphan, controller).catch((error) => {
            active.delete(orphan.id);
            fail(orphan.id, String(error));
        });
        console.log(`[boot] 録画を再開: ${orphan.name} (${orphan.service_name})`);
        resumed++;
    }
    if (resumed > 0) emit('recordings');
    return { resumed, failed };
}

/**
 * 終了時刻を過ぎてから畳むまでの猶予。**正常に終わる録画に手を出さないため。**
 *
 * 止めてから `finish` までは同じ処理の中で続けて終わるので実際には重ならないが、
 * 急いで畳んで得るものが何も無い
 */
const STRAY_GRACE = 60_000;

/**
 * **持ち主の居ない「録画中」を畳む。**
 *
 * 掴んでいる録画はプロセスの中にしか無い (`active`)。**畳む間もなく殺された**とき —
 * k3s ごと落とした、Pod を強制終了した — は、DB の行だけが録画中で残る。
 * 起動時にも同じ片付けをするが (`recoverOrphanedRecordings`)、そのとき**まだ放送中なら
 * 録り直しに行く**ので、再開した先でまた殺されると次の起動まで誰も畳まない。
 *
 * 畳まれない行は**予約の一覧に居座り、録画の一覧には出てこない** — どちらの振り分けも
 * `recordings.state = 'recording'` で決まっている (`routes/+page.server.ts`)。放送は
 * とうに終わっているのに「録画中」と出たままで、取り消す以外に消す手が無い。
 *
 * **掴んでいるものには触らない。** 終了時刻を過ぎたものだけを、起動時と同じ理由で
 * 失敗にする。生TSは消さないので、録れていた分は詳細から焼き直せる。
 *
 * `at` と `owned` を渡せるようにしてあるのは試すため (`recorder-stray.test.ts`)
 */
export function failStrayRecordings(at = now(), owned: ReadonlySet<number> = new Set(active.keys())): number {
    const stray = orm()
        .select({ id: recordings.id, end_at: recordings.end_at, record_to: recordings.record_to })
        .from(recordings)
        .where(eq(recordings.state, 'recording'))
        .all()
        .filter((rec) => !owned.has(rec.id) && at >= recordingUntil(rec) + STRAY_GRACE);

    for (const rec of stray) {
        console.warn(`[recorder] 録画 ${rec.id}: 掴んでいる者が居ないまま終了時刻を過ぎました。失敗にします`);
        fail(rec.id, '録画が中断されたまま終了時刻を過ぎました');
    }
    return stray.length;
}
