import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, eq, sql } from 'drizzle-orm';

/**
 * 局だけの取り込み。
 *
 * どの局が居るかを知っているのは**エージェント** (チャンネルスキャンの結果) で、
 * 番組表を集めるのは denpa 自身。集めるほうは1チャンネルに数分かかるので、
 * 局だけ先に取り込めることを確かめる。
 *
 * 環境変数ではなく設定そのものを書き換えている (files.test.ts と同じ理由)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-epg-')), 'denpa.db');

/** 何を取りに来たか。番組表を取りに行っていないことまで見る */
const asked: string[] = [];

function channel(serviceId: number, name: string, serviceType = 1) {
    return {
        type: 'GR',
        channel: 'T16',
        networkId: 32391,
        transportStreamId: 32391,
        remoteControlKeyId: 9,
        services: [{ serviceId, serviceType, name }],
    };
}

/** エージェントが返すチャンネル。テストの途中で入れ替える */
let offered = [
    channel(23608, 'ＴＯＫＹＯ　ＭＸ'),
    // データ放送。映像が入っていないので取り込まない
    channel(700, 'ＭＸデータ１', 192),
];

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (path === '/denpa/channels') return Response.json(offered);
        return new Response('not found', { status: 404 });
    },
});
config.agentUrl = `http://127.0.0.1:${server.port}`;

const { orm } = await import('./db');
const { programs, recordings, reservations, services } = await import('./schema');
const { airing, savePrograms, SERVICE_ORDER, SERVICE_TYPE_ORDER, settle, syncServicesOnly, widenServices } =
    await import('./epg');
const { getChannels } = await import('./tuner');

describe('syncServicesOnly', () => {
    test('番組表を待たずに局だけ取り込む', async () => {
        expect(syncServicesOnly(await getChannels())).toBe(1);

        const rows = orm()
            .select({ id: services.id, name: services.name, type: services.type })
            .from(services)
            .all();
        // 局名は放送のとおり (全角の英数は全角のまま)。比べるときに寄せる
        // 内部IDは networkId * 100000 + serviceId。録画が参照しているので変えられない
        expect(rows).toEqual([{ id: 3239123608, name: 'ＴＯＫＹＯ　ＭＸ', type: 'GR' }]);

        // 選局していないこと。局の一覧はスキャンの結果を読むだけで手に入る
        expect(asked).toEqual(['/denpa/channels']);
        expect(orm().select({ n: count() }).from(programs).get()).toEqual({ n: 0 });
    });

    test('何度呼んでも増えない', async () => {
        syncServicesOnly(await getChannels());
        expect(orm().select({ n: count() }).from(services).get()).toEqual({ n: 1 });
    });
});

/**
 * 局名の幅。エージェントの控えはスキャンしたときの読み方のままなので、英数を半角で
 * 読んでいた頃のスキャンなら「TOKYO MX」。放送のとおりの幅は SDT から入れる (`widenServices`)
 */
