/**
 * カルーセルで届いたファイルを持つ。**解くのはサーバ** ([ts/bml.ts](../ts/bml.ts)) で、ここには
 * 組み上がったモジュールが `ResponseMessage` で届く。
 *
 * - 文書の中の名前 (`/40/0000/startup.bml`・`~/0001/a.png`・`a.png`・`arib-dc://-1.-1.-1/40/0000`)
 *   を「部品・モジュール・ファイル」に解く。**大文字小文字は区別しない** (放送は 16 進の大小を混ぜる)
 * - まだ届いていないものは待つ (`fetch`)。待っている間は「データ取得中」
 * - `lockModuleOnMemory(Ex)` で押さえたモジュールは、版が上がっても押さえた版を持ち続ける
 * - DII でモジュールが消えた・版が上がったら古いものを捨てる。データイベントが変わったら部品ごと捨てる
 */

import type {
    ComponentPMT,
    ESEventUpdatedMessage,
    MediaType,
    ModuleListEntry,
    ProgramInfoMessage,
    ResponseMessage,
} from '#lib/ts/bml-protocol.js';
import type { ImageSource } from './render';

export interface CarouselFile {
    /** 小文字にそろえた名前 (multipart でないモジュールは '') */
    name: string;
    type: MediaType;
    data: Uint8Array;
    /** 作った blob: の URL (種類ごと)。モジュールを捨てるときに返す (動く絵はコマごとの URL も) */
    urls: Map<string, ImageSource>;
}

/** スキームの付いた名前のうち、データカルーセルを指すもの (arib-dc) のほかで規格にあるもの (STD-B24 第二編 9.2) */
const KNOWN_SCHEMES = new Set(['arib-dc', 'arib', 'nvram', 'romsound', 'http', 'https', 'ftp']);

/**
 * 規格に無いスキームの名前 (`bml://` など) なら、そのスキームを返す。扱えないので呼び手が
 * 「扱えない」と知らせて失敗にする
 */
export function unknownScheme(url: string): string | null {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
    return scheme === undefined || KNOWN_SCHEMES.has(scheme) ? null : scheme;
}

interface Module {
    component: number;
    id: number;
    version: number;
    dataEventId: number;
    files: Map<string, CarouselFile>;
}

export interface Dii {
    dataEventId: number;
    modules: Map<number, ModuleListEntry>;
    returnToEntry: boolean;
}

export type LockKind = 'lock' | 'lockEx';

/** 文書の中の名前を解いたもの */
export interface Ref {
    component: number;
    /** 部品だけを指す (`~` や `/40`) ときは null */
    module: number | null;
    /** ファイル名 (小文字)。モジュールそのものなら null */
    file: string | null;
}

export type ResourceEvent =
    | { type: 'pmt'; components: Map<number, ComponentPMT>; previous: Map<number, ComponentPMT> }
    | { type: 'dii'; component: number; dii: Dii; previous: Dii | null }
    | { type: 'module'; component: number; module: number }
    | { type: 'program' }
    | { type: 'time'; at: number }
    | { type: 'es'; message: ESEventUpdatedMessage };

interface Pending {
    component: number;
    module: number;
    resolve: (module: Module | null) => void;
    kind: LockKind | null;
}

/** 入口の部品 (地上波 A プロファイル・BS/CS は 0x40) とモジュール */
export const STARTUP_COMPONENT = 0x40;
export const STARTUP_MODULE = 0;

/** 0x0d はデータカルーセル */
const STREAM_CAROUSEL = 0x0d;

const key = (component: number, module: number): string => `${component}/${module}`;

export const hex = (n: number, size: number): string => n.toString(16).padStart(size, '0');

/** 解いた名前を文書の名前に (`/40/0000/startup.bml`) */
export function refToPath(ref: Ref): string {
    let out = `/${hex(ref.component, 2)}`;
    if (ref.module !== null) out += `/${hex(ref.module, 4)}`;
    if (ref.file !== null) out += `/${ref.file}`;
    return out;
}

export class Resources {
    pmt = new Map<number, ComponentPMT>();
    pmtSeen = false;
    readonly dii = new Map<number, Dii>();
    private readonly cache = new Map<string, Module>();
    private readonly locks = new Map<string, { module: Module | null; kind: LockKind }>();
    private pending: Pending[] = [];
    program: ProgramInfoMessage | null = null;
    /** 待ちが増えた・減ったとき (データ取得中の札) */
    onReceiving: (receiving: boolean) => void = () => {};
    private receiving = false;

