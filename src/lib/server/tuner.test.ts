import { describe, expect, test } from 'bun:test';
import {
    type AgentTuner,
    openChannelStream,
    recordingHolds,
    recordingOf,
    recordingUse,
    retryWhileBusy,
    TunerBusyError,
} from './tuner';

/**
 * **空きが無いだけなら、掛け直せば通る。**
 *
 * ライブはチャンネルを変える一瞬だけ、前のチャンネルと合わせてチューナーが
 * 2本要る — 前のを離してから頼んでいるが、離れたことがエージェントに届くのは
 * 非同期なので重なる瞬間が残る。地上波は2本しかないので、録画か番組表集めが
 * 1本使っていると、そこで断られていた (実機で
 * `[live] GR:T15: チューナーに空きがありません`)。
 *
 * 字幕側で一度断られると、**そのチャンネルの字幕がそれきり出ない**という
 * 出方をしていた。見ている側は局を選び直すまで戻せない。
 *
 * **待つところは差し替える。** 本当に待たせるとテストがそのぶん延びるだけで、
 * 確かめたいのは「何回掛け直すか」のほう
 */
describe('retryWhileBusy', () => {
    /** 待った回数を数えるだけの、待たない待ち */
    const clock = () => {
        const waits: number[] = [];
        return { waits, wait: async (ms: number) => void waits.push(ms) };
    };

    test('空き待ちなら掛け直して通る', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        const got = await retryWhileBusy(
            () => {
                asked++;
                if (asked === 1) throw new TunerBusyError('空きがありません');
                return Promise.resolve('とれた');
            },
            () => false,
            wait,
        );
        expect(got).toBe('とれた');
        expect(asked).toBe(2);
        expect(waits).toHaveLength(1);
    });

    /** 選局そのものが駄目なら、何度やっても同じ。待たせるだけ無駄 */
    test('空き待ち以外は掛け直さない', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        await expect(
            retryWhileBusy(
                () => {
                    asked++;
                    return Promise.reject(new Error('選局できません (500)'));
                },
                () => false,
                wait,
            ),
        ).rejects.toThrow(/選局できません/);
        expect(asked).toBe(1);
        expect(waits).toHaveLength(0);
    });

    /** 畳まれたなら待たない。見ている人はもう別の局へ行っている */
    test('畳まれたら待たずに諦める', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        await expect(
            retryWhileBusy(
                () => {
                    asked++;
                    return Promise.reject(new TunerBusyError('空きがありません'));
                },
                () => true,
                wait,
            ),
        ).rejects.toThrow(/空きがありません/);
        expect(asked).toBe(1);
        expect(waits).toHaveLength(0);
    });

    /** 待っても空かないなら、いつかは諦める。無限には掛け直さない */
    test('いつかは諦める', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        await expect(
            retryWhileBusy(
                () => {
                    asked++;
                    return Promise.reject(new TunerBusyError('空きがありません'));
                },
                () => false,
                wait,
            ),
        ).rejects.toThrow(/空きがありません/);
        expect(asked).toBeGreaterThan(1);
        expect(asked).toBeLessThanOrEqual(5);
        expect(waits.every((ms) => ms > 0)).toBe(true);
    });
});

/**
 * **録画中の予約がどの本に居るかは、エージェントの一覧の読み手から読む** (`recordingHolds`)。
 * 名乗り (`rec <録画ID>`) の書き方が変わると黙って読めなくなり、録画中の本を空きとして
 * 割り振ってしまうので、書くほうと読むほうを対にして押さえる
 */
describe('recordingHolds', () => {
    const tuner = (over: Partial<AgentTuner>): AgentTuner => ({
        index: 0,
        name: 'mlt0',
        types: ['GR', 'BS', 'CS'],
        disabled: false,
        rank: 1,
        device: null,
        lnb: null,
        channel: { type: 'GR', channel: 'T21' },
        users: [],
        pid: 1234,
        error: null,
        ...over,
    });

    test('録画の名乗りは読み戻せる。録画以外は読まない', () => {
        expect(recordingOf(recordingUse(42))).toBe(42);
        expect(recordingOf('live GR:T21')).toBeNull();
        expect(recordingOf('epg T21')).toBeNull();
        expect(recordingOf('rec 12x')).toBeNull();
    });

    test('録画の読み手がいる本を、録画が終わるまで塞ぐ', () => {
        const ends = new Map([
            [7, 1_000],
            [8, 2_000],
        ]);
        const holds = recordingHolds(
            [
                tuner({
                    users: [
                        { use: recordingUse(7), priority: 10 },
                        { use: recordingUse(8), priority: 10 },
                        { use: 'epg T21', priority: 3 },
                    ],
                }),
                // ライブや番組表集めだけの本は入れない (録画に譲る約束)
                tuner({
                    name: 'gr0',
                    rank: 0,
                    channel: { type: 'GR', channel: 'T16' },
                    users: [{ use: 'live GR:T16', priority: 9 }],
                }),
                // 空いている本
                tuner({ name: 'bs0', rank: 2, channel: null }),
                // 無効にした本
                tuner({
                    name: 'off0',
                    rank: null,
                    disabled: true,
                    users: [{ use: recordingUse(7), priority: 10 }],
                }),
            ],
            (id) => ends.get(id),
        );
        expect(holds).toEqual([{ type: 'GR', channel: 'T21', rank: 1, until: 2_000 }]);
    });

    test('終わる時刻の分からない録画は入れない', () => {
        const holds = recordingHolds(
            [tuner({ users: [{ use: recordingUse(9), priority: 10 }] })],
            () => undefined,
        );
        expect(holds).toEqual([]);
    });
});

/**
 * **引き継ぎ (`after`) は、選局の口にそのまま並べて渡す。** エージェントは何度でも書ける
 * `after` を読み、その読み手をもう離れたものとして選ぶ (docs/agent.md「選ぶ順の約束」の4)
 */
describe('openChannelStream の引き継ぎ', () => {
    test('止めた録画の読み手を after に並べる', async () => {
        const asked: URLSearchParams[] = [];
        const agent = Bun.serve({
            port: 0,
            fetch(request) {
                asked.push(new URL(request.url).searchParams);
                return new Response('');
            },
        });
        const { config } = await import('./config');
        const before = config.agentUrl;
        config.agentUrl = `http://127.0.0.1:${agent.port}`;
        try {
            const aborter = new AbortController();
            await openChannelStream('BS', 'BS11_0', aborter.signal, recordingUse(9), 10, [
                recordingUse(7),
                recordingUse(8),
            ]);
            aborter.abort();
        } finally {
            config.agentUrl = before;
            agent.stop(true);
        }
        expect(asked[0]?.getAll('after')).toEqual(['rec 7', 'rec 8']);
        expect(asked[0]?.get('use')).toBe('rec 9');
    });
});
