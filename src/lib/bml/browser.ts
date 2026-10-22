/**
 * `browser.*` (STD-B24 第二編 付属2 7 章の拡張関数)。実際の放送が呼ぶもの (9 局 16 本で 53 種) を
 * 全部持ち、**動かせないものは規格どおり「失敗」を返す** (NaN・null・0)。呼んだら転ぶ、には
 * しない — 放送のアプリはその返事を見て「この機能はありません」と案内する。
 *
 * 動かさないもの: 外のアプリ・予約・電話回線 (PPP)。選局 (epgTune) と Hybridcast の起動
 * (startAITControlledApp) は denpa の画面に任せる (エンジンは「この局へ」「アプリを」と知らせるだけ)。
 * Hybridcast を開けない (双方向がオフ・AIT にアプリが無い) ときは、AIT の問い合わせに 0 と答える。
 *
 * 通信の文書 (http・https から取った文書) からは、NVRAM の局の領域を読み書きさせない。使えるのは
 * 通信の文書向けの `nvram://local_web/` と、受信機の設定 (`nvram://receiverinfo/`) を読むことだけ
 * (denpa の決め。放送の文書が覚えたもの — 同意・地域など — を、外から来た文書に渡さない。
 * `local_web` は名前のとおり通信の文書と分け合う領域)。
 */

import type { ProgramInfoMessage } from '#lib/ts/bml-protocol.js';
import { type Cell, Table } from './binary';
import { HostObject } from './dom';
import { clipEuc, decodeEuc, encodeEuc } from './euc';
import type { Nvram } from './nvram';
import { isRemote, type LockKind } from './resources';
import type { Sound } from './sound';
import {
    type Abort,
    isObject,
    JSArray,
    JSDate,
    JSFunction,
    JSObject,
    type NativeResult,
    Suspend,
    toNumber,
    toStr,
    type Value,
} from './values';
import type { Realm } from './vm';

/** 双方向 (中継はサーバ。denpa の側が `/api/bml/*` へ繋ぐ) */
export interface BmlIp {
    connected(): boolean;
    transmit(
        uri: string,
        body: Uint8Array,
    ): Promise<{ resultCode: number; status: string; body: Uint8Array }>;
    confirm(
        destination: string,
        icmp: boolean,
        timeout: number,
    ): Promise<{ success: boolean; ipAddress: string | null; responseTimeMillis: number | null } | null>;
    /**
     * 通信の文書と、その中の画像・CSS・script を取る (`launchDocument("https://…")`)。相手の返した
     * 符号と中身をそのまま返す。中継が断った (相手まで行けなかった) なら null
     */
    get(uri: string): Promise<{ status: number; contentType: string; body: Uint8Array } | null>;
}

/** browser.* が呼ぶ、エンジンの側の API */
export interface BrowserHost {
    readonly realm: Realm;
    readonly nvram: Nvram;
    readonly sound: Sound;
    readonly ip: BmlIp;
    readonly ureg: string[];
    readonly greg: string[];
    program(): ProgramInfoMessage | null;
    /** 放送の時刻 (UNIX ミリ秒) */
    now(): number;
    activeDocument(): string | null;
    /** 移る。戻らない (Abort)・失敗 (NaN)・通信の文書を取るまで待つ (Suspend) */
    launch(name: string): NativeResult;
    /** epgTune。`service` は `arib://<original_network_id>.<transport_stream_id>.<service_id>` */
    tune(service: string): Abort | number;
    quit(): Abort;
    setTimer(code: string, interval: number, count: number): number;
    timer(id: number, action: 'clear' | 'pause' | 'resume'): boolean;
    sleep(ms: number): Suspend;
    screen(locked: boolean): void;
    lock(module: string, kind: LockKind): number;
    unlock(module: string, kind?: LockKind): boolean;
    locked(): [string, boolean, boolean][];
    detect(component: string): number;
    loadDrcs(ref: string): NativeResult;
    binaryTable(ref: string): Promise<Uint8Array | null>;
    log(message: string): void;
    /** Hybridcast のアプリを開けるか (双方向がオンで、AIT にアプリがある)。無ければ開けない */
    canStartApp?(): boolean;
    /**
     * Hybridcast のアプリを開く (startAITControlledApp)。`hint` は数の引数 (どのアプリかの手がかり。
     * organization_id・application_id など)。開けたら true
     */
    startApp?(hint: number[]): boolean;
    /**
     * XML の AIT を取りに行けるか (双方向がオン)。**電波に AIT が無くても開ける局がある** — NHK は AIT を電波に載せず、
     * 文書が XML の AIT の URL を渡してくる (`AITTransportMethod` の XML・HTTP を訊く)
     */
    canFetchAit?(): boolean;
    /** 文書が渡した XML の AIT (`uri`) を取って、そこにあるアプリを開く。取りに行き始めたら true */
    startAppFrom?(uri: string, hint: number[]): boolean;
}

