import { describe, expect, test } from 'bun:test';
import { type BmlIp, type BrowserHost, defineBinaryTable, defineBrowser } from './browser';
import { createRealm } from './builtins';
import { compileScript } from './compiler';
import { BmlDocument, type BmlElement } from './document';
import { Dom, type DomHost } from './dom';
import { Nvram } from './nvram';
import { Sound } from './sound';
import { ABORT, JSArray, Suspend, type Value } from './values';
import { Vm } from './vm';
import { parseXml } from './xml';

const items = (value: Value): Value[] => (value instanceof JSArray ? value.items : []);

const BML = `<?xml version="1.0" encoding="EUC-JP"?>
<bml><head><title>t</title></head>
<body>
<bevent><beitem id="bi" type="ModuleUpdated" module_ref="/40/0001" onoccur="x();"/></bevent>
<div id="box" style="left:10px;top:20px;width:100px;height:50px;background-color-index:3">
  <p id="msg" style="left:0px;top:0px;width:100px;height:24px;nav-index:0">はじめ</p>
</div>
</body></bml>`;

interface Setup {
    vm: Vm;
    doc: BmlDocument;
    subscribed: BmlElement[];
    launched: string[];
    run(source: string): Promise<Value>;
}

function setup(): Setup {
    const xml = parseXml(BML);
    if (xml === null) throw new Error();
    const doc = new BmlDocument(xml);
    doc.applyRules([]);
    const realm = createRealm({ now: () => Date.UTC(2026, 9, 12, 3) });
    const vm = new Vm(realm);
    const subscribed: BmlElement[] = [];
    const launched: string[] = [];
    let invisible = true;
    let focused: BmlElement | null = null;
    const host: DomHost = {
        realm,
        document: doc,
        focused: () => focused,
        focus: (element) => {
            focused = element;
        },
        blur: () => {
            focused = null;
        },
        event: () => null,
        invisible: () => invisible,
        setInvisible: (value) => {
            invisible = value;
        },
        subscribed: (element) => subscribed.push(element),
        keysChanged: () => {},
        stream: () => {},
    };
    const dom = new Dom(host);
    const kept = new Map<string, string>();
    const ip: BmlIp = {
        connected: () => true,
        transmit: async (_, body) => ({
            resultCode: 1,
            status: '200',
            body: Uint8Array.from([...new TextDecoder().decode(body)].map((c) => c.charCodeAt(0))),
        }),
        confirm: async () => null,
    };
    const browserHost: BrowserHost = {
        realm,
        nvram: new Nvram(
            { get: (k) => kept.get(k) ?? null, set: (k, v) => kept.set(k, v) },
            () => ({ zipcode: '1000001', prefecture: 13 }),
            () => ({ originalNetworkId: 1, serviceId: 2 }),
        ),
        sound: new Sound(),
        ip,
        ureg: new Array<string>(64).fill(''),
        greg: new Array<string>(64).fill(''),
        program: () => ({
            type: 'programInfo',
            originalNetworkId: 0x7fe1,
            transportStreamId: 0x7fe1,
            serviceId: 0x400,
            eventId: 0x1234,
            eventName: 'x',
            startTimeUnixMillis: Date.UTC(2026, 9, 12, 2),
            durationSeconds: 3600,
            indefiniteDuration: false,
            networkId: 0x7fe1,
        }),
        now: () => Date.UTC(2026, 9, 12, 3),
        activeDocument: () => '/40/0000/startup.bml',
        launch: (name) => {
            launched.push(name);
            return ABORT;
        },
        quit: () => ABORT,
        tune: () => Number.NaN,
        setTimer: () => 1,
        timer: () => true,
        sleep: () => new Suspend(Promise.resolve(1)),
        screen: () => {},
        lock: () => 1,
        unlock: () => true,
        locked: () => [],
        detect: () => 1,
        loadDrcs: () => 1,
        binaryTable: async () => Uint8Array.of(1, 2, 3, 4),
        log: () => {},
    };
    realm.global.put('document', dom.document);
    realm.global.put('browser', defineBrowser(browserHost));
    realm.global.put('BinaryTable', defineBinaryTable(browserHost));
    return {
        vm,
        doc,
        subscribed,
        launched,
        async run(source: string): Promise<Value> {
            vm.startProgram(compileScript(source, 'test'));
            let result = vm.run(Number.POSITIVE_INFINITY);
            while (result.kind === 'suspend') {
                vm.resume(await result.promise);
                result = vm.run(Number.POSITIVE_INFINITY);
            }
            if (result.kind === 'error') throw result.error;
            return realm.global.get('result');
        },
    };
}

