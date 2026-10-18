import { fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, not, sql } from 'drizzle-orm';
import { now, orm } from '#lib/server/db.js';
import { CURRENT_SERVICES, watchableServices } from '#lib/server/epg.js';
import { relative } from '#lib/server/paths.js';
import { cancel, reserve } from '#lib/server/reservations.js';
import { conditionsOf, draftRule, EMPTY_RULE, originOf, ruleValues } from '#lib/server/rule-form.js';
import { previewFor } from '#lib/server/rule-preview.js';
import { applyRules } from '#lib/server/rules.js';
import { resolveConflicts } from '#lib/server/scheduler.js';
import { reservations, rules as ruleTable, services as serviceTable } from '#lib/server/schema.js';
import { settings } from '#lib/server/settings.js';
import type { Rule } from '#lib/types.js';

/** 画面が受け取る下見の形 (`rule-preview.ts`) */
export type { Preview, PreviewRow } from '#lib/server/rule-preview.js';

interface Row extends Rule {
    reservations: number;
}

/**
 * まだ録っていないぶん。終わったものも取り消したものも数えない。
 *
 * 予約の行は録り始めたかどうかを `started_at` で持っている (状態の文字列には
 * 書かない)。`state IN ('scheduled','conflict')` だけで数えていた頃は、
 * 録り終えた予約まで「押さえている」に入っていた
 */
const PENDING = and(inArray(reservations.state, ['scheduled', 'conflict']), isNull(reservations.started_at));

export async function load({ url }) {
    const defaults = settings();
    // ?edit=<id> のときは、そのルールをフォームに読み込んで書き換えられるようにする
    const editing = orm()
        .select()
        .from(ruleTable)
        .where(eq(ruleTable.id, Number(url.searchParams.get('edit'))))
        .get();
    /*
     * **無いルールの `?edit=` は一覧へ。** 消したルールのリンクや古い履歴から来ると、編集のつもりの欄が
     * 「新しいルール」に化けて、気づかずに別のルールを作ることになる
     */
    if (url.searchParams.has('edit') && editing === undefined) redirect(303, relative(url, '/rules'));

    const origin = originOf(url.searchParams);
    /*
     * 録画・番組から来た (`originOf`) ときは、下書きの条件を URL に載せて出直す。
     * 下書きが URL にあれば、フォームの初期値をそのまま組める。既にこのシリーズを録っているルールが
     * あれば出直さず、そちらへの入口を出す
     */
    if (
        origin !== null &&
        origin.rule === null &&
        origin.prefill !== null &&
        !url.searchParams.has('keyword')
    ) {
        const query = new URLSearchParams({
            keyword: origin.prefill.keyword,
            dedupe: '1',
            [origin.kind]: String(origin.id),
        });
        redirect(303, relative(url, `/rules?${query}`));
    }
    /*
     * フォームの初期値。URL に載っている条件を優先する (検索の「ルールを作る」・録画から来たとき)。
     * 無ければ編集中のルールの条件
     */
    const conditions = draftRule(url.searchParams) ?? editing ?? null;

    /*
     * 予約数は**これから録るぶんだけ**。
     *
     * 全部の行を数えていた頃は、録り終えたものも取り消したものも混ざるので、
     * ルールを止めても数が減らず、編集画面に出る件数とも合わなかった。
     * この列を見るのは「このルールがいま何を押さえているか」を知りたいときなので、
     * 履歴は数えない
     */
    const rules: Row[] = orm()
        .select({
            ...getTableColumns(ruleTable),
            reservations: sql<number>`(SELECT COUNT(*) FROM ${reservations}
                 WHERE ${reservations.rule_id} = ${ruleTable.id} AND ${PENDING})`.mapWith(Number),
        })
        .from(ruleTable)
        .orderBy(desc(ruleTable.id))
        .all();
    // 取り残しの局は選ばせない (CURRENT_SERVICES)。もう録れない局が並ぶだけ
    const services = orm()
        .select()
        .from(serviceTable)
        .where(sql.raw(CURRENT_SERVICES))
        .orderBy(serviceTable.type, serviceTable.channel)
        .all();
    // フォームの初期値は preview と同じものを使う。別々に組み立てると、
    // 画面に出ている結果と保存されるものがズレる
    return {
        rules,
        services,
        editing: editing ?? null,
        seed: conditions,
        /** 録画・番組から作るとき、どれからか (`originOf`) */
        origin:
            origin === null
                ? null
                : {
                      kind: origin.kind,
                      id: origin.id,
                      name: origin.name,
                      found: origin.found,
                      rule:
                          origin.rule === null
                              ? null
                              : { id: origin.rule.id, name: origin.rule.name, enabled: origin.rule.enabled },
                      prefilled: origin.prefill !== null,
                  },
        defaults,
        // 詳細の「視聴」を出すかどうか。決め方は番組表と揃えてある (watchableServices)
        watchable: watchableServices(now()),
    };
}

/**
 * ルールを当て直して、チューナーの取り合いを計算し直す。
 *
 * 以前はここで番組表を丸ごと取り直していた (`sync()`)。押す動機はたいてい
 * 「新しい番組に当ててほしい」だから、というつもりだったが、そのぶん
 * 数MBの取得と2万件の書き戻しを待たされていた。
 *
 * いまは番組表を持っているのが denpa 自身なので、取り直す理由がない。当てるだけ。
 *
 * @param rule そのルールだけを当てる。**足したときにしか使えない** —
 *   新しいルールは他の予約を外すことができないので、範囲を絞れる
 *   (`rules.applyRules`)
 */
