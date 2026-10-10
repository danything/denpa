import { fail } from '@sveltejs/kit';
import { and, count, eq, sql } from 'drizzle-orm';
import { orm } from '#lib/server/db.js';
import { CURRENT_SERVICES } from '#lib/server/epg.js';
import { collectNow, collectState } from '#lib/server/epg-collect.js';
import { stats as logoStats, sweepNow, sweepState } from '#lib/server/logo.js';
import { forgetLogoData, learnedAt, stats as learnStats, siblings, stations } from '#lib/server/logo-data.js';
import { refresh, start, stop } from '#lib/server/scan.js';
import { programs, recordings, services } from '#lib/server/schema.js';
import { cardStatus } from '#lib/server/scramble.js';
import {
    type AgentTuner,
    getTuners,
    putTuners,
    type TunerConfig,
    tunersDetected,
} from '#lib/server/tuner.js';
import type { ChannelType } from '#lib/types.js';

/** 局1つぶんの、CM検出ロゴの覚え具合 */
interface CmLogo {
    id: number;
    name: string;
    /** 覚えたものを最後に書いた時刻。覚えていなければ null */
    learned_at: number | null;
}

const TYPES: ChannelType[] = ['GR', 'BS', 'CS'];

interface TunerUser {
    use: string;
    priority: number;
    /** 画面に出す言葉 */
    label: string;
}

/**
 * 掴んでいる相手を読める言葉に直す。
 *
 * エージェントが持っているのは用途の印だけで、そこには ASCII しか載せられない
 * (以前は HTTP ヘッダに載せていた名残で、いまも短いままにしてある)。
 * 番組名はここで引き直す。
 */
function describe(use: string): string {
    const recording = use.match(/^rec (\d+)$/);
    if (recording !== null) {
        const row = orm()
            .select({ name: recordings.name })
            .from(recordings)
            .where(eq(recordings.id, Number(recording[1])))
            .get();
        return row === undefined ? '録画' : `録画: ${row.name}`;
    }

    const logo = use.match(/^logo \S+\/(\S+)$/);
    if (logo !== null) return `局ロゴ収集 (${logo[1]})`;

    const epg = use.match(/^epg (\S+)$/);
    if (epg !== null) return `番組表 (${epg[1]})`;

    const scan = use.match(/^scan (\S+)$/);
    if (scan !== null) return `チャンネルスキャン (${scan[1]})`;

    const live = use.match(/^live (\S+)$/);
    if (live !== null) return `ライブ視聴 (${live[1]})`;

    return use;
}

function withLabels(tuners: AgentTuner[]): (Omit<AgentTuner, 'users'> & { users: TunerUser[] })[] {
    return tuners.map((tuner) => ({
        ...tuner,
        users: tuner.users.map((user) => ({ ...user, label: describe(user.use) })),
    }));
}

/** 物理チャンネル1本と、そこに乗っている局 */
interface Coverage {
    type: ChannelType;
    channel: string;
    services: { id: number; name: string; programs: number; until: number }[];
}

/**
 * 取れているチャンネルと、局ごとの番組表の集まり具合。**denpa 自身のDBから。**
 *
 * エージェントにも同じ顔ぶれの控えがある (スキャンの結果を預けてあるので) が、
 * **聞きに行かない。** 向こうが持っているのは選局に要る周波数と TSID のためで、
 * 局名も番組表も denpa のもの。両方を並べていた頃は、取り込みが1分おきだった
 * 名残で「denpa への取り込み待ち」を出していたが、いまはスキャンが終わった
 * その場で取り込む (scan.ts) ので、待ちようがない。
 *
 * 出すのは**いま選局できる局だけ**。スキャンをやり直すと局は入れ替わり、
 * 前の回の行は残る (録画や過去の予約が辿れなくなるので消せない)。
 */