/**
 * getBrowserSupport の APIGroup で「ある」と答えるもの。組の中身は STD-B24 第二編 付属1 表11-2 で、
 * **ここで動く関数の組だけ**を挙げる。無いと答えるもの: Com.IP.Connect・Com.IP.Params (PPP)・
 * Ctrl.AppVersion (getResidentAppVersion は null)・Ctrl.startExtraBrowser・
 * EPG.Basic2 (epgTuneToComponent)。AITControlledApp.Start は Hybridcast を開けるときだけ「ある」。EPG.Basic は epgTune が動くので「ある」(予約は失敗を返す。録画の
 * 再生中は epgTune も失敗)
 */
const API_GROUPS = new Set([
    'Class.BinaryTable',
    'EPG.Basic',
    'Persistent.Basic',
    'Com.IP',
    'Com.IP.GetType',
    'Com.IP.Transmit',
    'Com.IP.confirmIP',
    'Ctrl.Basic',
    'Ctrl.Basic2',
    'Ctrl.NPT',
    'Ctrl.Time',
    'Ctrl.Cache',
    'Ctrl.Cache2',
    'Ctrl.Cache.Ext',
    'Ctrl.Version',
    'Ctrl.Screen',
    'Ctrl.Media',
    'Ctrl.Quit',
    'Ctrl.Status',
    'RomSound.Basic',
    'Timer.Basic',
    'Timer.DateMode',
    'Misc.DRCS',
    'Misc.Basic',
    'Misc.Ureg',
    'Misc.Greg',
]);

const hex4 = (n: number | null | undefined): string | null =>
    n == null ? null : `0x${n.toString(16).padStart(4, '0')}`;

/** AIT (Hybridcast) についての問い合わせ。何を訊かれたかを残す (局がどれで出し分けているかを見るため) */
const AIT_QUERIES = new Set(['AITControlledAppEngineFunction', 'AITTransferMethod', 'AITTransportMethod']);

/**
 * getBrowserSupport (TR-B14 第二分冊 5.12.6)。`app` は電波の AIT にあるアプリを開けるか、`xml` は XML の AIT を
 * 取りに行けるか (双方向がオン)。AIT の問い合わせは開けるときだけ 1 — 1 と答えて開かないと、放送のアプリは起動を待ったまま返らない。
 * 運び方 (`AITTransportMethod`) は XML なら `xml`、それ以外 (電波の表) は `app` で答える
 */