describe('browser.*', () => {
    test('番組・時間・レジスタ・NVRAM', async () => {
        const s = setup();
        const result = await s.run(`
            browser.Ureg[3] = "abc";
            browser.writePersistentArray("nvram://local_web/0", "S:4B", new Array("ok"));
            var d = new Date(2026, 9, 12, 12, 0, 0);
            var e = browser.addDate(d, 2, 3);
            var result = [
                browser.getProgramID(2), browser.getProgramID(6), browser.Ureg[3],
                browser.readPersistentArray("nvram://local_web/0", "S:4B")[0],
                browser.readPersistentArray("nvram://receiverinfo/zipcode", "S:7B")[0],
                browser.subDate(e, d, 2), browser.getProgramRelativeTime(),
                browser.getBrowserSupport("ARIB", "APIGroup", "Ctrl.Version"),
                browser.getBrowserSupport("ARIB", "AITControlledAppEngineFunction", "IPTV-F", "HTML5_ph0"),
                browser.getBrowserSupport("ARIB", "Storage", "cachesize", 100),
                browser.startAITControlledApp(1, 2, 3), browser.epgTune("arib://-1.-1.400"),
                browser.isIPConnected(), browser.random(1)
            ];
        `);
        expect(items(result)).toEqual([
            '0x0400',
            'arib://7fe1.7fe1.0400.1234',
            'abc',
            'ok  ',
            '1000001',
            120,
            3600,
            1,
            0,
            1,
            Number.NaN,
            Number.NaN,
            1,
            1,
        ]);
    });

    test('getBrowserSupport の APIGroup は、動く関数の組だけ「ある」と答える', async () => {
        const s = setup();
        const groups = [
            'Ctrl.Media',
            'EPG.Basic',
            'Ctrl.Cache2',
            'Com.IP',
            'Com.IP.Connect',
            'Com.IP.Params',
            'Ctrl.AppVersion',
            'Ctrl.startExtraBrowser',
            'AITControlledApp.Start',
            'EPG.Basic2',
        ];
        const result = await s.run(`
            var groups = ${JSON.stringify(groups).replace(/"/g, "'")};
            var out = [];
            for (var i = 0; i < groups.length; i++) out[i] = browser.getBrowserSupport("ARIB", "APIGroup", groups[i]);
            out[groups.length] = browser.isSupportedMedia("1");
            out[groups.length + 1] = browser.getResidentAppVersion("x");
            var result = out;
        `);
        // Ctrl.Media は isSupportedMedia が答えるのと揃える。PPP・常駐アプリ・外のブラウザ・AIT は無い
        expect(items(result)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, null]);
    });

    test('launchDocument は戻らない', async () => {
        const s = setup();
        s.vm.startProgram(
            compileScript('var a = 1; browser.launchDocument("/40/0001/next.bml", "cut"); a = 2;', 'x'),
        );
        expect(s.vm.run(Number.POSITIVE_INFINITY).kind).toBe('abort');
        expect(s.launched).toEqual(['/40/0001/next.bml']);
        expect(s.vm.realm.global.get('a')).toBe(1);
    });

    test('transmitTextDataOverIP は待って [結果, 状態, 返り] を返す (Denbun= に EUC-JP の %XX)', async () => {
        const s = setup();
        const result = await s.run(
            'var r = browser.transmitTextDataOverIP("http://x/", "あa", "EUC-JP"); var result = r[2];',
        );
        expect(result).toBe('Denbun=%a4%a2a');
    });

    test('BinaryTable は待ってから表になる', async () => {
        const s = setup();
        const result = await s.run(
            'var t = new BinaryTable("/40/0001/t.bin", "0,U:1B"); var result = [t.nrow, t.ncolumn, t.toNumber(2, 0)];',
        );
        expect(items(result)).toEqual([4, 1, 3]);
    });
});
