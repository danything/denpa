/**
 * スクリプトの値。**ブラウザの JS の値をそのまま使うが、放送の意味に合わせる。**
 *
 * - 数は整数だけ (STD-B24 付属2 の Number)。割り算は 0 の向きに切り捨て、0 で割ると NaN。
 *   足し算・掛け算は丸めない (`Date.getTime()` が 32 ビットに収まらないため)。ビット演算は
 *   いつもの 32 ビット
 * - 文字列の大小は EUC-JP の符号の順 ([euc.ts](euc.ts))
 * - 物 (`JSObject`) は Map で持つ。DOM や `browser` は `getOwn`/`put` を上書きした子 (host)
 */

import { compareEuc } from './euc';

export type Value = undefined | null | boolean | number | string | JSObject;

/** 無いことの印 (`undefined` が入っているのと区別する) */
export const ABSENT: unique symbol = Symbol('absent');
export type Lookup = Value | typeof ABSENT;

/** スクリプトの実行時の誤り。**その実行だけを止める** (文書は残る) */
export class ScriptError extends Error {}

export class JSObject {
    readonly props = new Map<string, Value>();
    /**
     * 組み込みの物か。**for-in で列挙しない** (Array.prototype の join などが
     * 放送の for-in に混ざらないように)
     */
    builtin = false;
    /** for-in で列挙しない自分の名前 (prototype の constructor など) */
    hidden: Set<string> | null = null;

    constructor(
        public proto: JSObject | null,
        public cls = 'Object',
    ) {}

    getOwn(key: string): Lookup {
        const value = this.props.get(key);
        return value === undefined && !this.props.has(key) ? ABSENT : value;
    }

    get(key: string): Value {
        for (let o: JSObject | null = this; o !== null; o = o.proto) {
            const value = o.getOwn(key);
            if (value !== ABSENT) return value;
        }
        return undefined;
    }

    has(key: string): boolean {
        for (let o: JSObject | null = this; o !== null; o = o.proto)
            if (o.getOwn(key) !== ABSENT) return true;
        return false;
    }

    put(key: string, value: Value): void {
        this.props.set(key, value);
    }

    delete(key: string): boolean {
        return this.props.delete(key);
    }

    /** for-in で列挙する自分の名前 */
    ownKeys(): string[] {
        if (this.builtin) return [];
        const keys = [...this.props.keys()];
        return this.hidden === null ? keys : keys.filter((key) => !this.hidden!.has(key));
    }
}

/** 配列の要素数の上限。暴走したスクリプトでページを潰さない */
export const MAX_ARRAY = 65536;
/** 文字列の長さの上限 */
export const MAX_STRING = 1 << 20;

function arrayIndex(key: string): number {
    if (key.length === 0 || key.length > 10) return -1;
    const n = Number(key);
    return Number.isInteger(n) && n >= 0 && String(n) === key ? n : -1;
}

export class JSArray extends JSObject {
    constructor(
        proto: JSObject | null,
        public items: Value[] = [],
    ) {
        super(proto, 'Array');
    }

    override getOwn(key: string): Lookup {
        if (key === 'length') return this.items.length;
        const index = arrayIndex(key);
        // delete で空けた所は「無い」(値が undefined の要素とは違う)
        if (index >= 0) return index in this.items ? this.items[index] : ABSENT;
        return super.getOwn(key);
    }

    override put(key: string, value: Value): void {
        if (key === 'length') {
            this.setLength(toNumber(value));
            return;
        }
        const index = arrayIndex(key);
        if (index < 0) {
            super.put(key, value);
            return;
        }
        if (index >= MAX_ARRAY) throw new ScriptError(`配列が大きすぎます (${index})`);
        // 間は空き (`new Array(3)` や `a[5] = 1` と同じ。for-in に出ない)
        if (this.items.length < index) this.items.length = index;
        this.items[index] = value;
    }