    /** 届いたものを受ける。起きたことを返す (文書に伝えるのはエンジン) */
    feed(message: ResponseMessage): ResourceEvent[] {
        switch (message.type) {
            case 'pmt': {
                const previous = this.pmt;
                this.pmt = new Map(
                    message.components
                        .filter((c) => c.streamType === STREAM_CAROUSEL)
                        .map((c) => [c.componentId, c]),
                );
                this.pmtSeen = true;
                // PMT から消えた部品のモジュールは捨てる (番組が替わって部品が減ると、ライブでは
                // 前の番組のモジュールを持ち続けることになる)。押さえたものは押さえた側が持つ
                for (const [k, module] of this.cache) {
                    if (this.pmt.has(module.component)) continue;
                    this.cache.delete(k);
                    this.release(module);
                }
                // PMT に無い部品を待っても来ない
                this.settle((p) => (this.pmt.has(p.component) ? undefined : null));
                return [{ type: 'pmt', components: this.pmt, previous }];
            }
            case 'moduleListUpdated': {
                const previous = this.dii.get(message.componentId) ?? null;
                const dii: Dii = {
                    dataEventId: message.dataEventId,
                    modules: new Map(message.modules.map((m) => [m.id, m])),
                    returnToEntry: message.returnToEntryFlag ?? false,
                };
                this.dii.set(message.componentId, dii);
                for (const [k, module] of this.cache) {
                    if (module.component !== message.componentId) continue;
                    const entry = dii.modules.get(module.id);
                    // 版が上がった・消えた・データイベントが変わったものは捨てる
                    if (
                        entry === undefined ||
                        entry.version !== module.version ||
                        module.dataEventId !== dii.dataEventId
                    ) {
                        this.cache.delete(k);
                        this.release(module);
                    }
                }
                // DII に無いモジュールを待っても来ない
                this.settle((p) =>
                    p.component === message.componentId && !dii.modules.has(p.module) ? null : undefined,
                );
                return [{ type: 'dii', component: message.componentId, dii, previous }];
            }
            case 'moduleDownloaded': {
                const dii = this.dii.get(message.componentId);
                if (dii !== undefined && dii.dataEventId !== message.dataEventId) return [];
                const k = key(message.componentId, message.moduleId);
                const old = this.cache.get(k);
                if (
                    old !== undefined &&
                    old.version === message.version &&
                    old.dataEventId === message.dataEventId
                ) {
                    return [];
                }
                const module: Module = {
                    component: message.componentId,
                    id: message.moduleId,
                    version: message.version,
                    dataEventId: message.dataEventId,
                    files: new Map(
                        message.files.map((file) => [
                            file.contentLocation?.toLowerCase() ?? '',
                            {
                                name: file.contentLocation?.toLowerCase() ?? '',
                                type: file.contentType,
                                data: fromBase64(file.dataBase64),
                                urls: new Map(),
                            },
                        ]),
                    ),
                };
                this.cache.set(k, module);
                if (old !== undefined) this.release(old);
                this.settle((p) =>
                    p.component === module.component && p.module === module.id ? module : undefined,
                );
                return [{ type: 'module', component: module.component, module: module.id }];
            }
            case 'programInfo':
                this.program = message;
                return [{ type: 'program' }];
            case 'currentTime':
                return [{ type: 'time', at: message.timeUnixMillis }];
            case 'esEventUpdated':
                return [{ type: 'es', message }];
        }
        return [];
    }

