import { statSync } from 'node:fs';
import { fail } from '@sveltejs/kit';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, like, ne, not, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { orm } from '$lib/server/db';
import { cancel as cancelEncode, enqueue, pump } from '$lib/server/encoder';
import { emit } from '$lib/server/events';
import { deleteRecordingFiles, reconcile } from '$lib/server/files';
import { recordingFromForm } from '$lib/server/recording';
import { cancel, restore } from '$lib/server/reservations';
import {
    encodeJobs,
    recordings as recordingTable,
    reservationState,
    reservations as reservationTable,
    rules as ruleTable,
    services,
} from '$lib/server/schema';
import { settings } from '$lib/server/settings';
import { targets } from '$lib/server/vlc';
import { encodeSource } from '$lib/source';
import type { EncodeJob, Recording, Reservation, ReservationState } from '$lib/types';

interface RecordingRow extends Recording {
    /** 直近のエンコード失敗の理由。詳細で見せる */
    encode_error: string | null;
    /** 動いているエンコード。無ければ null。行の状態としてそのまま出す */
    job_id: number | null;
    job_state: EncodeJob['state'] | null;
    job_phase: EncodeJob['phase'] | null;
    job_percent: number | null;
    job_eta_ms: number | null;
    job_log: string | null;
    /** その局に入れてあるロゴの位置。詳細で指定し直せるように渡す */
    logo_area: string | null;
    /**
     * 生TSの大きさ。エンコード済みと**両方ある**ときだけ入る。
     *
     * `ts_size` はいま配っているファイルの大きさで、エンコードが終わると
     * mkv のものに書き換わる。生TSを残す設定だと「消していいのか、どれだけ
     * 空くのか」が画面から分からなかった
     */
    raw_size: number | null;
    /**
     * もう一方のコーデック (H.264) の大きさ。**両方焼いたときだけ**入る。
     *
     * `ts_size` は主 (AV1) のぶんしか持っていないので、両方焼くと画面に出る
     * 数字と実際に置き場が使っている量が食い違っていた
     */
    alt_size: number | null;
    /**
     * どこから来た1本か。**予約の行から引く** (録画には写さない)。
     *
     * 写していないので、ルールの条件を変えても「何で録れたか」は変わらない。
     * ルールごと消えたときだけ `rule_id` が NULL になり (rules の delete が外す)、
     * 「(削除済み)」として残る
     */
    rule_id: number | null;
    rule_name: string | null;
    /** 手動予約か。取り込んだ録画のように予約が無いものは null */
    from_manual: boolean | null;
    /** 局ロゴを拾えているか。局名の隣に出す */
    has_logo: boolean | null;
}

/**
 * 録り逃し。**録画の行を持たない** (始まらないまま放送が終わったので、録れた
 * ファイルどころか recordings の行も無い)。予約の行から、録画一覧に差し込むのに
 * 要る分だけ持ってくる。
 */
export interface MissedRow {
    id: number;
    program_id: number | null;
    name: string;
    description: string;
    service_id: number;
    service_name: string;
    has_logo: boolean | null;
    start_at: number;
    end_at: number;
    manual: boolean;
    rule_id: number | null;
    rule_name: string | null;
    /** チューナー不足で落とされたものは理由を持っている。詳細で見せる */
    conflict_reason: string | null;
}

interface ReservationRow extends Omit<Reservation, 'state'> {
    /** 画面に出す状態。録り始めてからは録画の行から引く (reservationState) */
    state: ReservationState;
    service_name: string;
    rule_name: string | null;
    /** 局ロゴを拾えているか。局名の隣に出す */
    has_logo: boolean | null;
    /** 録画中の録画のID。追っかけ再生 (`/chase/<id>`) への入口 (issue #16) */
    recording_id: number | null;
}

/**
 * 生TSの大きさ。エンコード済みと両方あるときだけ測る。
 *
 * 片方しか無ければ `ts_size` がそのファイルの大きさなので、二重に出す意味がない。
 * 実ファイルを見るのは、外から消されていることがあるため (files.reconcile)。
 */