describe('局名の幅', () => {
    const name = () =>
        orm().select({ name: services.name }).from(services).where(eq(services.id, 3239123608)).get()?.name;

    test('SDT の幅に直す。録画の局名も一緒に', async () => {
        // 半角に寄せて取り込んでいた頃の行と、英数を半角で読んでいた頃のスキャン
        orm().update(services).set({ name: 'TOKYO MX' }).where(eq(services.id, 3239123608)).run();
        offered = [channel(23608, 'TOKYO MX')];
        syncServicesOnly(await getChannels());
        expect(name()).toBe('TOKYO MX');
        const at = Date.now();
        const recording = (id: number, service_name: string) => ({
            id,
            service_id: 3239123608,
            service_name,
            name: '番組',
            start_at: at,
            end_at: at + 1000,
            created_at: at,
            updated_at: at,
        });
        orm()
            .insert(recordings)
            .values([recording(1, 'TOKYO MX'), recording(2, '昔の局名')])
            .run();

        expect(widenServices(32391, [{ serviceId: 23608, name: 'ＴＯＫＹＯ　ＭＸ' }])).toBe(1);
        expect(name()).toBe('ＴＯＫＹＯ　ＭＸ');
        expect(
            orm().select({ id: recordings.id, service_name: recordings.service_name }).from(recordings).all(),
        ).toEqual([
            { id: 1, service_name: 'ＴＯＫＹＯ　ＭＸ' },
            // 局名が変わる前に録ったものは、その頃の名前のまま
            { id: 2, service_name: '昔の局名' },
        ]);
        orm().delete(recordings).run();
    });

    test('毎分の取り込みは幅だけ違う名前で戻さない。名前そのものが変われば入れ替える', async () => {
        syncServicesOnly(await getChannels());
        expect(name()).toBe('ＴＯＫＹＯ　ＭＸ');

        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ２')];
        syncServicesOnly(await getChannels());
        expect(name()).toBe('ＴＯＫＹＯ　ＭＸ２');
    });

    test('SDT は名前そのものを変えない (スキャンが決める)', () => {
        expect(widenServices(32391, [{ serviceId: 23608, name: '別の局' }])).toBe(0);
        expect(name()).toBe('ＴＯＫＹＯ　ＭＸ２');
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ'), channel(700, 'ＭＸデータ１', 192)];
    });
});

/**
 * 選局できなくなった局の片付け。
 *
 * スキャンをやり直すと局は普通に入れ替わる。番組表を置いたままにしていた頃は、
 * もう選局できない局の番組が数万件残り、検索にも引っかかり続けていた。
 */
describe('消えた局の片付け', () => {
    function seed(serviceId: number): void {
        orm().delete(programs).run();
        orm().delete(reservations).run();
        const at = Date.now();
        orm()
            .insert(programs)
            .values({
                id: 1,
                service_id: serviceId,
                network_id: 32391,
                event_id: 1,
                start_at: at,
                end_at: at + 1800_000,
                name: '消える局の番組',
                updated_at: at,
            })
            .run();
        orm()
            .insert(reservations)
            .values({
                id: 1,
                program_id: 1,
                service_id: serviceId,
                name: '消える局の予約',
                start_at: at,
                end_at: at + 1800_000,
                created_at: at,
                updated_at: at,
            })
            .run();
    }

    /** その局を「しばらく見かけていない」ことにする。時計を進める代わり */
    function unseenFor(serviceId: number, ms: number): void {
        orm()
            .update(services)
            .set({ updated_at: Date.now() - ms })
            .where(eq(services.id, serviceId))
            .run();
    }

    test('番組表は消し、まだ始めていない予約は取り消す。局の行は残す', async () => {
        syncServicesOnly(await getChannels());
        seed(3239123608);

        // 局が丸ごと入れ替わった (スキャンのやり直し)
        offered = [channel(23609, '別の局')];
        syncServicesOnly(await getChannels());
        unseenFor(3239123608, config.serviceForgetAfter + 1);
        syncServicesOnly(await getChannels());

        expect(orm().select({ n: count() }).from(programs).get()).toEqual({ n: 0 });
        expect(
            orm()
                .select({ state: reservations.state })
                .from(reservations)
                .where(eq(reservations.id, 1))
                .get(),
        ).toEqual({
            state: 'canceled',
        });
        /*
         * 局の行そのものは残す。消すと、その局で録った録画や過去の予約が
         * 辿れなくなる。画面に出さない仕組みは別にある (CURRENT_SERVICES)
         */
        expect(orm().select({ n: count() }).from(services).get()).toEqual({ n: 2 });
    });

    test('1局も返ってこなかった回では何もしない', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        seed(3239123608);

        /*
         * エージェントは起動直後や不調で空を返すことがある。それを「全部消えた」と
         * 読むと、次の取り込みまで番組表が丸ごと消える
         */
        offered = [];
        syncServicesOnly(await getChannels());

        expect(orm().select({ n: count() }).from(programs).get()).toEqual({ n: 1 });
        expect(
            orm()
                .select({ state: reservations.state })
                .from(reservations)
                .where(eq(reservations.id, 1))
                .get(),
        ).toEqual({
            state: 'scheduled',
        });
    });

    /*
     * **実機で踏んだところ。** エージェントからは空だけでなく*欠けた*一覧も返る。
     * そちらは「1局も返ってこなかった」の網に掛からないので、まだ現役の局
     * (NHK総合1・TOKYO MX1・テレ東…) の予約が 44 件まとめて取り消されていた。
     * 一覧は1分ごとに取り直しているので、1回ぐらい欠けても待てばいい
     */
    test('1回見かけなかっただけでは片付けない', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ'), channel(23609, '別の局')];
        syncServicesOnly(await getChannels());
        seed(3239123608);

        // 一覧が欠けた回
        offered = [channel(23609, '別の局')];
        syncServicesOnly(await getChannels());

        expect(orm().select({ n: count() }).from(programs).get()).toEqual({ n: 1 });
        expect(
            orm()
                .select({ state: reservations.state })
                .from(reservations)
                .where(eq(reservations.id, 1))
                .get(),
        ).toEqual({
            state: 'scheduled',
        });
    });
});