    /**
     * 名前を解く。`base` は今の文書 (`/40/0000/startup.bml`)。部品・モジュールの番号で
     * 指せない名前 (http: など) は null
     */
    resolve(url: string, base: string | null): Ref | null {
        // 問い合わせ (`?tsid=…`)・断片 (`#…`) はファイルを引くのに使わない。resourceName に `?`・`#` は
        // 入らない (STD-B24 第二編 9.2.1.2)。文書からは getActiveDocument で読める (engine.ts の launch)
        let path = url.trim().replace(/[?#][\s\S]*$/, '');
        const dc =
            /^arib-dc:\/\/(-1|[0-9a-f]+)\.(-1|[0-9a-f]+)\.(-1|[0-9a-f]+)(?:;[0-9a-f]+)?(?:\.[0-9a-f]+)?(\/.*)?$/i.exec(
                path,
            );
        if (dc !== null) {
            const program = this.program;
            const same = (text: string, value: number | null | undefined): boolean => {
                const n = Number.parseInt(text, 16);
                return text === '-1' || value == null || n === value;
            };
            if (!same(dc[1]!, program?.originalNetworkId) || !same(dc[2]!, program?.transportStreamId))
                return null;
            if (!same(dc[3]!, program?.serviceId)) return null;
            path = dc[4] ?? '/';
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
            return null;
        }
        const current = base === null ? null : this.resolve(base, null);
        if (path === '~')
            return current === null ? null : { component: current.component, module: null, file: null };
        if (path.startsWith('~/')) {
            if (current === null) return null;
            path = `/${hex(current.component, 2)}/${path.slice(2)}`;
        }
        if (!path.startsWith('/')) {
            if (current === null || current.module === null) return null;
            path = `/${hex(current.component, 2)}/${hex(current.module, 4)}/${path}`;
        }
        const segments: string[] = [];
        for (const part of path.split('/')) {
            if (part === '' || part === '.') continue;
            if (part === '..') segments.pop();
            else segments.push(part);
        }
        if (segments.length === 0 || segments.length > 3) return null;
        const component = /^(-1|[0-9a-f]{1,2})$/i.test(segments[0]!)
            ? Number.parseInt(segments[0]!, 16)
            : Number.NaN;
        if (Number.isNaN(component)) return null;
        let module: number | null = null;
        if (segments[1] !== undefined) {
            if (!/^[0-9a-f]{1,4}$/i.test(segments[1])) return null;
            module = Number.parseInt(segments[1], 16);
        }
        let file: string | null = null;
        if (segments[2] !== undefined) {
            try {
                file = decodeURIComponent(segments[2]).toLowerCase();
            } catch {
                file = segments[2].toLowerCase();
            }
        }
        return { component, module, file };
    }

    /** 押さえたもの・届いているものから、今すぐ出せるファイル */
    file(ref: Ref): CarouselFile | null {
        if (ref.module === null) return null;
        const k = key(ref.component, ref.module);
        const module = this.locks.get(k)?.module ?? this.cache.get(k);
        return module?.files.get(ref.file ?? '') ?? null;
    }

    /** 今の版がもう届いているか */
    has(component: number, module: number): boolean {
        return (
            this.locks.get(key(component, module))?.module != null || this.cache.has(key(component, module))
        );
    }

    /** 届くのを待ってファイルを出す。来ないと決まれば null */
    async fetch(ref: Ref): Promise<CarouselFile | null> {
        const now = this.file(ref);
        if (now !== null || ref.module === null) return now;
        const module = await this.wait(ref.component, ref.module, null);
        return module?.files.get(ref.file ?? '') ?? null;
    }

    /** モジュールが届くのを待つ。来ないと決まれば null */
    private wait(component: number, module: number, kind: LockKind | null): Promise<Module | null> {
        const now = this.cache.get(key(component, module));
        if (now !== undefined) return Promise.resolve(now);
        if (this.pmtSeen && !this.pmt.has(component)) return Promise.resolve(null);
        const dii = this.dii.get(component);
        if (dii !== undefined && !dii.modules.has(module)) return Promise.resolve(null);
        return new Promise((resolve) => {
            this.pending.push({ component, module, resolve, kind });
            this.updateReceiving();
        });
    }

    /** 待っているものを決める。`decide` が undefined を返したものは待ち続ける */
    private settle(decide: (pending: Pending) => Module | null | undefined): void {
        const rest: Pending[] = [];
        const done: [Pending, Module | null][] = [];
        for (const p of this.pending) {
            const result = decide(p);
            if (result === undefined) rest.push(p);
            else done.push([p, result]);
        }
        this.pending = rest;
        for (const [p, module] of done) p.resolve(module);
        this.updateReceiving();
    }

    private updateReceiving(): void {
        let receiving = this.pending.length > 0;
        // 入口の部品が無い・空のカルーセルなら、データ放送の番組ではない
        if (this.pmtSeen && !this.pmt.has(STARTUP_COMPONENT)) receiving = false;
        if (this.dii.get(STARTUP_COMPONENT)?.modules.size === 0) receiving = false;
        if (receiving === this.receiving) return;
        this.receiving = receiving;
        this.onReceiving(receiving);
    }

    /**
     * モジュールを押さえる。押さえられたら (届くのを待ってから) `done(0)`、
     * DII に無ければ -2、待つ間にデータイベントが変われば -1。
     *
     * @returns 受け付けたら 1、PMT に無ければ -1 (Ex は -3)、DII に無ければ -1 (lock のみ)、
     *   別の種類で押さえてあれば NaN
     */
    lock(component: number, module: number, kind: LockKind, done: (status: number) => void): number {
        const k = key(component, module);
        const held = this.locks.get(k);
        if (held !== undefined && held.kind !== kind) return Number.NaN;
        if (this.pmtSeen && !this.pmt.has(component)) return kind === 'lockEx' ? -3 : -1;
        if (held !== undefined) {
            // 同じ種類で押さえ直す。待っている途中ならその待ちに任せる (知らせは 1 回)
            if (held.module === null) return 1;
            // 届いている今の版で押さえ直し、前の版を返す (web-bml の lockCachedModule と同じ)
            const now = this.cache.get(k);
            if (now !== undefined && now !== held.module) {
                const old = held.module;
                held.module = now;
                this.release(old);
            }
            queueMicrotask(() => done(0));
            return 1;
        }
        const dii = this.dii.get(component);
        if (dii !== undefined && !dii.modules.has(module)) {
            if (kind === 'lock') return -1;
            queueMicrotask(() => done(-2));
            return 1;
        }
        const event = dii?.dataEventId;
        this.locks.set(k, { module: null, kind });
        void this.wait(component, module, kind).then((found) => {
            const entry = this.locks.get(k);
            // 待つ間に外された
            if (entry === undefined || entry.kind !== kind) return;
            if (found === null) {
                this.locks.delete(k);
                done(-2);
                return;
            }
            const now = this.dii.get(component)?.dataEventId;
            if (kind === 'lockEx' && event !== undefined && now !== undefined && now !== event) {
                this.locks.delete(k);
                done(-1);
                return;
            }
            entry.module = found;
            done(0);
        });
        return 1;
    }

    /** 外す。`kind` を省くと両方 */
    unlock(component: number, module: number, kind?: LockKind): boolean {
        const k = key(component, module);
        const held = this.locks.get(k);
        if (held === undefined || (kind !== undefined && held.kind !== kind)) return false;
        this.locks.delete(k);
        this.pending = this.pending.filter(
            (p) => !(p.component === component && p.module === module && p.kind !== null),
        );
        if (held.module !== null) this.release(held.module);
        this.updateReceiving();
        return true;
    }

    /** 全部外す (`kind` を省くと両方) */
    unlockAll(kind?: LockKind): void {
        for (const [k, held] of [...this.locks]) {
            if (kind !== undefined && held.kind !== kind) continue;
            const [component, module] = k.split('/').map(Number);
            this.unlock(component!, module!, held.kind);
        }
    }

    /** 押さえているもの [モジュール, Ex か, まだ届いていないか] */
    locked(): [string, boolean, boolean][] {
        return [...this.locks].map(([k, held]) => {
            const [component, module] = k.split('/').map(Number);
            return [
                refToPath({ component: component!, module: module!, file: null }),
                held.kind === 'lockEx',
                held.module === null,
            ];
        });
    }

    /** モジュールを捨てる。押さえていなければ作った URL を返す */
    private release(module: Module): void {
        const k = key(module.component, module.id);
        if (this.cache.get(k) === module || this.locks.get(k)?.module === module) return;
        for (const file of module.files.values()) {
            for (const made of file.urls.values()) {
                URL.revokeObjectURL(made.url);
                for (const frame of made.animation?.frames ?? []) URL.revokeObjectURL(frame.url);
            }
            file.urls.clear();
        }
    }

    destroy(): void {
        for (const p of this.pending) p.resolve(null);
        this.pending = [];
        const modules = new Set([
            ...this.cache.values(),
            ...[...this.locks.values()].flatMap((l) => (l.module === null ? [] : [l.module])),
        ]);
        this.cache.clear();
        this.locks.clear();
        for (const module of modules) this.release(module);
    }
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}