function rawSize(row: Recording): number | null {
    if (row.ts_path === null || row.library_path === null) return null;
    try {
        return statSync(row.ts_path).size;
    } catch {
        return null;
    }
}

/**
 * もう一方のコーデック (H.264) の大きさ。両方焼いたときだけ measure する。
 *
 * `ts_size` は主 (AV1) のぶんだけなので、これが無いと**置き場が実際に
 * どれだけ使われているか**が画面から分からない。`rawSize` と同じく実ファイルを
 * 見るのは、外から消されていることがあるため (files.reconcile)
 */
function altSize(row: Recording): number | null {
    if (row.alt_path === null) return null;
    try {
        return statSync(row.alt_path).size;
    } catch {
        return null;
    }
}

/**
 * 予約と録画を1画面に並べる。
 *
 * 「これから何が録れるか」と「録れたものが今どうなっているか」は続きものなので、
 * 行き来せずに見えるほうがいい。左に予約、右に録画。
 */
export function load({ url }) {
    const showFinished = url.searchParams.get('all') === '1';
    const showDeleted = url.searchParams.get('deleted') === '1';
    /*
     * **絞り込みの言葉。** 溜まると300件フラットは指のリモコンで辿れない。
     * 番組名・シリーズ・副題・局名にかかる (下の録画クエリの `search`)。空なら
     * 今までどおり全部出す。**録画の一覧は元から完了分も含む**ので、完了分を
     * 出すための細工は要らない (`showFinished` が効くのは左の予約側だけ)
     */
    const q = (url.searchParams.get('q') ?? '').trim();

    /*
     * 並びは**放送日時の近い順**で固定する。録画中だけは真っ先に見たいので先頭に置く。
     *
     * 「完了分も表示」で向きを変えていた頃は、押した瞬間に一覧がひっくり返って、
     * さっきまで見ていた行がどこへ行ったのか分からなくなっていた。
     * 出るものが増えるだけで、並びは変わらないほうがいい
     *
     * 予約が録り始めてからの状態は**録画の行から引く**。予約側に 'recording' /
     * 'done' / 'failed' を書き写していた頃は、録画が失敗しても予約が録画中のまま
     * 残ることがあった。持っているのは「録り始めた時刻」だけにしてある
     */
    /*
     * まだ始まっていないものと、いま録っているものだけ。「完了分も表示」なら全部。
     *
     * **録り逃したもの (`missed`) はここには出さない** — あれは「これから録るもの」
     * ではなく**録画の結果**なので、録画の一覧のほうに出す (下の `missed`)。
     * 予約側に出していた頃は、放送が終わった行が予約の列に居座って、
     * 「これから何が録れるか」の中に過去が混ざっていた。
     *
     * **取り消したものは出さない** — あちらは人が押した結果で、驚くことが無い
     */
    const r = alias(reservationTable, 'r');
    const rec = alias(recordingTable, 'rec');
    const pending = showFinished
        ? not(and(eq(r.state, 'missed'), isNull(r.started_at))!)
        : or(
              and(inArray(r.state, ['scheduled', 'conflict']), isNull(r.started_at)),
              eq(rec.state, 'recording'),
          );
    const reservations: ReservationRow[] = orm()
        .select({
            ...getTableColumns(r),
            service_name: services.name,
            has_logo: services.has_logo,
            rule_name: ruleTable.name,
            // 予約の行の state ではなく、録画から引いたほうを出す
            state: reservationState(r, rec),
            recording_id: sql<number | null>`CASE WHEN ${rec.state} = 'recording' THEN ${rec.id} END`,
        })
        .from(r)
        .innerJoin(services, eq(services.id, r.service_id))
        .leftJoin(ruleTable, eq(ruleTable.id, r.rule_id))
        // その予約で録れた最新の録画
        .leftJoin(
            rec,
            eq(
                rec.id,
                sql`(SELECT id FROM recordings WHERE reservation_id = ${r.id} ORDER BY id DESC LIMIT 1)`,
            ),
        )
        .where(pending)
        .orderBy(desc(sql`${rec.state} = 'recording'`), asc(r.start_at))
        .limit(300)
        .all();

    /*
     * エンコードは録画一覧の行そのものに出す。
     *
     * 別のカードにして一覧の上に積んでいた頃は、エンコードが増えるたびに表が下へ
     * ずれてページごとスクロールバーが生えていた。同じ番組が2箇所に並んでもいた。
     * 「録れたものが今どうなっているか」の一形態なので、行の状態として出すのが素直。
     */
    // 番組名・シリーズ・副題・局名のどれかにかかればよい。同じ言葉を4か所へ
    const pattern = q === '' ? null : `%${q}%`;
    const res = alias(reservationTable, 'res');
    const j = alias(encodeJobs, 'j');
    const recordings: RecordingRow[] = orm()
        .select({
            ...getTableColumns(recordingTable),
            /*
             * 失敗の理由は詳細で見せる。一覧には「失敗」とだけ出す。
             *
             * **いちばん新しいジョブが失敗していたときだけ**出す。
             * 「失敗したジョブのうち最新」を拾っていた頃は、録り直して成功しても
             * 前の失敗が消えずに残っていた
             */
            encode_error: sql<string | null>`(
                 SELECT CASE WHEN j2.state = 'failed' THEN j2.error END FROM encode_jobs j2
                 WHERE j2.recording_id = ${recordingTable.id}
                 ORDER BY j2.id DESC LIMIT 1)`,
            job_id: j.id,
            job_state: j.state,
            job_phase: j.phase,
            job_percent: j.percent,
            job_eta_ms: j.eta_ms,
            job_log: j.log,
            logo_area: services.logo_area,
            has_logo: services.has_logo,
            // 何で録れた1本か。予約とルールから引く (録画には持たせない)
            rule_id: res.rule_id,
            from_manual: res.manual,
            rule_name: ruleTable.name,
        })
        .from(recordingTable)
        .leftJoin(services, eq(services.id, recordingTable.service_id))
        .leftJoin(res, eq(res.id, recordingTable.reservation_id))
        .leftJoin(ruleTable, eq(ruleTable.id, res.rule_id))
        // 動いているエンコードは録画1本につき高々1つ (encoder.enqueue が重複を弾く)
        .leftJoin(
            j,
            eq(
                j.id,
                sql`(SELECT id FROM encode_jobs WHERE recording_id = ${recordingTable.id}
                     AND state IN ('queued','running') ORDER BY id DESC LIMIT 1)`,
            ),
        )
        .where(
            and(
                // 録画中のものは予約一覧に出ている。ここにも出すと同じ番組が2箇所に並ぶ
                ne(recordingTable.state, 'recording'),
                /*
                 * 「削除済みも表示」は消したものを**足す**。消したものだけに切り替えていた頃は、
                 * 消したかどうかを確かめるのに一覧を行き来することになっていた
                 */
                showDeleted ? undefined : isNull(recordingTable.deleted_at),
                pattern === null
                    ? undefined
                    : or(
                          like(recordingTable.name, pattern),
                          like(recordingTable.series, pattern),
                          like(recordingTable.subtitle, pattern),
                          like(recordingTable.service_name, pattern),
                      ),
            ),
        )
        /*
         * 並びは放送日順に固定する。エンコードが始まったものを上へ動かしていた頃は、
         * 眺めている間に行が飛んで、どれを見ていたのか分からなくなっていた
         */
        .orderBy(desc(recordingTable.start_at))
        .limit(300)
        .all()
        .map((row) => ({ ...row, raw_size: rawSize(row), alt_size: altSize(row) }));

    /*
     * 録り逃し。**録画の一覧に混ぜて出す** (画面側で放送日順に差し込む)。
     * チューナーが足りずに落とされたものが黙って消えると、録れたつもりのまま
     * 気付かれずに終わる — いちばん知りたいのは「録れなかった」ほうなのに。
     *
     * 溜まり続けはしない。終わった予約は履歴の片付けで消える
     * (`server/files.ts`。既定で14日)。絞り込みは録画側と同じ言葉を効かせる
     * (予約はシリーズ・副題を持たないので、番組名と局名だけ)
     */
    const missed: MissedRow[] = orm()
        .select({
            id: r.id,
            program_id: r.program_id,
            name: r.name,
            description: r.description,
            service_id: r.service_id,
            start_at: r.start_at,
            end_at: r.end_at,
            manual: r.manual,
            rule_id: r.rule_id,
            conflict_reason: r.conflict_reason,
            rule_name: ruleTable.name,
            service_name: services.name,
            has_logo: services.has_logo,
        })
        .from(r)
        .innerJoin(services, eq(services.id, r.service_id))
        .leftJoin(ruleTable, eq(ruleTable.id, r.rule_id))
        .where(
            and(
                eq(r.state, 'missed'),
                isNull(r.started_at),
                pattern === null ? undefined : or(like(r.name, pattern), like(services.name, pattern)),
            ),
        )
        .orderBy(desc(r.start_at))
        .limit(100)
        .all();

    return {
        reservations,
        recordings,
        missed,
        showFinished,
        showDeleted,
        q,
        // 「テレビで再生」を出すかどうか。設定にテレビが書いてあるときだけ (vlc.ts)
        vlcTargets: targets(),
    };
}

