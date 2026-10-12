import { afterEach, describe, expect, test } from 'bun:test';
import type { ResponseMessage } from '#lib/ts/bml-protocol.js';
import { type Bml, type BmlOptions, createBml } from './engine';

/*
 * エンジンを丸ごと動かす。描く先はブラウザではないので、何でも受け取る小さな偽の DOM に描かせる
 * (中身は見ない。確かめるのはエンジンがページの手を放すか)
 */

type Loose = Record<PropertyKey, unknown>;

function fakeNode(): unknown {
    const store: Loose = {};
    const self: unknown = new Proxy(() => {}, {
        get(_, key) {
            if (key in store) return store[key];
            if (key === Symbol.toPrimitive) return () => '';
            if (key === Symbol.iterator) return function* () {};
            if (key === 'then') return undefined;
            store[key] = fakeNode();
            return store[key];
        },
        set(_, key, value) {
            store[key] = value;
            return true;
        },
        apply: () => fakeNode(),
    });
    return self;
}

const globals = globalThis as unknown as Loose;
globals['ShadowRoot'] ??= class {};

const media = (type: string, subtype: string) => ({
    type,
    originalType: type,
    subtype,
    originalSubtype: subtype,
    parameters: [],
});

/** 入口 (/40/0000) に文書と添えるファイルを置いて、届いたことにする */
function carousel(files: [string, string, string][], version = 1): ResponseMessage[] {
    return [
        { type: 'pmt', components: [{ pid: 0x140, componentId: 0x40, streamType: 0x0d }] },
        {
            type: 'moduleListUpdated',
            componentId: 0x40,
            modules: [{ id: 0, version, size: 1 }],
            dataEventId: 1,
        },
        {
            type: 'moduleDownloaded',
            componentId: 0x40,
            moduleId: 0,
            version,
            dataEventId: 1,
            files: files.map(([name, type, body]) => {
                const [major = 'text', minor = 'plain'] = type.split('/');
                return {
                    contentLocation: name,
                    contentType: media(major, minor),
                    dataBase64: Buffer.from(body, 'latin1').toString('base64'),
                };
            }),
        },
    ];
}

function startup(body: string, script = ''): [string, string, string] {
    return [
        'startup.bml',
        'text/X-arib-bml',
        `<?xml version="1.0" encoding="EUC-JP"?>
<bml><head><title>t</title><script><![CDATA[${script}]]></script></head>
<body style="resolution:960x540" onload="start();">${body}</body></bml>`,
    ];
}

const opened: Bml[] = [];
afterEach(() => {
    for (const bml of opened.splice(0)) bml.destroy();
});

function open(options: Partial<BmlOptions> = {}): { bml: Bml; logs: string[] } {
    const logs: string[] = [];
    const bml = createBml({
        root: { attachShadow: () => fakeNode() } as unknown as HTMLElement,
        fonts: { round: 'a', boldRound: 'a', square: 'a' },
        ip: {
            connected: () => false,
            transmit: async () => ({ resultCode: 0, status: '', body: new Uint8Array() }),
            confirm: async () => null,
        },
        store: { get: () => null, set: () => {} },
        clock: () => Date.UTC(2026, 9, 12, 3),
        log: (message) => logs.push(message),
        ...options,
    });
    opened.push(bml);
    return { bml, logs };
}

/** エンジンの中 (Engine の非公開のもの)。外から覗くのはテストだけ */
const inside = (bml: Bml) =>
    bml as unknown as {
        ureg: string[];
        resources: { fetch: (...args: unknown[]) => Promise<unknown> };
    };

/**
 * `until` が真になるまで待ちながら、ページの手が空かなかった最も長い間 (ms) を計る。
 * 0ms のタイマーを回し続け、その間隔の最大を見る (エンジンが握っている間はタイマーが来ない)
 */
async function watch(until: () => boolean, limit = 10_000): Promise<{ longest: number; done: boolean }> {
    let longest = 0;
    let last = performance.now();
    const started = last;
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        if (until()) return { longest, done: true };
        if (now - started > limit) return { longest, done: false };
    }
}