/**
 * 番組の取り込み。
 *
 * 番組表は「基本」(題名) と「詳細」(番組内容) の2つの表に分かれて放送されていて、
 * 読むほうも分けて届く ([ts/eit.ts](../ts/eit.ts) の EpgReader.merge)。
 * 片方しか読めなかった回に、もう片方を消させない。
 */
describe('savePrograms', () => {
    function event(overrides: Record<string, unknown> = {}) {
        return {
            serviceId: 23608,
            transportStreamId: 32391,
            originalNetworkId: 32391,
            eventId: 7,
            startAt: Date.now(),
            duration: 1800_000,
            isFree: true,
            runningStatus: 0,
            name: 'テスト番組',
            description: 'これは説明です',
            extended: {},
            genres: [],
            audios: [],
            video: null,
            ...overrides,
        } as Parameters<typeof savePrograms>[0][number];
    }

    test('題名の無い回で、入っている題名を消さない', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();

        savePrograms([event()]);
        // 詳細だけ読めた回。題名も説明も空で来る
        savePrograms([event({ name: '', description: '', extended: { 番組内容: 'あらすじ' } })]);

        expect(
            orm()
                .select({
                    name: programs.name,
                    description: programs.description,
                    extended: programs.extended,
                })
                .from(programs)
                .all(),
        ).toEqual([
            { name: 'テスト番組', description: 'これは説明です', extended: { 番組内容: 'あらすじ' } },
        ]);
    });

    // 文を使い回す形にしたとき (drizzle の placeholder)、null が文字の "null" になりかけた
    test('空の JSON 列は NULL のまま、中身があれば JSON の文字で入る', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();

        savePrograms([
            event({ eventId: 1 }),
            event({
                eventId: 2,
                startAt: Date.now() + 3600_000,
                isFree: false,
                extended: { 番組内容: 'あらすじ' },
                genres: [{ lv1: 7, lv2: 0 }],
                audios: [{ componentType: 3, langs: ['jpn'], text: '解説' }],
                video: { type: 'mpeg2', resolution: '1080i' },
            }),
        ]);

        const raw = orm().all<Record<string, unknown>>(
            sql`SELECT event_id, typeof(extended) AS kind, extended, genres, genre_detail, audios, audio_type, is_free, video_type, video_resolution FROM programs ORDER BY event_id`,
        );
        expect(raw).toEqual([
            {
                event_id: 1,
                kind: 'null',
                extended: null,
                genres: null,
                genre_detail: null,
                audios: null,
                audio_type: null,
                is_free: 1,
                video_type: null,
                video_resolution: null,
            },
            {
                event_id: 2,
                kind: 'text',
                extended: '{"番組内容":"あらすじ"}',
                genres: '[7]',
                genre_detail: '[{"lv1":7,"lv2":0}]',
                audios: '[{"componentType":3,"langs":["jpn"],"text":"解説"}]',
                audio_type: 3,
                is_free: 0,
                video_type: 'mpeg2',
                video_resolution: '1080i',
            },
        ]);
    });

    /*
     * **予約の追従。** 番組表が書き換わったぶんを、まだ始めていない予約に写す。
     * 時刻だけでなく名前も (「[新]」が付く、サブタイトルが入る)。録り始めた予約は動かさない
     */
    test('番組表が動いたら、まだ始めていない予約だけ追従する', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();
        orm().delete(reservations).run();

        const base = Date.now() + 3 * 3600_000;
        savePrograms([
            event({ eventId: 1, startAt: base, duration: 1800_000 }),
            event({ eventId: 2, name: '録画中の番組', startAt: base + 3600_000, duration: 1800_000 }),
        ]);
        const [waiting, started] = orm()
            .select({ id: programs.id })
            .from(programs)
            .orderBy(programs.event_id)
            .all();
        if (waiting === undefined || started === undefined) throw new Error('番組が入っていない');
        // 予約は古い時刻と名前のまま
        // 手で入れた予約 (ルールに紐付かないものは、当て直しで引っ込められないように manual)
        const stale = {
            service_id: 3239123608,
            name: '古い名前',
            manual: true,
            created_at: base,
            updated_at: base,
        };
        orm()
            .insert(reservations)
            .values([
                { id: 1, program_id: waiting.id, start_at: base - 60_000, end_at: base + 1800_000, ...stale },
                // 録り始めている
                {
                    id: 2,
                    program_id: started.id,
                    start_at: base + 3600_000 - 60_000,
                    end_at: base + 5400_000,
                    started_at: base,
                    ...stale,
                },
            ])
            .run();

        expect(settle().retimed).toBe(1);
        expect(
            orm()
                .select({ id: reservations.id, name: reservations.name, start_at: reservations.start_at })
                .from(reservations)
                .orderBy(reservations.id)
                .all(),
        ).toEqual([
            { id: 1, name: 'テスト番組', start_at: base },
            { id: 2, name: '古い名前', start_at: base + 3600_000 - 60_000 },
        ]);
        // 二度目は何も動かない
        expect(settle().retimed).toBe(0);
    });

    test('題名だけ読めた回で、入っている番組内容を消さない', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();

        savePrograms([event({ name: '', description: '', extended: { 番組内容: 'あらすじ' } })]);
        savePrograms([event()]);

        expect(
            orm().select({ name: programs.name, extended: programs.extended }).from(programs).all(),
        ).toEqual([{ name: 'テスト番組', extended: { 番組内容: 'あらすじ' } }]);
    });

    test('題名の書き換えはこれまでどおり通る', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();

        savePrograms([event()]);
        savePrograms([event({ name: '[新]テスト番組' })]);

        expect(orm().select({ name: programs.name }).from(programs).all()).toEqual([
            { name: '[新]テスト番組' },
        ]);
    });

    test('延長で重なった番組は消える (あとから来たほうが勝つ)', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();

        const base = Date.now();
        // 野球 10:15〜11:05 と、その後の2本
        savePrograms([
            event({ eventId: 1, name: '野球', startAt: base, duration: 50 * 60_000 }),
            event({ eventId: 2, name: 'きょうの料理', startAt: base + 50 * 60_000, duration: 25 * 60_000 }),
            event({ eventId: 3, name: 'うまいッ!', startAt: base + 75 * 60_000, duration: 24 * 60_000 }),
        ]);

        // 野球が 11:54 まで延長 (EIT[p/f])。潰された2本は局の送り直しまで書き換わらない
        savePrograms([event({ eventId: 1, name: '野球', startAt: base, duration: 99 * 60_000 })]);

        expect(orm().select({ name: programs.name }).from(programs).orderBy(programs.start_at).all()).toEqual(
            [{ name: '野球' }],
        );
    });

    test('隣り合っているだけ (境界が同じ) の番組は消えない', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        syncServicesOnly(await getChannels());
        orm().delete(programs).run();

        const base = Date.now();
        savePrograms([
            event({ eventId: 1, name: '前の番組', startAt: base, duration: 30 * 60_000 }),
            event({ eventId: 2, name: '次の番組', startAt: base + 30 * 60_000, duration: 30 * 60_000 }),
        ]);
        // 同じものをもう一度読んでも (カルーセルは回り続ける) 隣は消えない
        savePrograms([event({ eventId: 1, name: '前の番組', startAt: base, duration: 30 * 60_000 })]);

        expect(orm().select({ name: programs.name }).from(programs).orderBy(programs.start_at).all()).toEqual(
            [{ name: '前の番組' }, { name: '次の番組' }],
        );
    });
});