function browserSupport(
    provider: string,
    name: string,
    info: string[],
    ip: BmlIp,
    app: boolean,
    xml: boolean,
): number {
    if (provider !== 'ARIB') return 0;
    const [a, b] = info;
    switch (name) {
        case 'BMLversion': {
            if (a === undefined) return 1;
            const [major = Number.NaN, minor = Number.NaN] = a.split('.').map(Number);
            return major < 3 || (major === 3 && minor === 0) ? 1 : 0;
        }
        case 'APIGroup':
            if (a === 'Com.IP.confirmIP' || a === 'Com.IP.Transmit') return 1;
            if (a === 'AITControlledApp.Start') return app || xml ? 1 : 0;
            return a !== undefined && API_GROUPS.has(a) ? 1 : 0;
        case 'Storage':
            return a === 'cachesize' && Number(b) * 1024 <= 10 * 1024 * 1024 ? 1 : 0;
        case 'AudioFile':
            return Number(a) <= 10 * 1024 * 1024 ? 1 : 0;
        case 'CharacterEncoding':
            return a === 'EUC-JP' ? 1 : 0;
        case 'OSDResolution':
            return a === '960x540' || a === '720x480' ? 1 : 0;
        case 'TransmissionProtocol':
            return a === 'application' && (b === 'HTTP' || b === 'TLS') && ip.connected() ? 1 : 0;
        case 'AITControlledAppEngineFunction':
            return app || xml ? 1 : 0;
        case 'AITTransportMethod':
            return (a === 'XML' ? xml : app) ? 1 : 0;
        case 'AITTransferMethod':
            return app ? 1 : 0;
        case 'IRDID':
        case 'ResidentApp':
        case 'ExtraBrowserFunction':
            return 0;
    }
    return 0;
}

/**
 * startAITControlledApp の引数から XML の AIT の URL を拾う。**http(s) の絶対 URL だけ** — 数 (organisation_id など) と
 * 相対の名前は手がかりにしない (相対は何に対してかが決まっていない)
 */