    setLength(length: number): void {
        if (!Number.isInteger(length) || length < 0 || length > MAX_ARRAY) {
            throw new ScriptError(`配列の長さが不正です (${length})`);
        }
        this.items.length = length;
    }

    override delete(key: string): boolean {
        const index = arrayIndex(key);
        if (index >= 0 && index < this.items.length) {
            delete this.items[index];
            return true;
        }
        return super.delete(key);
    }

    override ownKeys(): string[] {
        const keys: string[] = [];
        for (let i = 0; i < this.items.length; i++) if (i in this.items) keys.push(String(i));
        return [...keys, ...super.ownKeys()];
    }
}

/** 日付。時刻は UNIX ミリ秒 (NaN は不正な日付) */
export class JSDate extends JSObject {
    constructor(
        proto: JSObject | null,
        public time: number,
    ) {
        super(proto, 'Date');
    }
}

/** 呼べる物。中身はスクリプトの関数 (`code`) か、組み込み (`native`) */
export class JSFunction extends JSObject {
    constructor(
        proto: JSObject | null,
        public readonly name: string,
        public readonly call: FunctionBody,
        /** `new` されたときにできる物の元 (`prototype` を引くための入れ物の元) */
        private readonly objectProto: JSObject | null,
    ) {
        super(proto, 'Function');
    }

    override getOwn(key: string): Lookup {
        const own = super.getOwn(key);
        // prototype は要ったときに作る (組み込みの多くは使われない)
        if (own === ABSENT && key === 'prototype' && this.call.kind === 'script') {
            const prototype = new JSObject(this.objectProto);
            prototype.put('constructor', this);
            prototype.hidden = new Set(['constructor']);
            super.put('prototype', prototype);
            return prototype;
        }
        return own;
    }
}

/** 組み込みの関数が返せるもの。`Suspend` は「待って再開」、`Abort` は「実行を打ち切る」 */
export type NativeResult = Value | Suspend | Abort;

export class Suspend {
    constructor(public readonly promise: Promise<Value>) {}
}

/** launchDocument など。**呼んだら戻らない** (今の実行を捨てて、文書を替える) */
export class Abort {}
export const ABORT = new Abort();

export type NativeImpl = (thisValue: Value, args: Value[]) => NativeResult;

export type FunctionBody =
    | { kind: 'native'; impl: NativeImpl; construct?: (args: Value[]) => Value }
    | { kind: 'script'; code: unknown; env: unknown };

export function isObject(value: Value): value is JSObject {
    return typeof value === 'object' && value !== null;
}

export function toBoolean(value: Value): boolean {
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'string') return value.length > 0;
    if (isObject(value)) return true;
    return value === true;
}

/** 整数に寄せる。小数は 0 の向きに切り捨て、無限は NaN (放送の Number に無限は無い) */
export function toInteger(n: number): number {
    if (!Number.isFinite(n)) return Number.NaN;
    return Math.trunc(n) + 0;
}

export function toNumber(value: Value): number {
    switch (typeof value) {
        case 'number':
            return value;
        case 'boolean':
            return value ? 1 : 0;
        case 'undefined':
            return Number.NaN;
        case 'string': {
            const text = value.trim();
            if (text === '') return 0;
            return toInteger(Number(text));
        }
    }
    if (value === null) return 0;
    if (value instanceof JSDate) return value.time;
    return toNumber(toPrimitiveString(value));
}

/** 配列をつなぐ。**長さの上限を、作りながら見る** (作ってから見ると先に巨大な文字列ができる) */
export function joinItems(items: readonly Value[], separator: string): string {
    const parts: string[] = [];
    let size = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const text = item == null ? '' : toStr(item);
        size += text.length + (i > 0 ? separator.length : 0);
        if (size > MAX_STRING) throw new ScriptError('文字列が長すぎます');
        parts.push(text);
    }
    return parts.join(separator);
}