/**
 * 枠はあるが放送していない局を、番組表から外す。
 *
 * - 終わったチャンネル (BS103 は 2024年3月で放送終了。SDT に枠だけ残る)
 * - 相乗り中のサブチャンネル (NHK総合2 は、マルチ編成でない間ずっと名前が無い)
 */
describe('番組表に出す局', () => {
    // 別々の放送局 (TS が違う)。サブチャンネルは下で別に作る
    const service = (id: number, channel = `T${id}`, type = 'GR') => ({
        id,
        service_id: 1024 + id,
        channel,
        type,
    });
    const program = (serviceId: number, name: string, start = 0, end = 1) => ({
        service_id: serviceId,
        name,
        start_at: start,
        end_at: end,
    });

    test('名前の付いた番組が1つも無い局は出さない', () => {
        const services = [service(1), service(2), service(3)];
        const programs = [
            program(1, 'ニュース'),
            // 相乗り中のサブチャンネル。名前の無い番組だけが並ぶ
            program(2, ''),
            program(2, ''),
            // 3 は終わったチャンネル。番組が1つも来ない
        ];

        expect(airing(services, programs).map((s) => s.id)).toEqual([1]);
    });

    test('1つでも名前が付いていれば出す', () => {
        // マルチ編成の日だけサブチャンネルにも名前が付く
        const services = [service(1), service(2)];
        const programs = [program(2, ''), program(2, '大相撲')];

        expect(airing(services, programs).map((s) => s.id)).toEqual([2]);
    });

    test('本チャンネルと同じ名前の番組を流しているサブチャンネルは出さない', () => {
        // 1 が本チャンネル、2・3 はサブ (同じ TS)。番組表の `splitOf` と同じ決め方
        const services = [service(1, 'T9'), service(2, 'T9'), service(3, 'T9')];
        const programs = [
            program(1, 'ニュース', 0, 10),
            program(2, 'ニュース', 5, 15),
            program(3, '野球', 0, 10),
        ];

        expect(airing(services, programs).map((s) => s.id)).toEqual([1, 3]);
    });

    test('BS も同じ TS のサブは相乗り中なら出さない。TS が別なら同じ会社でも出す', () => {
        const bs = (sid: number, channel: string) => ({ id: sid, service_id: sid, channel, type: 'BS' });
        const services = [
            // BS朝日1〜3
            bs(151, 'BS01_3'),
            bs(152, 'BS01_3'),
            bs(153, 'BS01_3'),
            // NHK BS。103 は番組の来ない枠 (局名「-」)
            bs(101, 'BS15_0'),
            bs(103, 'BS15_0'),
            // WOWOW プライム・ライブ・シネマ。TS が別々
            bs(191, 'BS03_3'),
            bs(192, 'BS05_3'),
            bs(193, 'BS05_1'),
            // J SPORTS 1・2
            bs(242, 'BS19_1'),
            bs(243, 'BS19_2'),
        ];
        const programs = [
            program(151, 'ニュース', 0, 10),
            program(152, 'ニュース', 0, 10),
            program(153, '野球', 0, 10),
            program(101, 'ニュース', 0, 10),
            program(191, '映画', 0, 10),
            program(192, 'ライブ', 0, 10),
            program(193, '映画', 0, 10),
            program(242, 'サッカー', 0, 10),
            program(243, 'サッカー', 0, 10),
        ];

        expect(airing(services, programs).map((s) => s.id)).toEqual([151, 153, 101, 191, 192, 193, 242, 243]);
    });

    test('CS は同じ TS でも束ねない', () => {
        const services = [service(1, 'CS2', 'CS'), service(2, 'CS2', 'CS')];
        const programs = [program(1, 'ニュース'), program(2, 'ニュース')];

        expect(airing(services, programs).map((s) => s.id)).toEqual([1, 2]);
    });

    test('1局も残らないときは全部出す', () => {
        // 入れたばかりで番組表が空のとき。列ごと消えると先へ進めない
        const services = [service(1), service(2)];

        expect(airing(services, []).map((s) => s.id)).toEqual([1, 2]);
    });
});