function coverage(): Coverage[] {
    const rows = orm()
        .select({
            id: services.id,
            name: services.name,
            type: services.type,
            channel: services.channel,
            programs: count(programs.id),
            until: sql`COALESCE(MAX(${programs.end_at}), 0)`.mapWith(Number),
        })
        .from(services)
        .leftJoin(programs, eq(programs.service_id, services.id))
        // 取り残しの局は出さない (CURRENT_SERVICES と同じ。番組表と JOIN するので列を名指しする)
        .where(sql`${services.updated_at} >= (SELECT MAX(${services.updated_at}) FROM ${services})`)
        .groupBy(services.id)
        .orderBy(services.service_id)
        .all();

    const order: Record<string, number> = { GR: 0, BS: 1, CS: 2 };
    const channels = new Map<string, Coverage>();
    for (const { id, name, type, channel, programs, until } of rows) {
        const key = `${type}:${channel}`;
        const entry = channels.get(key) ?? { type, channel, services: [] };
        entry.services.push({ id, name, programs, until });
        channels.set(key, entry);
    }
    return [...channels.values()].sort(
        (a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.channel.localeCompare(b.channel),
    );
}

export async function load() {
    return {
        // スキャンの進み具合。回しているのは denpa 自身 (scan.refresh)
        scan: refresh(),
        /*
         * 定義を書いていないので自動で見つけた状態か。
         *
         * 出さないと「画面の内容がどこから来たのか」が分からない — 保存すると
         * それが固定されるので、そこは言っておく必要がある
         */
        detected: tunersDetected().catch(() => false),
        /*
         * 以下は相手待ちなので promise のまま返して後から流し込む。
         * 待つと画面が出ない
         *
         * 繋がらなかった理由も一緒に返す。空の一覧だけ渡すと「チューナーが
         * 1本も無い」と区別が付かない (以前はエージェントの生死を別の行に
         * 出していたが、見るところが増えるだけだった)
         */
        tuners: getTuners()
            .then((list) => ({ list: withLabels(list), error: null as string | null }))
            .catch((error: unknown) => ({ list: [], error: String(error) })),
        channels: coverage(),
        card: cardStatus(),
        /** 番組表を集めている最中の様子。1チャンネルに数分かかる */
        collect: collectState(),
        /*
         * 局ロゴを何局ぶん持っているか。
         *
         * ロゴは放送波から拾うしかないが、拾えたかどうかを確かめる場所が
         * どこにも無かった。番組表にロゴが出ないとき、取れていないのか
         * 出し方が悪いのかを見分けられるようにする
         */
        logos: logoStats(),
        /*
         * 取りに行っている最中の様子。1チャンネルに数分かかるので、出さないと
         * 押しても何も起きていないように見える
         */
        logoSweep: sweepState(),
        /*
         * CM検出のロゴ。**番組表に出す局ロゴとは別物** (logo-data.ts)。
         *
         * 覚えたものを確かめて、違っていれば捨てる。**録画の詳細ではなく局の話**
         * なので、局を並べているこの画面に置く
         */
        cmLogos: cmLogoState(),
        cmLogoStats: learnStats(),
    };
}

/**
 * 局ごとの、CM検出ロゴの覚え具合。
 *
 * **いま選局できる局だけ**にする。数え上げ (`logo-data.stats`) と揃えないと、
 * 「6 / 46 局」と出ている下に 125 局が並ぶ。
 */
function cmLogoState(): CmLogo[] {
    const rows = orm()
        .select({ id: services.id, network_id: services.network_id, name: services.name })
        .from(services)
        .where(and(eq(services.service_type, 1), sql.raw(CURRENT_SERVICES)))
        .orderBy(sql`${services.remote_control_key} IS NULL`, services.remote_control_key, services.id)
        .all();
    // 同じ絵を映しているサブチャンネルの枠は束ねる (実機で「TOKYO MX1」が2つ並んでいた)
    return stations(rows).map((service) => ({
        id: service.id,
        name: service.name,
        learned_at: learnedAt(service.id),
    }));
}

export const actions = {
    /**
     * 覚えたロゴを捨てる。
     *
     * 自動の割り出しが拾うのは「画面の隅で線の向きが毎コマ揃うこと」だけなので、
     * ロゴではないもの (番組がずっと出しているテロップの飾り、常時出ている枠) を
     * 覚えることがある。
     *
     * 捨てれば、**次にその局を録ってエンコードしたときに一から覚え直します** (`logo-own`)
     */
    logoForget: async ({ request }) => {
        const form = await request.formData();
        const serviceId = Number(form.get('serviceId'));
        if (!Number.isFinite(serviceId)) return fail(400, { message: '局IDが不正です' });
        // 同じ絵を映しているサブチャンネルの枠にも配ってある (`logo-data.share`)
        for (const id of [serviceId, ...siblings(serviceId)]) forgetLogoData(id);
        return { success: true, done: '覚えたロゴを消しました。次にこの局を録画したときに覚え直します' };
    },

    /**
     * 番組表をいますぐ集める。**全チューナーで、録画以外は蹴って。**
     *
     * 入れたばかりのときのためのもの。普段の周回はスキャンにもロゴにも譲るので、
     * 何か動いていると番組表がなかなか埋まらない。
     *
     * **待たない。** 全チャンネル回ると数分〜十数分かかる。押した人には
     * 始めたことだけ返して、進み具合は画面に流す (`collect`)
     */
    collectNow: async () => {
        void collectNow().catch(() => undefined);
        return { success: true, scan: '番組表を集めています。空いているチューナーを全部使います' };
    },

    scan: async ({ request }) => {
        const form = await request.formData();
        const types = form
            .getAll('types')
            .map(String)
            .filter((t): t is ChannelType => TYPES.includes(t as ChannelType));
        if (types.length === 0) return fail(400, { message: 'スキャンする種別を選んでください' });

        const result = await start({ types });
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },

    /** 機材の定義を書き換える。渡すのはデバイスと種別だけ (選局はエージェントが組み立てる) */
    tuners: async ({ request }) => {
        const form = await request.formData();

        /*
         * 行ごとに `name.0` `device.0` … と名前を分けてある。
         *
         * 同じ名前を並べて `getAll()` で拾う形だと、チェックの外れた行が
         * 送られてこないぶんだけ番号がずれて、別の行の設定が混ざる
         */
        const rows = new Set<number>();
        for (const key of form.keys()) {
            const match = key.match(/^name\.(\d+)$/);
            if (match !== null) rows.add(Number(match[1]));
        }

        const tuners: TunerConfig[] = [];
        for (const index of [...rows].sort((a, b) => a - b)) {
            const name = String(form.get(`name.${index}`) ?? '').trim();
            // 名前を空にした行は「消した」とみなす
            if (name === '') continue;

            const types = TYPES.filter((type) => form.get(`type.${index}.${type}`) !== null);
            if (types.length === 0) {
                return fail(400, { message: `${name}: 受信できる種別を1つ以上選んでください` });
            }
            const device = String(form.get(`device.${index}`) ?? '').trim();
            if (device === '') return fail(400, { message: `${name}: デバイスのパスを入れてください` });

            tuners.push({
                name,
                types,
                device,
                lnb: String(form.get(`lnb.${index}`) ?? '').trim() || null,
                disabled: form.get(`disabled.${index}`) !== null,
            });
        }

        try {
            await putTuners(tuners);
        } catch (error) {
            return fail(502, { message: String(error) });
        }
        return { success: true, done: `チューナー ${tuners.length} 本を保存しました` };
    },

    /** 定義を消して自動検出に戻す。刺さっている機材をエージェントが自分で見つける */
    tunersAuto: async () => {
        try {
            await putTuners([]);
        } catch (error) {
            return fail(502, { message: String(error) });
        }
        return { success: true, done: '自動検出に戻しました' };
    },

    /** 走っているスキャンを中断する。設定は書き換えないまま止まる */
    scanStop: async () => {
        const result = await stop();
        if (!result.stopped) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },

    /**
     * 局ロゴを取りに行く。**チューナー2つで、衛星も混ぜて。**
     *
     * ロゴは放送波に数十秒〜数分に一度しか流れてこないので、押してもその場では
     * 出ない。どこまで進んだかを画面に流すので、押した人は待たなくていい。
     *
     * 衛星も対象にする。ロゴを運ぶ中継は1つだけで、当たれば数十秒で全局ぶんが
     * 揃い、外れは PAT を見た時点 (1秒ほど) で次へ行くので、待たせる時間は
     * 地上波と変わらない。当たり外れは覚えるので、二度目からは当たりだけを開く
     */
    logoSweep: async () => {
        const result = await sweepNow();
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },
};