describe('エンジンはページを固めない', () => {
    test('モジュールに無い画像を指す object で、描き直しと取りに行くのを繰り返さない', async () => {
        const { bml } = open();
        const resources = inside(bml).resources;
        // 直す前は、描く → 無いので取りに行く → すぐ「無い」と返る → 描き直す… がマイクロタスクで
        // 回り続けてページが固まった。数えて、多すぎたら止める (テストが固まらないように)
        let fetches = 0;
        const fetch = resources.fetch.bind(resources);
        resources.fetch = (...args) => {
            if (++fetches > 1000) throw new Error('取りに行きすぎ');
            return fetch(...args);
        };
        for (const message of carousel([
            startup(
                '<object type="image/jpeg" data="missing.jpg" style="left:0px;top:0px;width:100px;height:50px"/>',
                'function start() { browser.Ureg[1] = "ready"; }',
            ),
        ]))
            bml.feed(message);
        const { done } = await watch(() => inside(bml).ureg[1] === 'ready');
        expect(done).toBe(true);
        await watch(() => false, 300);
        expect(bml.path).toBe('/40/0000/startup.bml');
        expect(fetches).toBeLessThan(10);
    });

    test('すぐ返る待ち (届いているファイルの BinaryTable) をくり返すスクリプトでも、手を放す', async () => {
        const { bml } = open();
        // 届いているファイルの BinaryTable はすぐ返る。直す前は、待ち → 続き → 待ち… が
        // マイクロタスクでつながり、ループが終わるまで一度も手を放さなかった
        const script = `function start() {
            var n = 0;
            for (var i = 0; i < 100000; i++) {
                var t = new BinaryTable("table.bin", "0,U:1B");
                if (t != null) n += t.nrow;
            }
            browser.Ureg[1] = "done:" + n;
        }`;
        for (const message of carousel([
            startup('', script),
            ['table.bin', 'application/octet-stream', '\x01\x02\x03'],
        ]))
            bml.feed(message);
        const { longest, done } = await watch(() => inside(bml).ureg[1]?.startsWith('done') === true, 60_000);
        expect(done).toBe(true);
        expect(inside(bml).ureg[1]).toBe('done:300000');
        expect(longest).toBeLessThan(100);
    }, 70_000);

    test('長いループでも 1 回に握るのは区切りの長さほど', async () => {
        const { bml } = open();
        const script = `function start() {
            var s = 0;
            for (var i = 0; i < 2000000; i++) s += i % 7;
            browser.Ureg[1] = "done:" + s;
        }`;
        for (const message of carousel([startup('', script)])) bml.feed(message);
        const { longest, done } = await watch(() => inside(bml).ureg[1]?.startsWith('done') === true, 60_000);
        expect(done).toBe(true);
        expect(longest).toBeLessThan(100);
    }, 70_000);

    test('受け手が自分を呼び直し続ける (lockModuleOnMemory の知らせで押さえ直す) と、手を放しながら回る', async () => {
        const { bml } = open();
        // 押さえ直すと、届いているモジュールはすぐ知らせが来る。直す前は、知らせ → 受け手 →
        // 押さえ直す → 知らせ… がマイクロタスクで回り続けた
        const script = `var n = 0;
            function start() { browser.lockModuleOnMemory("/40/0000"); }
            function locked() {
                n++;
                browser.Ureg[1] = "" + n;
                if (n >= 20000) return;
                browser.unlockModuleOnMemory("/40/0000");
                browser.lockModuleOnMemory("/40/0000");
            }`;
        for (const message of carousel([
            startup(
                '<bevent><beitem id="b" type="ModuleLocked" module_ref="/40/0000" subscribe="subscribe" onoccur="locked();"/></bevent>',
                script,
            ),
        ]))
            bml.feed(message);
        const { longest, done } = await watch(() => Number(inside(bml).ureg[1]) >= 20000, 20_000);
        expect(done).toBe(true);
        expect(longest).toBeLessThan(100);
    }, 30_000);

    test('setInterval の受け手が間隔より重くても、待ちに重ねて積まない', async () => {
        const { bml } = open();
        // 1ms ごとに、1 回に区切りを何度もまたぐ受け手。直す前は動いている間の刻みが全部積まれ、
        // 止めた後も積んだ分が動き続けた
        const script = `var n = 0, id;
            function start() { id = browser.setInterval("tick();", 1, 0); }
            function tick() {
                n++;
                browser.Ureg[1] = "" + n;
                if (n >= 5) browser.clearTimer(id);
                var s = 0;
                for (var i = 0; i < 300000; i++) s += i;
            }`;
        for (const message of carousel([startup('', script)])) bml.feed(message);
        const { done } = await watch(() => Number(inside(bml).ureg[1]) >= 5, 20_000);
        expect(done).toBe(true);
        await watch(() => false, 500);
        expect(Number(inside(bml).ureg[1])).toBeLessThanOrEqual(6);
    }, 30_000);

    test('手が空かないまま続く文書は止めて知らせる', async () => {
        const { bml, logs } = open({ budget: { window: 100 } });
        // 終わらないループ。命令の数の上限に届く前に、手が空かない時間の上限で止まる
        for (const message of carousel([startup('', 'function start() { for (;;) {} }')])) bml.feed(message);
        const { longest, done } = await watch(() => bml.path === null && logs.length > 0, 20_000);
        expect(done).toBe(true);
        expect(longest).toBeLessThan(100);
        expect(logs.some((line) => line.includes('止めました'))).toBe(true);
        // 止めた文書を勝手に出し直さない
        for (const message of carousel([startup('', 'function start() {}')], 2)) bml.feed(message);
        await watch(() => false, 200);
        expect(bml.path).toBeNull();
    }, 30_000);
});