/**
 * 局の並び。**テレビと同じ順にする。**
 *
 * リモコン番号を持つのは地上波だけで、BS と CS はサービスID がそのまま
 * テレビの3桁番号にあたる。物理チャンネル順に並べていた頃は実機と食い違っていた。
 */
describe('SERVICE_ORDER', () => {
    function put(
        id: number,
        serviceId: number,
        type: 'GR' | 'BS' | 'CS',
        channel: string,
        key: number | null,
        name: string,
    ) {
        orm()
            .insert(services)
            .values({
                id,
                service_id: serviceId,
                network_id: 4,
                name,
                type,
                service_type: 1,
                channel,
                remote_control_key: key,
                updated_at: 1,
            })
            .run();
    }

    const ordered = (order: string) =>
        orm()
            .select({ name: services.name })
            .from(services)
            .orderBy(sql.raw(order))
            .all()
            .map((row) => row.name);

    test('BS は物理チャンネルではなく3桁番号の順に並ぶ', () => {
        orm().delete(services).run();
        // 実機の並び。BS-TBS (161) は BS朝日 (151) より前の中継に乗っている
        put(400161, 161, 'BS', 'BS01_1', null, 'BS-TBS');
        put(400151, 151, 'BS', 'BS01_3', null, 'BS朝日1');
        put(400191, 191, 'BS', 'BS03_3', null, 'WOWOWプライム');

        expect(ordered(SERVICE_ORDER)).toEqual(['BS朝日1', 'BS-TBS', 'WOWOWプライム']);
        // 物理チャンネル順だと、テレビと食い違う
        expect(ordered('channel, service_id')).toEqual(['BS-TBS', 'BS朝日1', 'WOWOWプライム']);
    });

    test('地上波はリモコン番号順。同じ番号ならサービスID順', () => {
        orm().delete(services).run();
        put(3273601025, 1025, 'GR', 'T27', 1, 'NHK総合2');
        put(3273601024, 1024, 'GR', 'T27', 1, 'NHK総合1');
        put(3239123608, 23608, 'GR', 'T16', 9, 'TOKYO MX1');

        expect(ordered(SERVICE_ORDER)).toEqual(['NHK総合1', 'NHK総合2', 'TOKYO MX1']);
    });

    test('地上波 → BS → CS の順。テレビの切り替えもこの順', () => {
        orm().delete(services).run();
        put(400151, 151, 'BS', 'BS01_3', null, 'BS朝日1');
        put(600292, 292, 'CS', 'CS04', null, '時代劇専門ch');
        put(3239123608, 23608, 'GR', 'T16', 9, 'TOKYO MX1');

        expect(ordered(`${SERVICE_TYPE_ORDER}, ${SERVICE_ORDER}`)).toEqual([
            'TOKYO MX1',
            'BS朝日1',
            '時代劇専門ch',
        ]);
    });
});