// フォームの id から録画を引く。どのアクションも最初にこれを通る
const target = recordingFromForm;

export const actions = {
    delete: async ({ request }) => {
        const recording = target(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        deleteRecordingFiles(recording, '手動削除');
        return { success: true };
    },

    reencode: async ({ request }) => {
        const recording = target(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        // 元になるのは生TS。エンコード済みを元に録り直しても画質は戻らない
        if (encodeSource(recording) === null) {
            return fail(400, { message: '生TSが残っていないため再エンコードできません' });
        }
        /*
         * どのコーデックで焼くかは**そのときの設定**。押した人は焼きたいので、
         * 録ったときの設定を再現したいわけではない。設定が「エンコードしない」
         * だと焼くものが決まらないので、ここで断る
         */
        if (settings().codec === 'none') {
            return fail(400, {
                message: '映像コーデックが選ばれていません。設定で AV1 か H.264 を入れてください',
            });
        }
        enqueue(recording.id);
        pump();
        return { success: true };
    },

    cancelEncode: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        cancelEncode(id);
        return { success: true };
    },

    reconcile: () => {
        // 「実体と照合」ボタン。外から消した分をすぐ一覧に反映したいとき用
        const result = reconcile();
        // 押した本人以外の画面も更新する。同じものを見ている端末が食い違うのを防ぐ
        emit('recordings');
        return { success: true, reconcile: result };
    },

    /**
     * 録り逃しを一覧から消す。**消すのは予約の行そのもの** — 録画の行が無い
     * (始まらないまま終わった) ので、失敗した録画の削除とは消す先が違う。
     * 放って置いても履歴の片付け (14日) で消えるが、見るたびに並んだままなのは
     * 失敗した録画と同じで、確かめ終わったら畳みたい
     */
    deleteMissed: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        // 状態も見て消す。録り逃し以外 (これからの予約など) を同じ口で消させない
        const gone = orm()
            .delete(reservationTable)
            .where(
                and(
                    eq(reservationTable.id, id),
                    eq(reservationTable.state, 'missed'),
                    isNull(reservationTable.started_at),
                ),
            )
            .returning({ id: reservationTable.id })
            .get();
        if (gone === undefined) return fail(400, { message: '録り逃した予約ではありません' });
        // 他の端末の画面にも反映する
        emit('reservations');
        return { success: true };
    },

    /** 取り消した予約を戻す。ルールは作り直さないので、ここからしか戻せない */
    restore: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        try {
            await restore(id);
        } catch (error) {
            return fail(400, {
                message: `予約に戻せませんでした: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
        return { success: true };
    },

    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },
};