function toPrimitiveString(value: JSObject): string {
    if (value instanceof JSArray) return joinItems(value.items, ',');
    if (value instanceof JSDate) return formatDate(value.time);
    if (value instanceof JSFunction) return `function ${value.name}() { [native code] }`;
    const primitive = value.props.get('__primitive__');
    if (primitive !== undefined && !isObject(primitive)) return toStr(primitive);
    return value.cls === 'hostobject' ? '[object hostobject]' : `[object ${value.cls}]`;
}

export function toStr(value: Value): string {
    switch (typeof value) {
        case 'string':
            return value;
        case 'number':
            return Number.isNaN(value) ? 'NaN' : String(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'undefined':
            return 'undefined';
    }
    if (value === null) return 'null';
    return toPrimitiveString(value);
}

/** 日本の時刻 (UTC+9) での年月日など。放送は日本の時刻で書かれている */
export const JST = 9 * 3600 * 1000;

function pad(n: number, size: number): string {
    return String(Math.abs(n)).padStart(size, '0');
}

/** Date の文字列 (`YYYY-MM-DDThh:mm:ss`。web-bml と同じ形) */
export function formatDate(time: number, utc = false): string {
    if (Number.isNaN(time)) return 'Invalid Date';
    const d = new Date(utc ? time : time + JST);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
}

/** `==` (ES1 の抽象的な等しさ) */
export function looseEquals(a: Value, b: Value): boolean {
    if (a === b) return !(typeof a === 'number' && Number.isNaN(a));
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (typeof a === 'number' && typeof b === 'string') return a === toNumber(b);
    if (typeof a === 'string' && typeof b === 'number') return toNumber(a) === b;
    if (typeof a === 'boolean') return looseEquals(a ? 1 : 0, b);
    if (typeof b === 'boolean') return looseEquals(a, b ? 1 : 0);
    if (isObject(a) && !isObject(b)) return looseEquals(typeof b === 'number' ? toNumber(a) : toStr(a), b);
    if (isObject(b) && !isObject(a)) return looseEquals(a, typeof a === 'number' ? toNumber(b) : toStr(b));
    return false;
}

export function strictEquals(a: Value, b: Value): boolean {
    return a === b && !(typeof a === 'number' && Number.isNaN(a));
}

/** `<` の結果。比べられない (NaN) ときは undefined */
export function lessThan(a: Value, b: Value): boolean | undefined {
    const x = isObject(a) && !(a instanceof JSDate) ? toStr(a) : a;
    const y = isObject(b) && !(b instanceof JSDate) ? toStr(b) : b;
    if (typeof x === 'string' && typeof y === 'string') return compareEuc(x, y) < 0;
    const m = toNumber(x);
    const n = toNumber(y);
    if (Number.isNaN(m) || Number.isNaN(n)) return undefined;
    return m < n;
}

export function add(a: Value, b: Value): Value {
    const x = isObject(a) && !(a instanceof JSDate) ? toStr(a) : a instanceof JSDate ? toStr(a) : a;
    const y = isObject(b) && !(b instanceof JSDate) ? toStr(b) : b instanceof JSDate ? toStr(b) : b;
    if (typeof x === 'string' || typeof y === 'string') {
        const text = toStr(x) + toStr(y);
        if (text.length > MAX_STRING) throw new ScriptError('文字列が長すぎます');
        return text;
    }
    return toNumber(x) + toNumber(y);
}

export function divide(a: number, b: number): number {
    if (b === 0 || Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
    return toInteger(a / b);
}

export function modulo(a: number, b: number): number {
    if (b === 0 || Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
    return (a % b) + 0;
}

/** `typeof`。DOM や browser のような外の物は "hostobject" (web-bml と同じ) */
export function typeOf(value: Value): string {
    if (value === null) return 'object';
    if (value instanceof JSFunction) return 'function';
    if (isObject(value)) return value.cls === 'hostobject' ? 'hostobject' : 'object';
    return typeof value;
}
