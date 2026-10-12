/**
 * データ放送のエンジン。**web-bml を置き換える自前の実装** (Svelte から切り離してある)。
 *
 *     const bml = createBml({ root, fonts, ip, store, onVideoRect, onVisible, onReceiving });
 *     bml.feed(message);        // サーバの ResponseMessage をそのまま
 *     bml.key(code, down);      // AribKeyCode (20 が d)
 *     bml.listens('DataButtonPressed');
 *     bml.destroy();
 *
 * - 映像は動かさない。映像の object の場所を `onVideoRect` で知らせ、置くのは呼び手
 * - 文書は自前の XML の読み手 → 中身の木 → 影の中の絶対配置の div ([render.ts](render.ts))
 * - スクリプトは自前の VM ([vm.ts](vm.ts))。イベントは 1 つずつ順に動かす
 * - **ページを握るのは 1 つの仕事 (タスクとそれに続くマイクロタスク) で 5ms まで** ([budget.ts](budget.ts))。
 *   スクリプト・描き直し・約束の続きは全部その下で動かし、休みなく回り続ける文書は止める
 *
 * 時計は `clock` (録画は再生位置から放送の時刻を出す)。無ければ TOT + 経過時間。
 */

import type { ResponseMessage } from '#lib/ts/bml-protocol.js';
import { type BmlIp, type BrowserHost, defineBinaryTable, defineBrowser } from './browser';
import { Budget, type BudgetLimits } from './budget';
import { createRealm } from './builtins';
import { DEFAULT_CLUT, type Rgba, readClut } from './clut';
import { compileScript } from './compiler';
import { parseStylesheet, parseUrl, type Rule } from './css';
import { BmlDocument, type BmlElement } from './document';
import { Dom, type DomHost } from './dom';
import { fontIdOf, parseDrcs } from './drcs';
import { decodeEuc } from './euc';
import { Nvram, type ReceiverInfo, type Store } from './nvram';
import { alphaPng, applyClut } from './png';
import { type Fonts, type ImageSource, type Rect, Renderer, type RenderHost } from './render';
import {
    type CarouselFile,
    type Dii,
    hex,
    type LockKind,
    type Ref,
    type ResourceEvent,
    Resources,
    refToPath,
    STARTUP_COMPONENT,
    STARTUP_MODULE,
} from './resources';
import { Sound } from './sound';
import { ABORT, type Abort, type NativeResult, ScriptError, Suspend, type Value } from './values';
import { type Realm, Vm } from './vm';
import { parseXml } from './xml';

export type { BmlIp } from './browser';
export type { ReceiverInfo, Store } from './nvram';
export type { Fonts, Rect } from './render';

export interface Plane {
    width: number;
    height: number;
}

export interface BmlOptions {
    /** 描く場所。中に影 (shadow root) を張る */
    root: HTMLElement;
    fonts: Fonts;
    ip: BmlIp;
    /** NVRAM の置き場 */
    store: Store;
    /** 放送の時刻 (UNIX ミリ秒)。null なら TOT から */
    clock?: () => number | null;
    receiver?: Partial<ReceiverInfo>;
    /** 映像の object の場所 (画面の座標)。映像が無い・隠れていれば null */
    onVideoRect?: (rect: Rect | null, plane: Plane) => void;
    /** 文書が「出ている」と言っているか (body の invisible の逆) */
    onVisible?: (visible: boolean) => void;
    /** 待っているモジュールがあるか (データ取得中) */
    onReceiving?: (receiving: boolean) => void;
    /** 文書が替わった */
    onLoad?: (plane: Plane, path: string) => void;
    log?: (message: string) => void;
    /** ページを握る長さの決まり (既定は [budget.ts](budget.ts) の DEFAULT_BUDGET。テストで縮める) */
    budget?: Partial<BudgetLimits>;
}

export interface Bml {
    feed(message: ResponseMessage): void;
    key(code: number, down: boolean): void;
    /** 今の文書がその種類の beitem を subscribe しているか */
    listens(type: string): boolean;
    setReceiverInfo(info: Partial<ReceiverInfo>): void;
    /** 押したままのキーを忘れる (窓のフォーカスが外れて keyup が来ないとき) */
    releaseKeys(): void;
    readonly plane: Plane;
    /** 切り分け用 (今の文書の名前) */
    readonly path: string | null;
    destroy(): void;
}

/** AribKeyCode (STD-B24 第二分冊 付属2 表5-9) */
export const KEY = {
    up: 1,
    down: 2,
    left: 3,
    right: 4,
    digit0: 5,
    enter: 18,
    back: 19,
    data: 20,
    blue: 21,
    red: 22,
    green: 23,
    yellow: 24,
    data1: 25,
    data2: 26,
} as const;

/** キーの組 (TR-B14 第二分冊 5.3.1 表5-5)。used-key-list で受けるかを決める */
function keyGroup(code: number): string | null {
    if (code >= KEY.up && code <= KEY.right) return 'basic';
    if (code === KEY.enter || code === KEY.back) return 'basic';
    if (code >= KEY.blue && code <= KEY.yellow) return 'data-button';
    if (code >= KEY.digit0 && code <= KEY.digit0 + 12) return 'numeric-tuning';
    return null;
}

/** accesskey の字 (付属2 5.4.2.3) */
const ACCESS_KEYS: Record<number, string> = { 19: 'X', 21: 'B', 22: 'R', 23: 'G', 24: 'Y', 25: 'E', 26: 'F' };

type Job =
    | { kind: 'program'; token: number; source: string; name: string }
    | {
          kind: 'handler';
          token: number;
          handler: string;
          target: BmlElement | null;
          event: Record<string, Value>;
          /** setInterval から積んだもの (動き始めたら次を積めるようにする) */
          timer?: Timer;
      }
    | { kind: 'native'; token: number; run: () => void };