async function reapply(rule?: number): Promise<number> {
    const { dropped } = applyRules(rule === undefined ? {} : { rule });
    await resolveConflicts();
    return dropped;
}

/** 条件が空だと全番組にマッチしてディスクを埋めるので作らせない */
export const actions = {
    /**
     * **書く欄のいまの値で、録れる番組を数える** (`previewFor`)。何も書き換えない。
     *
     * 画面が打ち直しのたびに少し待ってから送る。送るのは書く欄そのもの (`edit` も入っている)
     * なので、読み方は保存と同じ (`conditionsOf`)。条件が空なら数えない (全番組に当たるだけ)
     */
    preview: async ({ request }) => {
        const form = await request.formData();
        const conditions = draftRule(form);
        if (conditions === null) return { preview: null };
        const editing = form.has('edit')
            ? orm()
                  .select()
                  .from(ruleTable)
                  .where(eq(ruleTable.id, Number(form.get('edit'))))
                  .get()
            : undefined;
        return { preview: await previewFor(conditions, { editing }) };
    },

    create: async ({ request, url }) => {
        const form = await request.formData();
        const conditions = conditionsOf(form);
        if (conditions.empty) return fail(400, { message: EMPTY_RULE });

        const created = orm()
            .insert(ruleTable)
            .values({
                ...ruleValues(conditions, form),
                // 新しく作るルールは入れて始める (`dedupeOf`)
                dedupe: conditions.dedupe ?? true,
                enabled: true,
                created_at: now(),
            })
            .returning({ id: ruleTable.id })
            .get()!;

        // 足したルールは他の予約を外せないので、そのルールだけ当てれば足りる
        await reapply(created.id);
        /*
         * 書く欄を初めの状態に戻す (URL に載せて来た条件も外す)。更新と同じ。
         * 録画・番組から作ったときはその元だけ残す — 作ったルールで録っていると出る (`originOf`)
         */
        const from = String(form.get('origin') ?? '').match(/^(recording|program):(\d+)$/);
        redirect(303, relative(url, from === null ? '/rules' : `/rules?${from[1]}=${from[2]}`));
    },

    update: async ({ request, url }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ルールIDが不正です' });

        const conditions = conditionsOf(form);
        if (conditions.empty) return fail(400, { message: EMPTY_RULE });

        orm().update(ruleTable).set(ruleValues(conditions, form)).where(eq(ruleTable.id, id)).run();

        /*
         * 条件が変わったので、これから録るぶんは組み直す。
         * **条件に入ったものは立ち、外れたものは引っ込む** (`rules.applyRules`)
         */
        await reapply();
        // 直したルールを選んだまま (左の一覧で光ったまま、右も同じルール)
        redirect(303, relative(url, `/rules?edit=${id}`));
    },

    /**
     * このルールが立てた予約を**1件だけ**取り消す。
     *
     * 条件はそのままで、要らないものだけここで外す。
     *
     * 取り消しであって削除ではない。ルールが同じ番組を作り直すことはなく、
     * 気が変わったら予約一覧の「戻す」で戻せる。
     */
    cancelReservation: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('reservationId'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },

    /**
     * プレビューの1件を、その場で予約する。
     *
     * **ルールに任せる番組と、いま1本だけ録りたい番組は別物。** 条件を詰めている
     * 途中で「これは録っておきたい」に行き当たったとき、番組表を開いて同じ番組を
     * 探し直すことになっていた。押した結果は行の状態に出る (`preview-state`)。
     *
     * 録画のしかた (エンコードするか・元のTSを残すか) はここでは選ばせない。
     * 設定画面の1箇所で決める — 番組表の予約と同じ (docs/app.md)
     */
    reserve: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });
        try {
            await reserve(programId);
        } catch (error) {
            return fail(400, { message: String(error) });
        }
        return { success: true };
    },

    toggle: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ルールIDが不正です' });
        orm()
            .update(ruleTable)
            .set({ enabled: not(ruleTable.enabled) })
            .where(eq(ruleTable.id, id))
            .run();
        await reapply();
        return { success: true };
    },

    delete: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ルールIDが不正です' });
        /*
         * **取り消しの記録だけ先に消す。** ルールごと無くなるので、
         * 「このルールには作り直させない」という目印を残す意味がない。
         * 残していた頃は、後から `scheduled` に戻ったときに**消したはずの
         * ルールの予約が「ルール: (削除済み)」として一覧に並んでいた**
         * (実機で 45 件)。
         *
         * まだ立っている予約はここでは触らない。**他のルールが引き取れるかどうかを
         * 見てから決める** — 消したのが「アニメ」でも、「無職転生」が残っていれば
         * その予約は生き続けるべき (`rules.applyRules` が付け替える)
         */
        orm()
            .delete(reservations)
            .where(
                and(
                    eq(reservations.rule_id, id),
                    isNull(reservations.started_at),
                    eq(reservations.state, 'canceled'),
                ),
            )
            .run();
        // 録画中・録画済みのぶんは履歴として残すので、ルールとの紐付けだけ外す
        orm()
            .update(reservations)
            .set({ rule_id: null })
            .where(and(eq(reservations.rule_id, id), isNotNull(reservations.started_at)))
            .run();
        orm().delete(ruleTable).where(eq(ruleTable.id, id)).run();

        // 引き取り手の無い予約はここで消える (猶予は効かない = 人が押した結果なので)
        const dropped = await reapply();
        return { success: true, canceled: dropped };
    },
};
