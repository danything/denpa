import { and, eq, getTableColumns, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { type Genre, genreMatches } from '$lib/arib';
import { parseSearchFields, type SearchField } from '../search';
import type { Program, Rule } from '../types';
import { config } from './config';
import { now, orm } from './db';
import { programs as programTable, reservations, rules as ruleTable, services } from './schema';
import { settings } from './settings';
import { toHalfWidth } from './title';

/** 空の並びは「指定なし」。NULL と同じに扱う */
function nonEmpty<T>(list: T[] | null): T[] | null {
    return list === null || list.length === 0 ? null : list;
}

/** 詳細は見出し付き。見出しごと繋いで、素のテキストとして探せるようにする */
function extendedText(extended: Record<string, string> | null): string {
    if (extended === null) return '';
    return Object.entries(extended)
        .map(([heading, body]) => `${heading} ${body}`)
        .join(' ');
}

/** 検索対象のテキスト */
export function haystack(
    program: Pick<Program, 'name' | 'description' | 'extended'>,
    fields: SearchField[],
): string {
    const parts = fields.map((field) =>
        field === 'extended' ? extendedText(program.extended) : program[field],
    );
    return toHalfWidth(parts.join(' ')).toLowerCase();
}

/**
 * 番組のジャンル。中分類まで持っている genre_detail を使い、
 * 取り込みが古くて入っていないものは大分類だけの genres で代用する
 */
function parseGenreDetail(program: Program): Genre[] {
    return nonEmpty(program.genre_detail) ?? (program.genres ?? []).map((lv1) => ({ lv1, lv2: -1 }));
}

/**
 * 判定に使う形にほどいたルール。
 *
 * ほどく作業 (JSON の読み出し、キーワードの分割、全角の直し) を**ルール1つにつき
 * 1回**にするために分けてある。以前は判定のたびにやっていて、実機では
 * 有効なルール 318 × これから放送される番組 25,608 = **810万回**それをやっていた。
 * ルールを1つ足すだけで十数秒待たされていたのはこれが理由。
 */
export interface CompiledRule {
    rule: Rule;
    services: number[] | null;
    types: string[] | null;
    genres: string[] | null;
    fields: SearchField[];
    keywords: string[];
    ignores: string[];
}

export function compile(rule: Rule): CompiledRule {
    return {
        rule,
        services: nonEmpty(rule.service_ids),
        types: nonEmpty(rule.service_types),
        genres: nonEmpty(rule.genres),
        fields: parseSearchFields(rule.search_fields),
        // キーワードは空白区切りの AND。「アニメ 再放送」で両方含むものだけ拾える
        keywords: toHalfWidth(rule.keyword).toLowerCase().split(/\s+/).filter(Boolean),
        // 除外キーワードは OR。1つでも当たれば落とす
        ignores: toHalfWidth(rule.ignore_keyword).toLowerCase().split(/\s+/).filter(Boolean),
    };
}

/**
 * ほどいたルールに番組が当てはまるか。
 *
 * 検索用テキストは**関数で受け取る**。文字を作るのが一番高くつくので、
 * チャンネルやジャンルで落ちる番組にはそもそも作らせない。
 * 同じ番組に何本ものルールを当てるときは、呼ぶ側が作ったものを使い回せる。
 */
export function matchesCompiled(
    compiled: CompiledRule,
    program: Program,
    serviceType: string | undefined,
    freeOnly: boolean,
    textOf: (fields: SearchField[]) => string,
): boolean {
    if (freeOnly && !program.is_free) return false;

    const { services, types, genres, keywords, ignores } = compiled;

    // チャンネルの条件は「種別」と「個別チャンネル」のOR。
    // 「地上波全部 + BS11だけ」のような指定ができるようにするため
    if (services !== null || types !== null) {
        const byService = services?.includes(program.service_id) ?? false;
        const byType = serviceType !== undefined && (types?.includes(serviceType) ?? false);
        if (!byService && !byType) return false;
    }

    // ジャンルは "7"(大分類だけ)と "7-0"(中分類まで)の2通りで持つ。
    // 昔のルールは数値の配列だが、String() を通せばそのまま大分類として読める
    if (genres !== null) {
        const detail = parseGenreDetail(program);
        if (detail.length === 0) return false;
        if (!genreMatches(genres, detail)) return false;
    }

    // 全条件が空のルールは全番組にマッチしてしまうので無効扱いにする
    if (keywords.length === 0 && services === null && types === null && genres === null) return false;

    if (keywords.length === 0 && ignores.length === 0) return true;

    const text = textOf(compiled.fields);
    if (!keywords.every((k) => text.includes(k))) return false;
    return !ignores.some((k) => text.includes(k));
}

/**
 * ルールに番組が当てはまるか。1件だけ見るとき用。
 *
 * 有料放送を対象にするかは全体設定なので、呼ぶ側が渡す
 * (ここで設定を読むと純粋関数でなくなり、テストから条件を作れない)。
 */
export function matches(rule: Rule, program: Program, serviceType?: string, freeOnly = true): boolean {
    return matchesCompiled(compile(rule), program, serviceType, freeOnly, (fields) =>
        haystack(program, fields),
    );
}

/**
 * 番組1つぶんの検索用テキストを、対象範囲ごとに1度だけ作って使い回す。
 * ほとんどのルールは同じ範囲 (番組名だけ) を見るので、実際にはほぼ1回で済む。
 */
function textCache(program: Program): (fields: SearchField[]) => string {
    const cache = new Map<string, string>();
    return (fields) => {
        const key = fields.join(',');
        let text = cache.get(key);
        if (text === undefined) {
            text = haystack(program, fields);
            cache.set(key, text);
        }
        return text;
    };
}

/** 取り消し済みの放送に、番組が当たるかどうか */
interface Declined {
    has(program: Pick<Program, 'name' | 'start_at'> & { channel: string }): boolean;
}

/**
 * 取り消しから 10 分以内なら同じ放送。延長や繰り下げで開始が少し動いても
 * 追いかけられ、同じ日の再放送 (1時間後など) は別の回として扱える
 */
const DECLINE_WINDOW = 10 * 60 * 1000;

/**
 * **人が取り消した放送。** 番組の id ではなく、**物理チャンネル + 題名 + 開始時刻**で持つ。
 *
 * 取り消しの記録は `reservations.program_id` (局 + event_id) に付いていて、ルールは
 * `INSERT OR IGNORE` がそれに当たることで「二度と立てない」を成り立たせていた。
 * ところが id が同じでなくなる道が2つあり、どちらも実機で**取り消したはずの回が
 * 録れた**として出た。
 *
 * - **枝番違い。** 同じ放送が 23608 と 23609 の両方に載るとき、束ねが一時的に
 *   外れる (片方だけ延長が先に届く、題名がまだ違う) と、取り消していないほうの
 *   枝番に予約が無いので立つ。放送直前なら猶予 (`ruleRetractGrace`) の中で
 *   引っ込まず、そのまま録れる
 * - **event_id の変更。** 局が同じ番組を別の event_id で送り直すと、番組表の
 *   取り込みは重なる行を消して新しい id で入れる。取り消し行は古い id を指したまま
 *   残り、新しい id には予約が無いので立つ
 *
 * どちらも「同じ物理チャンネルで、同じ題名が、同じ頃に始まる」ことは変わらないので、
 * そこで当てる。
 *
 * **システムの取り消しは含めない。** 選局できなくなった局の予約はシステムが
 * 取り消す (`epg.clearBelongings`、`canceled_by = 'system'`) が、それは「局が戻ったなら
 * 録る」でよい。列を足す前の行 (NULL) は人が押したものとして扱う。
 * 手動予約を人が取り消したぶんは含める — 今までも id が同じ限りルールを止めていたので、
 * その振る舞いを id が変わっても続けるだけ。
 */
function canceledBroadcasts(at: number): Declined {
    const rows = orm()
        .select({
            channel: services.channel,
            name: reservations.name,
            start_at: reservations.start_at,
        })
        .from(reservations)
        .innerJoin(services, eq(services.id, reservations.service_id))
        .where(
            and(
                eq(reservations.state, 'canceled'),
                gt(reservations.end_at, at),
                or(isNull(reservations.canceled_by), ne(reservations.canceled_by, 'system')),
            ),
        )
        .all();
    /** 物理チャンネル + 題名 → 取り消した回の開始時刻 */
    const starts = new Map<string, number[]>();
    for (const row of rows) {
        if (row.name === '') continue;
        const key = `${row.channel} ${row.name}`;
        const list = starts.get(key);
        if (list === undefined) starts.set(key, [row.start_at]);
        else list.push(row.start_at);
    }
    return {
        has(program) {
            const list = starts.get(`${program.channel} ${program.name}`);
            if (list === undefined) return false;
            return list.some((start) => Math.abs(start - program.start_at) <= DECLINE_WINDOW);
        },
    };
}

export interface RuleSync {
    /** 新しく立てた予約 */
    created: number;
    /** どのルールにも当たらなくなって消した予約 */
    dropped: number;
    /** 別のルールが引き取った予約 */
    moved: number;
    /** ルールの優先度が変わって、付け替えた予約 */
    repriced: number;
}

/**
 * ルールを番組表に当て直して、予約をそろえる。
 *
 * **足すだけでなく、外れたものは消す。** 足すだけだった頃は、番組表が書き換わって
 * 条件から外れた予約がそのまま残り、消す手立てが画面の「取り消し」しか無かった。
 *
 * - 当たるのに予約が無い → **作る**
 * - 予約があるのに、どのルールにも当たらなくなった → **消す**
 * - 当てているルールが変わった (別のルールが引き取った) → **付け替える**
 *
 * **消すのであって「取り消し」にはしない。** 取り消しは*人が押したこと*の記録で、
 * ルールは二度と作り直さない (`INSERT OR IGNORE` と、放送単位で当てる
 * `canceledBroadcasts`)。番組表が動いただけのものを取り消しにすると、条件に
 * 戻ってきても永久に予約が立たなくなる。
 *
 * ### 引っ込めないもの
 *
 * 手違いで消すほうが、余分に録るより高くつく。次のどれかに当たるものは残す。
 *
 * - **手動の予約と、録り始めたもの** (`manual` / `started_at`)
 * - **人が取り消したもの。** 取り消しの記録はそのまま残す
 * - **番組表からその番組ごと消えているとき。** 「条件から外れた」のか
 *   「まだ読めていない」のか区別が付かない
 * - **題名が空の番組。** 放送が名前を出していないのではなく、こちらがまだ
 *   読めていないだけのことがある (実機で 23,000 件のうち 11,000 件がそうだった)
 * - **もうすぐ始まるもの** (`config.ruleRetractGrace`)。番組表は放送直前まで
 *   書き換わるので、そこで条件を外れても手遅れになるより録っておく。
 *   ただし**ルールごと消された/止められたぶんは、直前でも引っ込める** —
 *   そちらは人が押した結果なので迷う理由がない
 *
 * @param options.rule そのルールだけを当てる。**足すことしかしない。**
 *   ルールを足した直後用 — 新しいルールは他の予約を外すことができないので、
 *   全ルール × 全番組 (実機で 318 × 25,608) を回し直さずに済む
 */
export function applyRules(options: { rule?: number } = {}): RuleSync {
    const result: RuleSync = { created: 0, dropped: 0, moved: 0, repriced: 0 };
    const rules = orm().select().from(ruleTable).where(eq(ruleTable.enabled, true)).all();
    const adding = options.rule !== undefined;
    if (rules.length === 0 && adding) return result;

    const at = now();
    // 録画のしかたは全体で1つ。ルールごとに持たせるとどこで決まったか分からなくなる
    const recording = settings();
    // 種別(GR/BS/CS)でも絞り込めるよう、番組にチャンネル種別と物理チャンネルを添えて取る
    const programs = orm()
        .select({ ...getTableColumns(programTable), service_type: services.type, channel: services.channel })
        .from(programTable)
        .innerJoin(services, eq(services.id, programTable.service_id))
        .where(gt(programTable.start_at, at))
        .orderBy(programTable.start_at)
        .all();

    const compiled = rules.map(compile);
    const searching = adding ? compiled.filter((c) => c.rule.id === options.rule) : compiled;

    const declined = canceledBroadcasts(at);

    /** 番組 → 受け持つルール。同じ番組に何本当たっても予約は1つで、**先勝ち** */
    const wanted = new Map<number, { rule: Rule; program: Program }>();
    /**
     * **同じ放送は1本だけ。** 同じ物理チャンネルの中で、同じ時刻に同じ題名が
     * 流れていたら同じ放送とみなし、いちばん小さい局だけを残す。
     *
     * 局は分割放送のために枝番を持っていて (TOKYO MX なら 23608 / 23609、
     * どちらも名前は「TOKYO MX1」)、**分割していない間は同じ番組が両方に載る**。
     * 素通しにしていた実機では、同じ回が2本録れたうえに、2つのエンコードが
     * 同じ名前のファイルへ同時に書いて中身が壊れた。
     *
     * 中身が違うとき (MX1 と MX2 で別番組) は題名が違うので、両方残る。
     *
     * **終了時刻は鍵に入れない。** 延長は枝番ごとに別々のタイミングで届く
     * (EIT p/f は局ごと) ので、片方だけ `end_at` が動いた回は「別の放送」に
     * 見えて両方が立っていた。開始と題名が同じなら同じ放送。
     */
    const simulcast = new Map<string, { serviceId: number; programId: number }>();
    for (const program of programs) {
        const textOf = textCache(program);
        for (const candidate of searching) {
            if (!matchesCompiled(candidate, program, program.service_type, recording.freeOnly, textOf))
                continue;
            /*
             * **人が取り消した放送には立てない。** 取り消しの記録は番組の id
             * (局 + event_id) に付いているので、`INSERT OR IGNORE` だけに頼ると
             * 枝番違いや event_id の変更ですり抜ける (下の `canceledBroadcasts`)
             */
            if (declined.has(program)) break;
            const key = `${program.channel} ${program.start_at} ${program.name}`;
            const twin = simulcast.get(key);
            if (twin !== undefined) {
                // 枝番の小さいほうが本線 (MX1 なら 23608)。並び順に左右されないよう、
                // あとから小さいものが来たら入れ替える
                if (twin.serviceId <= program.service_id) break;
                wanted.delete(twin.programId);
            }
            simulcast.set(key, { serviceId: program.service_id, programId: program.id });
            wanted.set(program.id, { rule: candidate.rule, program });
            break;
        }
    }

    /** いまルールが立てている予約。手動と、録り始めたものは入らない */
    const held = adding
        ? []
        : orm()
              .select({
                  id: reservations.id,
                  program_id: reservations.program_id,
                  rule_id: reservations.rule_id,
                  priority: reservations.priority,
                  start_at: reservations.start_at,
              })
              .from(reservations)
              .where(
                  and(
                      eq(reservations.manual, false),
                      isNull(reservations.started_at),
                      inArray(reservations.state, ['scheduled', 'conflict']),
                  ),
              )
              .all();
    /** 番組表にまだ載っている番組。読めていないだけのものと区別する */
    const listed = new Map(programs.map((program) => [program.id, program]));
    /** まだ生きているルール。消された/止められたぶんは猶予を置かずに引っ込める */
    const enabled = new Set(rules.map((rule) => rule.id));
    const grace = at + config.ruleRetractGrace;

    orm().transaction((tx) => {
        for (const { rule, program } of wanted.values()) {
            // 同じ番組の予約が既にあれば何もしない (INSERT OR IGNORE)。作れたときだけ行が返る
            const made = tx
                .insert(reservations)
                .values({
                    program_id: program.id,
                    rule_id: rule.id,
                    service_id: program.service_id,
                    name: program.name,
                    description: program.description,
                    start_at: program.start_at,
                    end_at: program.end_at,
                    priority: rule.priority,
                    manual: false,
                    encode: recording.encode,
                    state: 'scheduled',
                    created_at: at,
                    updated_at: at,
                })
                .onConflictDoNothing()
                .returning({ id: reservations.id })
                .get();
            if (made !== undefined) result.created++;
        }

        for (const reservation of held) {
            const owner = wanted.get(reservation.program_id);
            if (owner !== undefined) {
                // 別のルールが引き取った。付け替えるだけで、録るものは変わらない
                if (owner.rule.id !== reservation.rule_id) {
                    tx.update(reservations)
                        .set({ rule_id: owner.rule.id, priority: owner.rule.priority, updated_at: at })
                        .where(eq(reservations.id, reservation.id))
                        .run();
                    result.moved++;
                } else if (owner.rule.priority !== reservation.priority) {
                    /*
                     * **同じルールでも、優先度は当て直す。**
                     *
                     * 予約は `INSERT OR IGNORE` で立てるので、**もう立っている
                     * ぶんは作った日の優先度のまま**だった。ルールの優先度を
                     * 上げても効くのは次に立つ予約からで、いま競合している
                     * 予約はいくら上げても負けたまま — 実機で、優先度2に
                     * 上げた「片田舎のおっさん」が優先度1の裏番組に負け続けて
                     * いた (予約側は3件とも1のまま)。
                     *
                     * 優先度はルールが持つものなので、こちらを本物として扱う
                     */
                    tx.update(reservations)
                        .set({ rule_id: owner.rule.id, priority: owner.rule.priority, updated_at: at })
                        .where(eq(reservations.id, reservation.id))
                        .run();
                    result.repriced++;
                }
                continue;
            }
            const program = listed.get(reservation.program_id);
            // 番組表から消えているだけかもしれない。題名が空のものも判断材料にならない
            if (program === undefined || program.name === '') continue;
            // ルールが生きているのに外れた = 番組表が動いた。直前なら録っておく
            const byChurn = reservation.rule_id !== null && enabled.has(reservation.rule_id);
            if (byChurn && reservation.start_at < grace) continue;
            tx.delete(reservations).where(eq(reservations.id, reservation.id)).run();
            result.dropped++;
        }
    });
    return result;
}