interface Timer {
    code: string;
    interval: number;
    remaining: number;
    handle: ReturnType<typeof setInterval> | null;
    /** 積んだ受け手がまだ動いていない (重ねて積まない) */
    queued: boolean;
}

/** JPEG の大きさ (SOF) */
function jpegSize(data: Uint8Array): { width: number; height: number } | null {
    let at = 2;
    while (at + 9 < data.length) {
        if (data[at] !== 0xff) return null;
        const marker = data[at + 1]!;
        const length = (data[at + 2]! << 8) | data[at + 3]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return {
                height: (data[at + 5]! << 8) | data[at + 6]!,
                width: (data[at + 7]! << 8) | data[at + 8]!,
            };
        }
        at += 2 + length;
    }
    return null;
}

class Engine implements DomHost, BrowserHost, RenderHost {
    readonly resources = new Resources();
    readonly sound = new Sound();
    readonly nvram: Nvram;
    readonly ureg: string[] = new Array<string>(64).fill('');
    readonly greg: string[] = new Array<string>(64).fill('');
    readonly fonts: Fonts;
    readonly ip: BmlIp;

    private readonly shadow: ShadowRoot;
    private doc: BmlDocument | null = null;
    private current: string | null = null;
    private renderer: Renderer | null = null;
    private vm: Vm | null = null;
    private dom: Dom | null = null;
    private table: readonly Rgba[] = DEFAULT_CLUT;
    private size: Plane = { width: 960, height: 540 };
    /** 文書の世代。替わったら前の文書の続きは捨てる */
    private token = 0;
    private queue: Job[] = [];
    private running = false;
    private scheduled = false;
    private destroyed = false;
    private loading = false;
    private currentEvent: Value = null;
    private focusedElement: BmlElement | null = null;
    private hidden = true;
    private screenLocked = false;
    private readonly timers = new Map<number, Timer>();
    private nextTimer = 1;
    private held: { code: number; access: boolean } | null = null;
    private readonly glyphs = new Map<
        string,
        { alpha: Uint8Array; width: number; height: number; url: string | null }
    >();
    private readonly waitingImages = new Set<string>();
    private readonly playing = new Map<BmlElement, () => void>();
    private tot: { at: number; received: number } | null = null;
    /** Ureg を消す目安 (前のサービス) */
    private service: number | null = null;
    /** 文書を読み込んでいる間。外から来るイベントは捨てる (onload より前に受け手を動かさない) */
    private preparing = false;
    private readonly budget: Budget;
    /** 暴れたので止めた。この器ではもう文書を出さない */
    private halted = false;
    /** 続きを次のタスクに回してある (pump・描き直し) */
    private deferred = false;
    private drawDeferred = false;
    /** 計っている仕事の入れ子 (外側だけ数える) */
    private depth = 0;
    /** 取りに行って「無い」と決まった画像。モジュールが届き直すまで取りに行かない */
    private readonly missingImages = new Set<string>();
    private receiver: ReceiverInfo = { zipcode: '', prefecture: 255 };
    private ticker: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly options: BmlOptions) {
        this.fonts = options.fonts;
        this.ip = options.ip;
        this.receiver = { ...this.receiver, ...options.receiver };
        this.budget = new Budget(options.budget);
        this.shadow = options.root.attachShadow({ mode: 'open' });
        this.nvram = new Nvram(
            options.store,
            () => this.receiver,
            () => ({
                originalNetworkId: this.resources.program?.originalNetworkId ?? null,
                serviceId: this.resources.program?.serviceId ?? null,
            }),
        );
        this.resources.onReceiving = (receiving) => options.onReceiving?.(receiving);
        this.ticker = setInterval(() => this.tick(), 1000);
    }

    // ---- 外から ----

    feed(message: ResponseMessage): void {
        if (this.destroyed) return;
        for (const event of this.resources.feed(message)) this.react(event);
    }

    setReceiverInfo(info: Partial<ReceiverInfo>): void {
        this.receiver = { ...this.receiver, ...info };
    }

    releaseKeys(): void {
        this.held = null;
    }

    get plane(): Plane {
        return this.size;
    }

    get path(): string | null {
        return this.current;
    }

    listens(type: string): boolean {
        return this.beitems(type).length > 0;
    }

    destroy(): void {
        this.destroyed = true;
        this.token++;
        this.queue = [];
        this.clearTimers();
        if (this.ticker !== null) clearInterval(this.ticker);
        for (const stop of this.playing.values()) stop();
        this.playing.clear();
        this.renderer?.destroy();
        this.renderer = null;
        this.unloadDrcs();
        this.resources.destroy();
        this.sound.destroy();
    }

    // ---- 時計 ----

    now(): number {
        const given = this.options.clock?.();
        if (given != null) return given;
        if (this.tot !== null) return this.tot.at + Math.min(30_000, performance.now() - this.tot.received);
        return Date.now();
    }

    // ---- 届いたもの ----

    private react(event: ResourceEvent): void {
        switch (event.type) {
            case 'time':
                this.tot = { at: event.at, received: performance.now() };
                return;
            case 'program': {
                const service = this.resources.program?.serviceId;
                // 局 (サービス) が替わったら Ureg を消す (TR-B14 第二分冊 5.12.6.1)
                if (service != null && service !== this.service) {
                    this.service = service;
                    this.ureg.fill('');
                    this.ureg[0] = `0x${hex(service, 4)}`;
                }
                return;
            }
            case 'module': {
                // 届き直したモジュールの「無い」と決めた画像は、もう一度探す
                const prefix = `${refToPath({ component: event.component, module: event.module, file: null })}/`;
                let retry = false;
                for (const key of this.missingImages) {
                    if (!key.startsWith(prefix)) continue;
                    this.missingImages.delete(key);
                    retry = true;
                }
                if (retry) this.doc?.touch();
                this.maybeStart();
                this.drawSoon();
                return;
            }
            case 'dii':
                this.moduleUpdated();
                this.dataEvent(event.component, event.dii, event.previous);
                this.maybeStart();
                return;
            case 'pmt':
                this.moduleUpdated();
                this.pmtChanged(event.components);
                this.maybeStart();
                return;
            case 'es':
                this.esEvents(event.message);
                return;
        }
    }

    /** 今の文書の部品 */
    private component(): number | null {
        const ref = this.current === null ? null : this.resources.resolve(this.current, null);
        return ref?.component ?? null;
    }

    private dataEvent(component: number, dii: Dii, previous: Dii | null): void {
        if (previous === null || previous.dataEventId === dii.dataEventId || this.doc === null) return;
        const mine = component === this.component();
        const back = component === STARTUP_COMPONENT && dii.returnToEntry;
        if (!mine && !back) return;
        if (mine) {
            for (const beitem of this.beitems('DataEventChanged')) {
                this.handle(beitem, 'onoccur', {
                    type: 'DataEventChanged',
                    status: dii.modules.size === 0 ? 1 : 0,
                });
            }
        }
        // 受け手が文書を替えなければ、入口から出直す (TR-B14 第二分冊 表5-11)
        this.enqueue({
            kind: 'native',
            token: this.token,
            run: () => {
                this.resources.unlockAll(mine ? undefined : 'lock');
                this.restart();
            },
        });
    }

    private pmtChanged(components: Map<number, unknown>): void {
        if (this.doc === null) return;
        if (!components.has(STARTUP_COMPONENT)) {
            this.exit();
            return;
        }
        const component = this.component();
        if (component !== null && !components.has(component)) {
            this.resources.unlockAll();
            this.restart();
        }
    }

    /** 文書が無いときに、入口のモジュールが揃っていれば始める (同じ版が送り直されても始める) */
    private maybeStart(): void {
        if (this.doc !== null || this.loading || this.destroyed || this.halted) return;
        if (this.resources.pmtSeen && !this.resources.pmt.has(STARTUP_COMPONENT)) return;
        if (!this.resources.has(STARTUP_COMPONENT, STARTUP_MODULE)) return;
        void this.startup();
    }

    /** 今の文書の残り (待っているイベント・タイマー・続き) を捨てる。文書を替える前に同期で */
    private abandon(): void {
        this.token++;
        this.queue = [];
        this.running = false;
        this.clearTimers();
    }

    /** 今の実行を打ち切って入口から出直す */
    private restart(): void {
        this.abandon();
        // 入口が届くまでのあいだ、古い文書の受け手を動かさない
        this.preparing = true;
        void this.startup();
    }

    /** ModuleUpdated の beitem に、DII と PMT の変わり目を知らせる (付属2 表5-11 の status) */
    private moduleUpdated(): void {
        for (const beitem of this.beitems('ModuleUpdated')) this.checkModule(beitem, false);
    }

    private checkModule(beitem: BmlElement, first: boolean): void {
        const moduleRef = beitem.attr('module_ref') ?? '';
        const ref = this.resources.resolve(moduleRef, this.current);
        if (ref === null || ref.module === null) return;
        const memo = beitem.memo as { exists?: boolean; version?: number; event?: number };
        // 一度見たもの (subscribe を同じ値で書き直しただけ) は、初めての知らせを出し直さない
        if (first && memo.exists !== undefined) return;
        const fire = (status: number): void =>
            this.handle(beitem, 'onoccur', { type: 'ModuleUpdated', status, moduleRef });
        if (this.resources.pmtSeen && !this.resources.pmt.has(ref.component)) {
            if (first || memo.exists === true) fire(1);
            beitem.memo = { exists: false };
            return;
        }
        const dii = this.resources.dii.get(ref.component);
        if (dii === undefined) return;
        const entry = dii.modules.get(ref.module);
        if (first) {
            fire(entry === undefined ? 1 : 2);
        } else if (entry === undefined) {
            if (memo.exists === true) fire(1);
            if (memo.event !== undefined && memo.event !== dii.dataEventId && memo.exists === true) fire(5);
        } else {
            if (memo.exists !== true) fire(2);
            else if (memo.version !== undefined && memo.version !== entry.version) fire(0);
            if (memo.event !== undefined && memo.event !== dii.dataEventId)
                fire(memo.exists === true ? 6 : 4);
        }
        beitem.memo = { exists: entry !== undefined, version: entry?.version, event: dii.dataEventId };
    }

    /** ストリーム記述子 (イベントメッセージ・NPT) */
    private esEvents(message: Extract<ResponseMessage, { type: 'esEventUpdated' }>): void {
        const component = this.component();
        const target = (beitem: BmlElement): number | null => {
            const esRef = beitem.attr('es_ref');
            if (esRef === null || esRef === '') return component;
            return this.resources.resolve(esRef, this.current)?.component ?? null;
        };
        if (message.events.some((e) => e.type === 'nptReference')) {
            for (const beitem of this.beitems('NPTReferred')) {
                if (target(beitem) !== message.componentId || beitem.memo['npt'] === true) continue;
                beitem.memo['npt'] = true;
                this.handle(beitem, 'onoccur', {
                    type: 'NPTReferred',
                    esRef: beitem.attr('es_ref') ?? `/${hex(message.componentId, 2)}`,
                });
            }
        }
        for (const beitem of this.beitems('EventMessageFired')) {
            if (target(beitem) !== message.componentId) continue;
            const group = Number.parseInt(beitem.attr('message_group_id') ?? '0', 10) || 0;
            const wantId = Number.parseInt(beitem.attr('message_id') ?? '255', 10);
            const wantVersion = Number.parseInt(beitem.attr('message_version') ?? '255', 10);
            for (const event of message.events) {
                // 時刻指定 (NPT) のイベントは NPT を持たないので動かせない。すぐ起きるものだけ
                if (event.type !== 'immediateEvent' || event.eventMessageGroupId !== group) continue;
                if (
                    group === 0 &&
                    this.resources.dii.get(message.componentId)?.dataEventId !== message.dataEventId
                )
                    continue;
                const id = event.eventMessageId >> 8;
                const version = event.eventMessageId & 0xff;
                if ((wantId !== 255 && wantId !== id) || (wantVersion !== 255 && wantVersion !== version))
                    continue;
                beitem.memo['messages'] ??= {};
                const seen = beitem.memo['messages'] as Record<number, number>;
                if (seen[id] === version) continue;
                seen[id] = version;
                this.handle(beitem, 'onoccur', {
                    type: 'EventMessageFired',
                    privateData: decodeEuc(Uint8Array.from(event.privateDataByte)),
                    esRef: beitem.attr('es_ref') ?? `/${hex(message.componentId, 2)}`,
                    messageId: id,
                    messageVersion: version,
                    messageGroupId: event.eventMessageGroupId,
                });
            }
        }
    }

    /** 1 秒ごと。時刻指定の TimerFired (absolute) */
    private tick(): void {
        const now = this.now();
        for (const beitem of this.beitems('TimerFired')) {
            if (beitem.memo['fired'] === true) continue;
            const mode = beitem.attr('time_mode') ?? '';
            if (mode !== 'absolute' && mode !== 'origAbsolute') continue;
            const value = beitem.attr('time_value') ?? '';
            const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
            if (m === null) continue;
            const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) - 9 * 3600_000;
            if (at > now) continue;
            beitem.memo['fired'] = true;
            this.handle(beitem, 'onoccur', { type: 'TimerFired', status: 0 });
        }
    }

    // ---- 文書を替える ----

    private async startup(): Promise<void> {
        if (this.halted) return;
        const base = `/${hex(STARTUP_COMPONENT, 2)}/${hex(STARTUP_MODULE, 4)}`;
        const ref = this.resources.resolve(base, null)!;
        this.loading = true;
        const token = this.token;
        await this.resources.fetch({ ...ref, file: 'startup.bml' });
        // 待つ間に別の文書を読み始めた・止めたなら、そちらに任せる
        if (token !== this.token || this.destroyed) return;
        const named = this.resources.file({ ...ref, file: 'startup.bml' });
        if (named !== null) await this.load(`${base}/startup.bml`, true);
        else if (this.resources.file(ref) !== null) await this.load(base, true);
        else this.exit();
    }

    /**
     * 文書を読んで出す。`name` は文書の中の書き方のまま (今の文書から見た相対でもよい)。
     * 読めなければ入口から出直す (入口が読めなければ止める)
     */
    private async load(name: string, entry = false): Promise<void> {
        if (this.halted) return;
        this.abandon();
        const token = this.token;
        this.loading = true;
        this.preparing = true;
        const ref = this.resources.resolve(name, this.current);
        const file = ref === null || ref.module === null ? null : await this.resources.fetch(ref);
        if (token !== this.token || this.destroyed) return;
        const shown = file !== null && ref !== null && (await this.show(file, refToPath(ref), token));
        if (token !== this.token || this.destroyed) return;
        this.loading = false;
        this.preparing = false;
        if (shown) return;
        this.log(`文書が読めません: ${name}`);
        if (entry) {
            this.exit();
            return;
        }
        // 入口の文書が読めない文書へ移ろうとしたなら、入口のまま止める (出直すと同じ遷移を
        // 繰り返して回り続ける)。そうでなければ入口から出直す
        if (this.current === `/${hex(STARTUP_COMPONENT, 2)}/${hex(STARTUP_MODULE, 4)}/startup.bml`) return;
        setTimeout(() => {
            if (token === this.token && !this.destroyed) this.restart();
        }, 0);
    }

    private exit(): void {
        this.abandon();
        this.loading = false;
        this.preparing = false;
        this.resources.unlockAll();
        for (const stop of this.playing.values()) stop();
        this.playing.clear();
        this.unloadDrcs();
        this.renderer?.destroy();
        this.renderer = null;
        this.doc = null;
        this.vm = null;
        this.dom = null;
        this.current = null;
        this.focusedElement = null;
        this.setHidden(true);
        this.options.onVideoRect?.(null, this.size);
    }

    /** 文書を組んで出す。スクリプト・onload を積み終えたら true */
    private async show(file: CarouselFile, path: string, token: number): Promise<boolean> {
        // 組み立ては同期で重い。動いた時間に数える (読み込みをくり返す文書も止められるように)
        let started = performance.now();
        const xml = parseXml(decodeEuc(file.data));
        const doc = xml === null ? null : new BmlDocument(xml);
        this.charge(started);
        if (doc === null || token !== this.token) return false;
        // 要るファイル (link のスタイル・CLUT・script の src) は、文書を替える前に全部そろえる
        const fetchText = async (url: string): Promise<string | null> => {
            const ref = this.resources.resolve(url, path);
            const data = ref === null ? null : await this.resources.fetch(ref);
            return data === null ? null : decodeEuc(data.data);
        };
        const rules: Rule[] = [];
        for (const element of doc.root.descendants()) {
            let text: string | null = null;
            if (element.tag === 'style') text = element.text;
            else if (
                element.tag === 'link' &&
                (element.attr('rel') ?? 'stylesheet').toLowerCase().includes('stylesheet')
            ) {
                text = await fetchText(element.attr('href') ?? '');
                if (token !== this.token) return false;
            }
            if (text !== null) rules.push(...parseStylesheet(text, rules.length));
        }
        doc.applyRules(rules);
        const body = doc.body;
        let table = DEFAULT_CLUT;
        const clutUrl = body === null ? null : parseUrl(body.style().clut ?? '');
        if (clutUrl !== null) {
            const ref = this.resources.resolve(clutUrl, path);
            const data = ref === null ? null : await this.resources.fetch(ref);
            if (token !== this.token) return false;
            if (data !== null) table = readClut(data.data);
        }
        const scripts: { source: string; name: string }[] = [];
        for (const script of doc.elements('script')) {
            const src = script.attr('src');
            if (src === null || src === '') {
                scripts.push({ source: script.text, name: `${path}#script` });
                continue;
            }
            const source = await fetchText(src);
            if (token !== this.token) return false;
            scripts.push({ source: source ?? '', name: src });
        }

        // ここから文書を替える (以降は同期で積み終える)
        started = performance.now();
        const previous = this.current === null ? null : this.resources.resolve(this.current, null);
        const next = this.resources.resolve(path, null);
        // 別の部品の文書へ移ったら lockModuleOnMemory で押さえたものを外す (TR-B14 第二分冊 表5-11)
        if (previous !== null && next !== null && previous.component !== next.component) {
            this.resources.unlockAll('lock');
        }
        for (const stop of this.playing.values()) stop();
        this.playing.clear();
        this.unloadDrcs();
        this.current = path;
        this.table = table;
        const resolution = body?.style().resolution ?? '960x540';
        this.size = resolution === '720x480' ? { width: 720, height: 480 } : { width: 960, height: 540 };

        // スクリプトの世界は文書ごとに作り直す
        const realm = createRealm({ now: () => this.now() });
        this.doc = doc;
        this.focusedElement = null;
        this.held = null;
        this.currentEvent = null;
        this.vm = new Vm(realm);
        this.dom = new Dom(this);
        realm.global.put('document', this.dom.document);
        realm.global.put('browser', defineBrowser(this));
        realm.global.put('BinaryTable', defineBinaryTable(this));

        this.renderer?.destroy();
        this.renderer = new Renderer(this.shadow, doc, this, (rect) =>
            this.options.onVideoRect?.(rect, this.size),
        );
        this.options.onLoad?.(this.size, path);
        this.setHidden(body?.attr('invisible') === 'invisible');
        this.screenLocked = false;
        this.renderer.draw(true);

        // フォーカスは onload より前に当たるが、onfocus は onload の後 (付属1 5.1.3)
        const first = this.navIndex(0);
        if (first?.style().visible) {
            this.focusedElement = first;
            first.setState('focus');
        }
        this.preparing = false;
        for (const { source, name } of scripts) this.enqueue({ kind: 'program', token, source, name });
        if (body !== null) this.handle(body, 'onload', { type: 'load' });
        this.enqueue({
            kind: 'native',
            token,
            run: () => {
                for (const beitem of this.beitems('ModuleUpdated')) this.checkModule(beitem, true);
                if (this.focusedElement !== null)
                    this.handle(this.focusedElement, 'onfocus', { type: 'focus' });
            },
        });
        this.charge(started);
        return true;
    }

    // ---- イベントを順に動かす ----

    private enqueue(job: Job): void {
        if (job.token !== this.token) return;
        this.queue.push(job);
        // 動いている・回してある間は、そちらが続けて動かす
        if (this.scheduled || this.running || this.deferred) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            this.pump();
        });
    }

    /** 要素の on* (`f();` の形だけ) を、イベントを添えて動かす */
    private handle(element: BmlElement, attribute: string, event: Record<string, Value>): void {
        // 文書を読み込んでいる間 (onload より前) に来たものは捨てる
        if (this.preparing) return;
        const job = this.job(element, attribute, event);
        if (job !== null) this.enqueue(job);
    }

    private job(element: BmlElement, attribute: string, event: Record<string, Value>): Job | null {
        const handler = element.attr(attribute);
        if (handler === null || /^\s*$/.test(handler)) return null;
        return { kind: 'handler', token: this.token, handler, target: element, event };
    }

    /** 待っているものを順に動かす。区切りを使い切ったら、続きは次のタスクへ (ページを固めない) */
    private pump(): void {
        this.work(() => {
            while (!this.running && !this.destroyed) {
                if (this.queue.length > 0 && this.budget.spent()) {
                    this.later();
                    return;
                }
                const job = this.queue.shift();
                if (job === undefined) {
                    this.draw();
                    return;
                }
                if (job.token !== this.token) continue;
                if (job.kind === 'native') {
                    // 中で積んだものは、もう待っているものより先に (積んだ順で) 動かす
                    const rest = this.queue;
                    this.queue = [];
                    job.run();
                    this.queue.push(...rest);
                    continue;
                }
                if (job.kind === 'handler' && job.timer !== undefined) job.timer.queued = false;
                const vm = this.vm;
                const dom = this.dom;
                if (vm === null || dom === null) continue;
                try {
                    if (job.kind === 'program') {
                        vm.startProgram(compileScript(job.source, job.name));
                        this.currentEvent = dom.event({});
                    } else {
                        const name = /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?\s*$/.exec(job.handler)?.[1];
                        if (name === undefined)
                            throw new ScriptError(`受け手の形が読めません: ${job.handler}`);
                        this.currentEvent = dom.event({ ...job.event, target: dom.wrap(job.target) });
                        vm.startCall(vm.realm.global.get(name));
                    }
                } catch (error) {
                    this.log(
                        `スクリプトを始められません: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    continue;
                }
                this.running = true;
                this.step(job.token, vm);
            }
        });
    }

    /**
     * スクリプトを続ける。約束の続き (すぐ返る待ちのくり返し) で来ても、今の仕事の区切りを
     * 使い切っていれば次のタスクへ回す
     */
    private step(token: number, vm: Vm): void {
        if (token !== this.token || this.destroyed || vm !== this.vm) return;
        if (this.budget.spent()) {
            setTimeout(() => this.step(token, vm), 0);
            return;
        }
        this.work(() => this.advance(token, vm));
    }

    private advance(token: number, vm: Vm): void {
        const result = vm.run(this.budget.deadline());
        switch (result.kind) {
            case 'yield':
                setTimeout(() => this.step(token, vm), 0);
                return;
            case 'suspend':
                // 待つ間 (sleep など) に、ここまでの変化を見せる
                this.draw();
                void result.promise.then(
                    (value) => {
                        if (token !== this.token || vm !== this.vm) return;
                        vm.resume(value);
                        this.step(token, vm);
                    },
                    () => {
                        if (token !== this.token || vm !== this.vm) return;
                        vm.resume(undefined);
                        this.step(token, vm);
                    },
                );
                return;
            case 'error':
                this.log(`スクリプトの誤り: ${result.error.message}`);
                break;
            case 'done':
            case 'abort':
                break;
        }
        if (token !== this.token) return;
        this.running = false;
        this.currentEvent = this.dom?.event({}) ?? null;
        this.screenLocked = false;
        this.draw();
        // 続けて動かす。呼び出しを積み重ねないよう、一度手を放してから
        queueMicrotask(() => this.pump());
    }

    /** 続きを次のタスクに (重ねて回さない) */
    private later(): void {
        if (this.deferred) return;
        this.deferred = true;
        setTimeout(() => {
            this.deferred = false;
            this.pump();
        }, 0);
    }

    private draw(): void {
        if (!this.screenLocked) this.renderer?.draw();
    }

    /** 外から (モジュール・画像が届いた) の描き直し。区切りを使い切っていれば次のタスクで */
    private drawSoon(): void {
        if (this.running) return;
        if (this.budget.spent()) {
            if (this.drawDeferred) return;
            this.drawDeferred = true;
            setTimeout(() => {
                this.drawDeferred = false;
                this.drawSoon();
            }, 0);
            return;
        }
        this.work(() => this.draw());
    }

    /** エンジンの仕事を動かして、動いた時間を数える (入れ子は外側だけ数える) */
    private work(task: () => void): void {
        if (this.depth > 0) {
            task();
            return;
        }
        const started = performance.now();
        this.depth++;
        try {
            task();
        } finally {
            this.depth--;
            this.charge(started);
        }
    }

    /** `started` から今までを動いた時間に足す。休みなく動き続けていたら文書を止める */
    private charge(started: number): void {
        if (this.depth > 0 || this.halted || this.destroyed) return;
        if (!this.budget.account(performance.now() - started)) return;
        const { window, ratio } = this.budget.limits;
        this.halted = true;
        this.log(
            `文書が休みなく動き続けるので止めました (${window}ms のうち ${Math.round(ratio * 100)}% を超えて動いた): ${this.current ?? ''}`,
        );
        this.exit();
    }

    log(message: string): void {
        this.options.log?.(message);
    }

    // ---- DOM の口 ----

    get realm(): Realm {
        return this.vm!.realm;
    }

    get document(): BmlDocument {
        return this.doc!;
    }

    focused(): BmlElement | null {
        return this.focusedElement;
    }

    event(): Value {
        return this.currentEvent;
    }

    invisible(): boolean {
        return this.hidden;
    }

    setInvisible(invisible: boolean): void {
        this.doc?.body?.setAttr('invisible', invisible ? 'invisible' : null);
        this.setHidden(invisible);
    }

    private setHidden(hidden: boolean): void {
        this.hidden = hidden;
        this.options.onVisible?.(!hidden);
    }

    subscribed(element: BmlElement): void {
        if (element.attr('type') === 'ModuleUpdated') this.checkModule(element, true);
    }

    keysChanged(): void {}

    focus(element: BmlElement): void {
        const previous = this.focusedElement;
        if (previous === element || !element.style().visible) return;
        if (previous !== null) {
            previous.setState('normal');
            this.handle(previous, 'onblur', { type: 'blur' });
        }
        this.focusedElement = element;
        element.setState('focus');
        this.handle(element, 'onfocus', { type: 'focus' });
    }

    blur(element: BmlElement): void {
        if (this.focusedElement !== element) return;
        element.setState('normal');
        this.focusedElement = null;
        this.handle(element, 'onblur', { type: 'blur' });
    }

    stream(element: BmlElement, status: string): void {
        const type = (element.attr('type') ?? '').toLowerCase();
        if (type !== 'audio/x-arib-aiff') {
            element.setAttr('streamstatus', status);
            return;
        }
        this.playing.get(element)?.();
        this.playing.delete(element);
        element.setAttr('streamstatus', 'stop');
        if (status !== 'play') return;
        const ref = this.resources.resolve(element.attr('data') ?? '', this.current);
        const file = ref === null ? null : this.resources.file(ref);
        if (file === null) return;
        const stop = this.sound.aiff(file.data, () => {
            this.playing.delete(element);
            element.setAttr('streamstatus', 'stop');
        });
        if (stop === null) return;
        this.playing.set(element, stop);
        element.setAttr('streamstatus', 'play');
    }

    // ---- browser の口 ----

    program(): ReturnType<BrowserHost['program']> {
        return this.resources.program;
    }

    activeDocument(): string | null {
        return this.current;
    }

    launch(name: string): Abort | number {
        if (name.startsWith('#')) return Number.NaN;
        void this.load(name);
        return ABORT;
    }

    quit(): Abort {
        this.resources.unlockAll();
        this.restart();
        return ABORT;
    }

    setTimer(code: string, interval: number, count: number): number {
        if (!(interval > 0)) return Number.NaN;
        const id = this.nextTimer++;
        const timer: Timer = {
            code,
            interval,
            remaining: count > 0 ? count : Number.POSITIVE_INFINITY,
            handle: null,
            queued: false,
        };
        this.timers.set(id, timer);
        this.startTimer(id, timer);
        return id;
    }

    private startTimer(id: number, timer: Timer): void {
        const token = this.token;
        timer.handle = setInterval(() => {
            // 前に積んだものがまだ動いていなければ積まない (受け手が間隔より重いと、待ちが際限なく伸びる)
            if (token !== this.token || timer.queued) return;
            timer.remaining--;
            if (timer.remaining <= 0) this.timer(id, 'clear');
            const name = /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?\s*$/.exec(timer.code)?.[1];
            if (name === undefined) return;
            timer.queued = true;
            this.enqueue({ kind: 'handler', token, handler: `${name}()`, target: null, event: {}, timer });
        }, timer.interval);
    }

    timer(id: number, action: 'clear' | 'pause' | 'resume'): boolean {
        const timer = this.timers.get(id);
        if (timer === undefined) return false;
        if (action === 'resume') {
            if (timer.handle === null) this.startTimer(id, timer);
            return true;
        }
        if (timer.handle !== null) clearInterval(timer.handle);
        timer.handle = null;
        if (action === 'clear') this.timers.delete(id);
        return true;
    }

    private clearTimers(): void {
        for (const timer of this.timers.values()) if (timer.handle !== null) clearInterval(timer.handle);
        this.timers.clear();
    }

    sleep(ms: number): Suspend {
        return new Suspend(new Promise((resolve) => setTimeout(() => resolve(1), ms)));
    }

    screen(locked: boolean): void {
        this.screenLocked = locked;
        if (!locked) this.renderer?.draw();
    }

    private moduleRef(module: string): Ref | null {
        const ref = this.resources.resolve(module, this.current);
        return ref === null || ref.module === null ? null : ref;
    }

    lock(module: string, kind: LockKind): number {
        const ref = this.moduleRef(module);
        if (ref === null || ref.module === null) return Number.NaN;
        // Ex で押さえられるのは 0x40・0x50・0x60 だけ (TR-B14 第二分冊 5.12.6.9)
        if (kind === 'lockEx' && ![0x40, 0x50, 0x60].includes(ref.component)) return Number.NaN;
        const token = this.token;
        return this.resources.lock(ref.component, ref.module, kind, (status) => {
            if (token !== this.token) return;
            for (const beitem of this.beitems('ModuleLocked')) {
                const target = this.moduleRef(beitem.attr('module_ref') ?? '');
                if (target?.component !== ref.component || target.module !== ref.module) continue;
                this.handle(beitem, 'onoccur', { type: 'ModuleLocked', status, moduleRef: module });
            }
        });
    }

    unlock(module: string, kind?: LockKind): boolean {
        const ref = this.moduleRef(module);
        return ref !== null && ref.module !== null && this.resources.unlock(ref.component, ref.module, kind);
    }

    locked(): [string, boolean, boolean][] {
        return this.resources.locked();
    }

    detect(component: string): number {
        const ref = this.resources.resolve(component, this.current);
        if (ref === null) return Number.NaN;
        return this.resources.pmt.has(ref.component) ? 1 : 0;
    }

    loadDrcs(name: string): NativeResult {
        const ref = this.resources.resolve(name, this.current);
        if (ref === null) return Number.NaN;
        const token = this.token;
        return new Suspend(
            this.resources.fetch(ref).then((file) => {
                // 待つ間に文書が替わったら、前の文書の外字は入れない
                if (file === null || token !== this.token) return Number.NaN;
                for (const [unit, glyph] of parseDrcs(file.data)) {
                    const key = `${unit}:${glyph.width}:${glyph.fontId}`;
                    const old = this.glyphs.get(key);
                    if (old?.url != null) URL.revokeObjectURL(old.url);
                    this.glyphs.set(key, {
                        alpha: glyph.alpha,
                        width: glyph.width,
                        height: glyph.height,
                        url: null,
                    });
                }
                this.doc?.touch();
                return 1;
            }),
        );
    }

    async binaryTable(name: string): Promise<Uint8Array | null> {
        const ref = this.resources.resolve(name, this.current);
        return ref === null ? null : ((await this.resources.fetch(ref))?.data ?? null);
    }

    private unloadDrcs(): void {
        for (const glyph of this.glyphs.values()) if (glyph.url !== null) URL.revokeObjectURL(glyph.url);
        this.glyphs.clear();
    }

    // ---- 描く側の口 ----

    clut(): readonly Rgba[] {
        return this.table;
    }

    resolution(): Plane {
        return this.size;
    }

    image(url: string, _kind: 'background' | 'object', type: string): ImageSource | null {
        const ref = this.resources.resolve(url, this.current);
        if (ref === null || ref.module === null) return null;
        const file = this.resources.file(ref);
        if (file === null) {
            const key = refToPath(ref);
            if (!this.waitingImages.has(key) && !this.missingImages.has(key)) {
                this.waitingImages.add(key);
                void this.resources.fetch(ref).then(() => {
                    this.waitingImages.delete(key);
                    // 描けるようにならなかった (来ないと決まった・押さえた古い版に無い) なら描き直さない。
                    // 描き直すとまたここへ来て、すぐ「無い」と返るのをくり返す (2026-10-12 本番で
                    // タブが固まった)。モジュールが届き直したら探し直す
                    if (this.resources.file(ref) === null) {
                        this.missingImages.add(key);
                        return;
                    }
                    this.doc?.touch();
                    this.drawSoon();
                });
            }
            return null;
        }
        const png = type === 'image/x-arib-png';
        const variant = png ? `png:${this.current}` : 'raw';
        const made = file.urls.get(variant);
        if (made !== undefined) return made;
        let source: ImageSource | null = null;
        if (png) {
            const fixed = applyClut(file.data, this.table);
            if (fixed !== null) {
                source = {
                    url: URL.createObjectURL(new Blob([fixed.data], { type: 'image/png' })),
                    width: fixed.width,
                    height: fixed.height,
                };
            }
        } else {
            const mime = `${file.type.type}/${file.type.subtype}`;
            const size = mime === 'image/jpeg' ? jpegSize(file.data) : null;
            source = {
                url: URL.createObjectURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type: mime })),
                width: size?.width ?? null,
                height: size?.height ?? null,
            };
        }
        if (source !== null) file.urls.set(variant, source);
        return source;
    }

    drcs(unit: number, fontSize: number, family: string): string | null {
        const glyph =
            this.glyphs.get(`${unit}:${fontSize}:${fontIdOf(family)}`) ??
            this.glyphs.get(`${unit}:${fontSize}:1`);
        if (glyph === undefined) return null;
        glyph.url ??= URL.createObjectURL(
            new Blob([alphaPng(glyph.width, glyph.height, glyph.alpha)], { type: 'image/png' }),
        );
        return glyph.url;
    }

    // ---- キー ----

    key(code: number, down: boolean): void {
        if (this.doc === null || this.destroyed || this.preparing) return;
        if (code === KEY.data) {
            // d は DataButtonPressed だけを起こす
            if (down)
                for (const beitem of this.beitems('DataButtonPressed'))
                    this.handle(beitem, 'onoccur', { type: 'DataButtonPressed' });
            return;
        }
        if (down) this.keyDown(code);
        else this.keyUp(code);
    }

    /** used-key-list で受けるキーか */
    private accepts(code: number): boolean {
        const list = this.doc?.body?.style().usedKeyList ?? [];
        if (list[0] === 'none') return false;
        const group = keyGroup(code);
        if (group === null) return false;
        return list.length === 0 ? group === 'basic' || group === 'data-button' : list.includes(group);
    }

    private keyDown(code: number): void {
        if (this.held !== null || !this.accepts(code)) return;
        const held = { code, access: false };
        this.held = held;
        const token = this.token;
        const target = this.focusedElement;
        if (target !== null) this.handle(target, 'onkeydown', { type: 'keydown', keyCode: code });
        this.enqueue({
            kind: 'native',
            token,
            run: () => {
                // accesskey: その要素へフォーカスを移し、keyup と決定の keydown が起きたことにする
                const access = ACCESS_KEYS[code];
                let key = code;
                const front: (Job | null)[] = [];
                if (access !== undefined) {
                    const element = this.doc?.root
                        ? [...this.doc.root.descendants()].find((e) => e.attr('accesskey') === access)
                        : undefined;
                    if (element?.style().visible) {
                        this.focus(element);
                        held.access = true;
                        key = KEY.enter;
                        front.push(
                            this.job(element, 'onkeyup', { type: 'keyup', keyCode: code }),
                            this.job(element, 'onkeydown', { type: 'keydown', keyCode: KEY.enter }),
                        );
                    }
                }
                // 後から来た keyup より先に動く (native の中で積んだものは先に動かす。pump)
                front.push({ kind: 'native', token, run: () => this.afterKeyDown(key) });
                for (const job of front) if (job !== null) this.enqueue(job);
            },
        });
    }

    private afterKeyDown(code: number): void {
        const focused = this.focusedElement;
        if (focused === null) return;
        // 十字キーで nav-* の先へ。見えない要素は飛ばす (付属2 5.4.13.3)
        const s = focused.style();
        const next = {
            [KEY.up]: s.navUp,
            [KEY.down]: s.navDown,
            [KEY.left]: s.navLeft,
            [KEY.right]: s.navRight,
        }[code];
        if (next !== undefined && next !== null) {
            const seen = new Set<number>();
            let index: number | null = next;
            while (index !== null && !seen.has(index)) {
                seen.add(index);
                const target = this.navIndex(index);
                if (target === null) break;
                if (target.style().visible) {
                    this.focus(target);
                    break;
                }
                const t = target.style();
                index =
                    {
                        [KEY.up]: t.navUp,
                        [KEY.down]: t.navDown,
                        [KEY.left]: t.navLeft,
                        [KEY.right]: t.navRight,
                    }[code] ?? null;
            }
            return;
        }
        if (code === KEY.enter) {
            focused.setState('active');
            this.handle(focused, 'onclick', { type: 'click' });
            if (focused.tag === 'a') {
                const href = focused.attr('href') ?? '';
                if (href !== '' && !href.startsWith('#')) {
                    this.enqueue({ kind: 'native', token: this.token, run: () => void this.load(href) });
                }
            }
        }
    }

    private keyUp(code: number): void {
        const held = this.held;
        if (held === null || held.code !== code) return;
        this.held = null;
        // keydown の後始末 (accesskey・決定) が済んでから見る
        this.enqueue({
            kind: 'native',
            token: this.token,
            run: () => {
                const focused = this.focusedElement;
                if (focused === null) return;
                const key = held.access ? KEY.enter : code;
                if (key === KEY.enter && focused.state === 'active') focused.setState('focus');
                if (!this.accepts(key)) return;
                const job = this.job(focused, 'onkeyup', { type: 'keyup', keyCode: key });
                if (job !== null) this.enqueue(job);
            },
        });
    }

    private navIndex(index: number): BmlElement | null {
        if (this.doc === null) return null;
        for (const element of this.doc.root.descendants())
            if (element.style().navIndex === index) return element;
        return null;
    }

    /** subscribe している beitem (文書の順) */
    private beitems(type: string): BmlElement[] {
        if (this.doc === null) return [];
        return this.doc
            .elements('beitem')
            .filter((b) => b.attr('type') === type && b.attr('subscribe') === 'subscribe');
    }
}

export function createBml(options: BmlOptions): Bml {
    return new Engine(options);
}

/** 押したキー (KeyboardEvent.key) を AribKeyCode に。対応が無ければ -1 */
export function aribKey(key: string): number {
    if (key >= '0' && key <= '9' && key.length === 1) return KEY.digit0 + Number(key);
    switch (key) {
        case 'ArrowUp':
            return KEY.up;
        case 'ArrowDown':
            return KEY.down;
        case 'ArrowLeft':
            return KEY.left;
        case 'ArrowRight':
            return KEY.right;
        case 'Enter':
        case ' ':
            return KEY.enter;
        case 'Backspace':
        case 'x':
        case 'X':
            return KEY.back;
        case 'd':
        case 'D':
            return KEY.data;
        case 'b':
        case 'B':
            return KEY.blue;
        case 'r':
        case 'R':
            return KEY.red;
        case 'g':
        case 'G':
            return KEY.green;
        case 'y':
        case 'Y':
            return KEY.yellow;
        case 'e':
        case 'E':
            return KEY.data1;
        case 'f':
        case 'F':
            return KEY.data2;
    }
    return -1;
}