function aitUri(args: Value[]): string | null {
    for (const arg of args) {
        if (typeof arg === 'string' && /^https?:\/\//i.test(arg)) return arg;
    }
    return null;
}

/** 文字列を `Denbun=` の形式に (付属2 7.10。英数と -_.!~*'() のほかは %XX) */
function denbun(text: string): Uint8Array {
    let out = 'Denbun=';
    for (const byte of encodeEuc(text)) {
        const c = String.fromCharCode(byte);
        out += /[A-Za-z0-9\-_.!~*'()]/.test(c) ? c : `%${byte.toString(16).padStart(2, '0')}`;
    }
    return new TextEncoder().encode(out);
}

export function defineBrowser(host: BrowserHost): HostObject {
    const realm = host.realm;
    const browser = new HostObject(realm.objectProto);
    const array = (items: Value[]): JSArray => new JSArray(realm.arrayProto, items);
    const fn = (name: string, impl: (args: Value[]) => NativeResult): void => {
        browser.method(realm, name, (_, args) => impl(args));
    };
    const fail = (name: string, value: Value = Number.NaN): void => {
        fn(name, () => {
            host.log(`browser.${name} は非対応`);
            return value;
        });
    };
    const str = (args: Value[], i: number): string => toStr(args[i]);

    // レジスタ (Ureg は局が変わると消える。Greg は消えない)
    for (const [name, registers, first] of [
        ['Ureg', host.ureg, 0],
        ['Greg', host.greg, 0],
    ] as const) {
        const object = new HostObject(realm.objectProto);
        for (let i = first; i < registers.length; i++) {
            object.define(
                String(i),
                () => registers[i],
                (value) => {
                    registers[i] = clipEuc(toStr(value), 256);
                },
            );
        }
        browser.define(name, () => object);
    }

    // 覚えておく場所
    const cells = (value: Value): Cell[] =>
        value instanceof JSArray
            ? value.items.map((item) =>
                  typeof item === 'boolean' || typeof item === 'number' ? item : toStr(item),
              )
            : [];
    // 通信の文書から使えるか (冒頭の説明)。受信機の設定は読むだけ
    const remote = (): boolean => isRemote(host.activeDocument() ?? '');
    const usable = (uri: string, write: boolean): boolean => {
        if (!remote()) return true;
        const name = uri.trim().toLowerCase();
        if (name.startsWith('nvram://local_web/') || (!write && name.startsWith('nvram://receiverinfo/')))
            return true;
        host.log(`通信の文書からは使えない NVRAM の領域です: ${uri}`);
        return false;
    };
    fn('readPersistentArray', (args) => {
        if (!usable(str(args, 0), false)) return null;
        const values = host.nvram.read(str(args, 0), str(args, 1));
        return values === null ? null : array(values.map((v) => (typeof v === 'object' ? null : v)));
    });
    fn('writePersistentArray', (args) =>
        usable(str(args, 0), true)
            ? host.nvram.write(str(args, 0), str(args, 1), cells(args[2]))
            : Number.NaN,
    );
    fn('checkAccessInfoOfPersistentArray', (args) => {
        const uri = str(args, 0);
        if (!usable(uri, false)) return Number.NaN;
        // 通信の文書から local_web は読み書き、受信機の設定は読むだけ (nvram.check と同じ答え)
        return host.nvram.check(uri);
    });
    fail('readPersistentArrayWithAccessCheck', null);
    fail('writePersistentArrayWithAccessCheck');

    // 時間
    fn('setInterval', (args) => host.setTimer(str(args, 0), toNumber(args[1]), toNumber(args[2])));
    fn('clearTimer', (args) => (host.timer(toNumber(args[0]), 'clear') ? 1 : Number.NaN));
    fn('pauseTimer', (args) => (host.timer(toNumber(args[0]), 'pause') ? 1 : Number.NaN));
    fn('resumeTimer', (args) => (host.timer(toNumber(args[0]), 'resume') ? 1 : Number.NaN));
    fn('sleep', (args) => host.sleep(Math.max(0, toNumber(args[0]) || 0)));
    fn('setCurrentDateMode', (args) => {
        const mode = toNumber(args[0]);
        return mode === 0 || mode === 1 ? 1 : Number.NaN;
    });
    const unit = (n: number): number => [1, 1000, 60000, 3600000, 86400000, 604800000][n] ?? 1;
    fn('subDate', (args) => {
        const [target, base] = args;
        if (!(target instanceof JSDate) || !(base instanceof JSDate)) return Number.NaN;
        const result = Math.trunc((target.time - base.time) / unit(toNumber(args[2])));
        return result < -2147483648 || result > 2147483647 ? Number.NaN : result;
    });
    fn('addDate', (args) => {
        const base = args[0];
        if (!(base instanceof JSDate)) return Number.NaN;
        const time = toNumber(args[1]);
        const dateProto = realm.global.get('Date');
        const proto = isObject(dateProto) ? dateProto.get('prototype') : null;
        return new JSDate(
            isObject(proto) ? proto : realm.objectProto,
            Number.isNaN(time) ? base.time : base.time + time * unit(toNumber(args[2])),
        );
    });
    fn('getProgramRelativeTime', () => {
        const start = host.program()?.startTimeUnixMillis;
        return start == null ? Number.NaN : Math.floor((host.now() - start) / 1000);
    });
    fn('getNPT', () => Number.NaN);

    // 画面と文書
    fn('lockScreen', () => {
        host.screen(true);
        return 1;
    });
    fn('unlockScreen', () => {
        host.screen(false);
        return 1;
    });
    fn('launchDocument', (args) => host.launch(str(args, 0)));
    fn('reloadActiveDocument', () => {
        const active = host.activeDocument();
        return active === null ? Number.NaN : host.launch(active);
    });
    fn('quitDocument', () => host.quit());
    fn('getActiveDocument', () => host.activeDocument());

    // モジュール
    fn('lockModuleOnMemory', (args) => host.lock(str(args, 0), 'lock'));
    fn('lockModuleOnMemoryEx', (args) => host.lock(str(args, 0), 'lockEx'));
    fn('unlockModuleOnMemory', (args) => (host.unlock(str(args, 0), 'lock') ? 1 : Number.NaN));
    fn('unlockModuleOnMemoryEx', (args) => (host.unlock(str(args, 0), 'lockEx') ? 1 : Number.NaN));
    fn('unlockAllModulesOnMemory', () => {
        for (const [module] of host.locked()) host.unlock(module);
        return 1;
    });
    fn('getLockedModuleInfo', () =>
        array(host.locked().map(([module, ex, waiting]) => array([module, ex ? 2 : 1, waiting ? 2 : 1]))),
    );
    fn('detectComponent', (args) => host.detect(str(args, 0)));
    fn('setCachePriority', () => 1);
    fn('getFreeContentsMemory', () => 10 * 1024 * 1024);

    // 番組・受信機
    fn('getProgramID', (args) => {
        const p = host.program();
        const network = p?.originalNetworkId;
        const ts = p?.transportStreamId;
        const service = p?.serviceId;
        const id = (n: number | null | undefined): string =>
            n == null ? '-1' : n.toString(16).padStart(4, '0');
        switch (toNumber(args[0])) {
            case 1:
                return hex4(p?.eventId);
            case 2:
                return hex4(service);
            case 3:
                return hex4(network);
            case 4:
                return hex4(ts);
            case 6:
                return `arib://${id(network)}.${id(ts)}.${id(service)}.${id(p?.eventId)}`;
            case 7:
                return `arib://${id(network)}.${id(ts)}.${id(service)}`;
            case 9:
                return hex4(p?.networkId ?? network);
        }
        return null;
    });
    const isCurrentEvent = (ref: string): boolean => {
        const p = host.program();
        const match = /^arib:\/\/(?:[0-9a-f]+|-1)\.(?:[0-9a-f]+|-1)\.(?:[0-9a-f]+|-1)\.([0-9a-f]+)$/i.exec(
            ref,
        );
        return p !== null && match !== null && Number.parseInt(match[1]!, 16) === p.eventId;
    };
    fn('epgGetEventStartTime', (args) => {
        const start = host.program()?.startTimeUnixMillis;
        if (start == null || !isCurrentEvent(str(args, 0))) return null;
        const date = realm.global.get('Date');
        const proto = isObject(date) ? date.get('prototype') : null;
        return new JSDate(isObject(proto) ? proto : realm.objectProto, start);
    });
    fn('epgGetEventDuration', (args) => {
        const duration = host.program()?.durationSeconds;
        return duration == null || !isCurrentEvent(str(args, 0)) ? Number.NaN : duration;
    });
    fn('isBeingBroadcast', () => false);
    const canStartApp = (): boolean => host.canStartApp?.() === true;
    const canFetchAit = (): boolean => host.canFetchAit?.() === true;
    fn('getBrowserSupport', (args) => {
        const name = str(args, 1);
        const info = args.slice(2).map((a) => toStr(a));
        const answer = browserSupport(str(args, 0), name, info, host.ip, canStartApp(), canFetchAit());
        // Hybridcast について何を訊かれたかを残す (局が何を見て案内を出し分けているかが分かる)
        if (AIT_QUERIES.has(name) || (name === 'APIGroup' && info[0] === 'AITControlledApp.Start'))
            host.log(`getBrowserSupport(${[str(args, 0), name, ...info].join(', ')}) → ${answer}`);
        return answer;
    });
    fn('formatNumber', (args) => {
        const n = toNumber(args[0]);
        return (Number.isNaN(n) ? 0 : n).toLocaleString('en-US');
    });
    fn('getBrowserVersion', () => array(['denpa', 'denpa', '001', '000']));
    fn('getBrowserStatus', (args) => {
        if (str(args, 0) !== 'TerrP' || str(args, 1) !== 'IRDState') return Number.NaN;
        // Broadcast は放送の文書を、Link は通信の文書 (一次リンクの先) を出しているときに 1 (TR-B14)。
        // 局の script はこれを見て BinaryTable の置き場 (放送のモジュールか、通信の相対の名前か) を選ぶ
        const state = str(args, 2);
        if (state === 'Broadcast') return remote() ? 0 : 1;
        if (state === 'Link') return remote() ? 1 : 0;
        return state === 'UnLink' ? 0 : Number.NaN;
    });
    fn('isSupportedMedia', (args) => (['1', '2', '4'].includes(str(args, 0)) ? 1 : 0));
    fn('getIRDID', () => null);
    fn('getResidentAppVersion', () => null);
    fn('random', (args) => {
        const n = toNumber(args[0]);
        return n >= 1 ? Math.floor(Math.random() * n) + 1 : Number.NaN;
    });
    fn('playRomSound', (args) => {
        const match = /^romsound:\/\/(\d+)$/.exec(str(args, 0));
        return match !== null && host.sound.rom(Number(match[1])) ? 1 : Number.NaN;
    });
    fn('loadDRCS', (args) => host.loadDrcs(str(args, 0)));

    // 双方向
    fn('isIPConnected', () => (host.ip.connected() ? 1 : 0));
    fn('getConnectionType', () => 403);
    fn('transmitTextDataOverIP', (args) => {
        const failed = array([Number.NaN, '', '']);
        if (str(args, 2) !== 'EUC-JP' || !host.ip.connected()) return failed;
        const { promise, resolve } = Promise.withResolvers<Value>();
        host.ip
            .transmit(str(args, 0), denbun(str(args, 1)))
            .then((r) => resolve(array([r.resultCode, r.status, decodeEuc(r.body)])))
            .catch(() => resolve(failed));
        return suspend(promise);
    });
    fn('confirmIPNetwork', (args) => {
        if (!host.ip.connected()) return null;
        const { promise, resolve } = Promise.withResolvers<Value>();
        host.ip
            .confirm(str(args, 0), toNumber(args[1]) === 1, toNumber(args[2]) || 4000)
            .then((r) => resolve(r === null ? null : array([r.success, r.ipAddress, r.responseTimeMillis])))
            .catch(() => resolve(null));
        return suspend(promise);
    });
    for (const name of [
        'setISPParams',
        'connectPPP',
        'connectPPPWithISPParams',
        'disconnectPPP',
        'connect',
        'disconnect',
    ]) {
        fail(name);
    }
    fail('getISPParams', null);
    fail('getPrefixNumber', array(['', '', '', '', '']));
    fail('sendTextData');
    fail('receiveTextData', null);
    fail('vote');
    fail('setCacheResourceOverIP', 1);

    /*
     * Hybridcast。開くのは画面で、開くのは AIT にある行き先だけ。**電波に AIT があればそちらを使い、引数の URL は使わない。**
     * 電波に AIT が無い局 (NHK) では、引数の URL を XML の AIT として取り、そこにあるアプリを開く (`startAppFrom`)。
     * どちらでも、アプリの行き先は AIT から決まる (文書が渡した URL のページをそのまま開くことはしない)
     */
    fn('startAITControlledApp', (args) => {
        host.log(`startAITControlledApp(${args.map((a) => toStr(a)).join(', ')})`);
        const hint = args.map((a) => toNumber(a)).filter((n) => Number.isFinite(n));
        if (canStartApp()) return host.startApp?.(hint) === true ? 1 : Number.NaN;
        const uri = aitUri(args);
        return uri !== null && canFetchAit() && host.startAppFrom?.(uri, hint) === true ? 1 : Number.NaN;
    });
    // AIT は denpa のサーバが選局したときから読んでいる (XML の AIT は起動のときに取る)。開けないなら失敗
    fn('startReceivingAIT', (args) => {
        host.log(`startReceivingAIT(${args.map((a) => toStr(a)).join(', ')})`);
        return canStartApp() || canFetchAit() ? 1 : Number.NaN;
    });
    // 受け取った AIT を文書へ渡す形は確かめられていない。何を訊かれたかだけ残して、無いと答える
    fn('getReceivedAIT', (args) => {
        host.log(`getReceivedAIT(${args.map((a) => toStr(a)).join(', ')})`);
        return null;
    });

    // 動かさないもの (選局・予約・外のアプリ・ブックマーク)
    fn('epgTune', (args) => host.tune(str(args, 0)));
    for (const name of [
        'epgTuneToComponent',
        'epgReserve',
        'epgCancelReservation',
        'epgIsReserved',
        'epgRecReserve',
        'epgRecCancelReservation',
        'epgRecIsReserved',
        'launchExApp',
        'startExtraBrowser',
        'startResidentApp',
        'writeBookmarkArray',
        'deleteBookmark',
        'lockBookmark',
        'unlockBookmark',
        'setCCDisplayStatus',
    ]) {
        fail(name);
    }
    for (const name of ['readBookmarkArray', 'getBookmarkInfo', 'getBookmarkInfo2']) fail(name, null);
    fn('getCCDisplayStatus', (args) => (toNumber(args[0]) === 1 ? 1 : 0));
    fn('getCCLanguageStatus', (args) => (toNumber(args[0]) === 1 ? 1 : 0));
    fn('getTuningLinkageSource', () => '');
    fn('getTuningLinkageType', () => -1);
    return browser;
}

function suspend(promise: Promise<Value>): Suspend {
    return new Suspend(promise);
}

/**
 * `new BinaryTable(ファイル, 書式)`。ファイルが届くのを待つ。読めなければ null
 * (付属2 5.5。nrow・ncolumn・toNumber・toString・toArray・search・close)
 */
export function defineBinaryTable(host: BrowserHost): JSFunction {
    const realm = host.realm;
    const proto = new JSObject(realm.objectProto, 'BinaryTable');
    proto.builtin = true;
    const tables = new WeakMap<JSObject, Table>();
    const array = (items: Value[]): JSArray => new JSArray(realm.arrayProto, items);
    const cell = (value: Cell | undefined): Value =>
        value === undefined || typeof value === 'object' ? null : value;
    const method = (name: string, impl: (table: Table, args: Value[]) => Value): void => {
        proto.put(
            name,
            new JSFunction(
                realm.functionProto,
                name,
                {
                    kind: 'native',
                    impl: (self, args) => {
                        const table = isObject(self) ? tables.get(self) : undefined;
                        return table === undefined ? Number.NaN : impl(table, args);
                    },
                },
                null,
            ),
        );
    };
    method('close', () => 1);
    method('toNumber', (table, args) =>
        Number(table.rows[toNumber(args[0])]?.[toNumber(args[1])] ?? Number.NaN),
    );
    method('toString', (table, args) => {
        const value = table.rows[toNumber(args[0])]?.[toNumber(args[1])];
        return value === undefined || typeof value === 'object' ? null : String(value);
    });
    method('toArray', (table, args) => {
        const start = toNumber(args[0]);
        const count = toNumber(args[1]);
        if (!(start >= 0) || !(count >= 0) || count > 65536) return null;
        return array(
            Array.from({ length: count }, (_, i) => {
                const row = table.rows[start + i];
                return row === undefined ? null : array(row.map(cell));
            }),
        );
    });
    method('search', (table, args) => {
        // (開始行, [列, 値, 演算子] × 1〜4, 論理, 件数, 結果の配列)
        const rest = args.slice(1);
        if (rest.length % 3 !== 0 || rest.length < 6 || rest.length > 15) return Number.NaN;
        const conditions: [number, unknown, number][] = [];
        for (let i = 0; i < rest.length - 3; i += 3)
            conditions.push([toNumber(rest[i]), rest[i + 1], toNumber(rest[i + 2])]);
        const out = rest.at(-1);
        if (!(out instanceof JSArray)) return Number.NaN;
        const found = table.search(
            toNumber(args[0]),
            conditions,
            Boolean(rest.at(-3)),
            toNumber(rest.at(-2)),
        );
        if (found === null) return Number.NaN;
        out.items = found[0].map((row) => array(row));
        return found[1];
    });
    const construct = (args: Value[]): NativeResult => {
        const { promise, resolve } = Promise.withResolvers<Value>();
        void host.binaryTable(toStr(args[0])).then((data) => {
            if (data === null) {
                resolve(null);
                return;
            }
            try {
                const table = new Table(data, toStr(args[1]), decodeEuc);
                const object = new JSObject(proto, 'BinaryTable');
                object.put('nrow', table.rows.length);
                object.put('ncolumn', table.fields.length);
                tables.set(object, table);
                resolve(object);
            } catch {
                resolve(null);
            }
        });
        return suspend(promise);
    };
    const binaryTable = new JSFunction(
        realm.functionProto,
        'BinaryTable',
        { kind: 'native', impl: () => null, construct },
        null,
    );
    binaryTable.put('prototype', proto);
    return binaryTable;
}
