/**
 * 組み込みの物 (Object・Array・String・Number・Boolean・Date・parseInt・isNaN)。
 * STD-B24 第二編 付属2 の ECMAScript で使えるもの。
 *
 * - 文字の符号は EUC-JP (`charCodeAt` / `fromCharCode`。[euc.ts](euc.ts))
 * - Date は**日本の時刻**で年月日を返す (端末の時間帯に引きずられない)。引数無しの
 *   `new Date()` は放送の時刻 (`now`)
 * - Math・eval・escape・小数は無い (web-bml も外している)
 */

import { compareEuc, eucCode, fromEucCode } from './euc';
import {
    formatDate,
    isObject,
    JSArray,
    JSDate,
    JSFunction,
    JSObject,
    JST,
    joinItems,
    MAX_ARRAY,
    MAX_STRING,
    type NativeImpl,
    ScriptError,
    toBoolean,
    toInteger,
    toNumber,
    toStr,
    type Value,
} from './values';
import type { Realm } from './vm';

export interface RealmOptions {
    /** 放送の時刻 (UNIX ミリ秒)。`new Date()` が使う */
    now: () => number;
}

/** Number.MAX_VALUE / MIN_VALUE (整数の Number。web-bml と同じ) */
const MAX_VALUE = 2147483647;
const MIN_VALUE = 1;

export function createRealm(options: RealmOptions): Realm {
    const objectProto = new JSObject(null);
    const functionProto = new JSObject(objectProto, 'Function');
    const realm: Realm = {
        global: new JSObject(objectProto, 'global'),
        objectProto,
        functionProto,
        arrayProto: new JSObject(objectProto, 'Array'),
        stringProto: new JSObject(objectProto, 'String'),
        numberProto: new JSObject(objectProto, 'Number'),
        booleanProto: new JSObject(objectProto, 'Boolean'),
    };
    const dateProto = new JSObject(objectProto, 'Date');
    for (const proto of [objectProto, functionProto, realm.arrayProto, realm.stringProto, dateProto]) {
        proto.builtin = true;
    }
    realm.numberProto.builtin = true;
    realm.booleanProto.builtin = true;

    const native = (name: string, impl: NativeImpl, construct?: (args: Value[]) => Value): JSFunction => {
        const fn = new JSFunction(
            functionProto,
            name,
            construct === undefined ? { kind: 'native', impl } : { kind: 'native', impl, construct },
            objectProto,
        );
        fn.builtin = true;
        return fn;
    };
    const method = (target: JSObject, name: string, impl: NativeImpl): void => {
        target.put(name, native(name, impl));
    };
    const defineClass = (name: string, fn: JSFunction, proto: JSObject): void => {
        fn.put('prototype', proto);
        proto.put('constructor', fn);
        realm.global.put(name, fn);
    };
    const array = (items: Value[]): JSArray => {
        if (items.length > MAX_ARRAY) throw new ScriptError('配列が大きすぎます');
        return new JSArray(realm.arrayProto, items);
    };

    // Object
    const makeObject = (args: Value[]): Value => (isObject(args[0]) ? args[0] : new JSObject(objectProto));
    defineClass(
        'Object',
        native('Object', (_, args) => makeObject(args), makeObject),
        objectProto,
    );
    method(objectProto, 'toString', (self) => `[object ${isObject(self) ? self.cls : typeof self}]`);
    method(objectProto, 'valueOf', (self) => self);
    method(objectProto, 'hasOwnProperty', (self, args) =>
        isObject(self) ? typeof self.getOwn(toStr(args[0])) !== 'symbol' : false,
    );
    method(functionProto, 'toString', (self) => toStr(self));

    // Array
    const makeArray = (args: Value[]): Value => {
        if (args.length === 1 && typeof args[0] === 'number') {
            const made = array([]);
            made.setLength(args[0]);
            return made;
        }
        return array([...args]);
    };
    defineClass(
        'Array',
        native('Array', (_, args) => makeArray(args), makeArray),
        realm.arrayProto,
    );
    const items = (self: Value): Value[] => {
        if (!(self instanceof JSArray)) throw new ScriptError('配列ではありません');
        return self.items;
    };
    const join = (self: Value, separator: Value): string =>
        joinItems(items(self), separator === undefined ? ',' : toStr(separator));
    method(realm.arrayProto, 'join', (self, args) => join(self, args[0]));
    method(realm.arrayProto, 'toString', (self) => join(self, undefined));
    method(realm.arrayProto, 'reverse', (self) => {
        items(self).reverse();
        return self;
    });
    // ES3 15.4.4.11。undefined は後ろに回して比べない。既定の比べ方は文字列にしてから (EUC-JP の順)。
    // 比べる関数の戻り値は数にし (NaN は 0)、投げた誤りはそのまま伝える。命令の数は実行の上限に数える
    method(realm.arrayProto, 'sort', (self, args) => {
        const list = items(self);
        const compare = args[0];
        let order: (a: Value, b: Value) => number;
        if (compare === undefined) {
            order = (a, b) => compareEuc(toStr(a), toStr(b));
        } else {
            if (!(compare instanceof JSFunction))
                throw new ScriptError('sort の比べる関数が関数ではありません');
            const invoke = realm.invoke;
            if (invoke === undefined) throw new ScriptError('sort の比べる関数を呼べません');
            order = (a, b) => {
                const n = toNumber(invoke(compare, undefined, [a, b]));
                return Number.isNaN(n) ? 0 : n;
            };
        }
        const defined = list.filter((item) => item !== undefined);
        // 比べる関数が配列を書き換えても、並べ終えた結果で置き換える
        defined.sort(order);
        for (let i = 0; i < list.length; i++) list[i] = defined[i];
        return self;
    });
    method(realm.arrayProto, 'push', (self, args) => {
        const list = items(self);
        for (const arg of args) (self as JSArray).put(String(list.length), arg);
        return list.length;
    });
    method(realm.arrayProto, 'pop', (self) => items(self).pop());
    method(realm.arrayProto, 'shift', (self) => items(self).shift());
    method(realm.arrayProto, 'unshift', (self, args) => {
        const list = items(self);
        (self as JSArray).setLength(list.length + args.length);
        list.splice(list.length - args.length, args.length);
        list.unshift(...args);
        return list.length;
    });
    method(realm.arrayProto, 'concat', (self, args) => {
        const out = [...items(self)];
        for (const arg of args) {
            if (arg instanceof JSArray) out.push(...arg.items);
            else out.push(arg);
        }
        return array(out);
    });
    const range = (length: number, value: Value, fallback: number): number => {
        const n = value === undefined ? fallback : toNumber(value);
        if (Number.isNaN(n)) return 0;
        return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
    };
    method(realm.arrayProto, 'slice', (self, args) => {
        const list = items(self);
        return array(list.slice(range(list.length, args[0], 0), range(list.length, args[1], list.length)));
    });
    method(realm.arrayProto, 'splice', (self, args) => {
        const list = items(self);
        const start = range(list.length, args[0], 0);
        const count = args.length < 2 ? list.length - start : Math.max(0, toNumber(args[1]) || 0);
        if (list.length - count + args.length - 2 > MAX_ARRAY) throw new ScriptError('配列が大きすぎます');
        return array(list.splice(start, count, ...args.slice(2)));
    });
    method(realm.arrayProto, 'indexOf', (self, args) => items(self).indexOf(args[0]));

    // String
    const makeString = (args: Value[]): Value => (args.length === 0 ? '' : toStr(args[0]));
    const string = native(
        'String',
        (_, args) => makeString(args),
        (args) => {
            const wrapper = new JSObject(realm.stringProto, 'String');
            wrapper.put('__primitive__', makeString(args));
            return wrapper;
        },
    );
    defineClass('String', string, realm.stringProto);
    string.put(
        'fromCharCode',
        native('fromCharCode', (_, args) =>
            args.map((code) => fromEucCode(toNumber(code) & 0xffff)).join(''),
        ),
    );
    const text = (self: Value): string => {
        if (isObject(self) && self.cls === 'String') return toStr(self.get('__primitive__'));
        if (self == null) throw new ScriptError('文字列ではありません');
        return toStr(self);
    };
    const index = (value: Value, fallback = 0): number => {
        const n = value === undefined ? fallback : toNumber(value);
        return Number.isNaN(n) ? 0 : n;
    };
    method(realm.stringProto, 'toString', (self) => text(self));
    method(realm.stringProto, 'valueOf', (self) => text(self));
    method(realm.stringProto, 'charAt', (self, args) => text(self).charAt(index(args[0])));
    method(realm.stringProto, 'charCodeAt', (self, args) => {
        const s = text(self);
        const at = index(args[0]);
        return at < 0 || at >= s.length ? Number.NaN : eucCode(s.charCodeAt(at));
    });
    method(realm.stringProto, 'indexOf', (self, args) => text(self).indexOf(toStr(args[0]), index(args[1])));
    method(realm.stringProto, 'lastIndexOf', (self, args) => {
        const s = text(self);
        return s.lastIndexOf(toStr(args[0]), args[1] === undefined ? s.length : index(args[1]));
    });
    // 正規表現は無いので、search は文字列を探すだけ
    method(realm.stringProto, 'search', (self, args) => text(self).indexOf(toStr(args[0])));
    method(realm.stringProto, 'substring', (self, args) => {
        const s = text(self);
        const clamp = (n: number): number => Math.min(Math.max(n, 0), s.length);
        return s.substring(clamp(index(args[0])), clamp(index(args[1], s.length)));
    });
    method(realm.stringProto, 'substr', (self, args) => {
        const s = text(self);
        const start = range(s.length, args[0], 0);
        return s.substr(start, args[1] === undefined ? s.length - start : Math.max(0, index(args[1])));
    });
    method(realm.stringProto, 'slice', (self, args) => {
        const s = text(self);
        return s.slice(range(s.length, args[0], 0), range(s.length, args[1], s.length));
    });
    method(realm.stringProto, 'split', (self, args) => {
        const s = text(self);
        if (args[0] === undefined) return array([s]);
        const parts = s.split(toStr(args[0]));
        return array(args[1] === undefined ? parts : parts.slice(0, Math.max(0, index(args[1]))));
    });
    method(realm.stringProto, 'concat', (self, args) => {
        let out = text(self);
        for (const arg of args) {
            out += toStr(arg);
            if (out.length > MAX_STRING) throw new ScriptError('文字列が長すぎます');
        }
        return out;
    });
    method(realm.stringProto, 'toLowerCase', (self) => text(self).replace(/[A-Z]/g, (c) => c.toLowerCase()));
    method(realm.stringProto, 'toUpperCase', (self) => text(self).replace(/[a-z]/g, (c) => c.toUpperCase()));

    // Number・Boolean
    const number = native(
        'Number',
        (_, args) => (args.length === 0 ? 0 : toNumber(args[0])),
        (args) => {
            const wrapper = new JSObject(realm.numberProto, 'Number');
            wrapper.put('__primitive__', args.length === 0 ? 0 : toNumber(args[0]));
            return wrapper;
        },
    );
    defineClass('Number', number, realm.numberProto);
    number.put('MAX_VALUE', MAX_VALUE);
    number.put('MIN_VALUE', MIN_VALUE);
    number.put('NaN', Number.NaN);
    const numeric = (self: Value): number => toNumber(isObject(self) ? self.get('__primitive__') : self);
    method(realm.numberProto, 'toString', (self, args) => {
        const n = numeric(self);
        const radix = args[0] === undefined ? 10 : toNumber(args[0]);
        if (Number.isNaN(n)) return 'NaN';
        return radix >= 2 && radix <= 36 ? n.toString(radix) : String(n);
    });
    method(realm.numberProto, 'valueOf', (self) => numeric(self));
    const boolean = native(
        'Boolean',
        (_, args) => toBoolean(args[0]),
        (args) => {
            const wrapper = new JSObject(realm.booleanProto, 'Boolean');
            wrapper.put('__primitive__', toBoolean(args[0]));
            return wrapper;
        },
    );
    defineClass('Boolean', boolean, realm.booleanProto);
    method(realm.booleanProto, 'toString', (self) =>
        toStr(isObject(self) ? self.get('__primitive__') : self),
    );

    // Date
    const dateValue = (self: Value): JSDate => {
        if (!(self instanceof JSDate)) throw new ScriptError('Date ではありません');
        return self;
    };
    const makeDate = (args: Value[]): Value => {
        let time: number;
        if (args.length === 0) {
            time = options.now();
        } else if (args.length === 1) {
            const n = typeof args[0] === 'string' ? parseDate(args[0]) : toNumber(args[0]);
            time = Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
        } else {
            const parts = args.slice(0, 7).map(toNumber);
            if (parts.some(Number.isNaN)) time = Number.NaN;
            else {
                const [y, m, d = 1, h = 0, mi = 0, s = 0, ms = 0] = parts as number[];
                time = Date.UTC(y!, m!, d, h, mi, s, ms) - JST;
            }
        }
        return new JSDate(dateProto, time);
    };
    defineClass(
        'Date',
        native('Date', () => formatDate(options.now()), makeDate),
        dateProto,
    );
    // 年月日は日本の時刻で読む (UTC の値を 9 時間ずらして UTC の読み方で読む)
    const getters: [string, (d: Date) => number][] = [
        ['FullYear', (d) => d.getUTCFullYear()],
        ['Month', (d) => d.getUTCMonth()],
        ['Date', (d) => d.getUTCDate()],
        ['Day', (d) => d.getUTCDay()],
        ['Hours', (d) => d.getUTCHours()],
        ['Minutes', (d) => d.getUTCMinutes()],
        ['Seconds', (d) => d.getUTCSeconds()],
        ['Milliseconds', (d) => d.getUTCMilliseconds()],
    ];
    for (const [name, read] of getters) {
        method(dateProto, `get${name}`, (self) => {
            const t = dateValue(self).time;
            return Number.isNaN(t) ? Number.NaN : read(new Date(t + JST));
        });
        method(dateProto, `getUTC${name}`, (self) => {
            const t = dateValue(self).time;
            return Number.isNaN(t) ? Number.NaN : read(new Date(t));
        });
    }
    method(dateProto, 'getYear', (self) => {
        const t = dateValue(self).time;
        return Number.isNaN(t) ? Number.NaN : new Date(t + JST).getUTCFullYear() - 1900;
    });
    method(dateProto, 'getTime', (self) => dateValue(self).time);
    method(dateProto, 'valueOf', (self) => dateValue(self).time);
    method(dateProto, 'getTimezoneOffset', () => -540);
    method(dateProto, 'setTime', (self, args) => {
        const date = dateValue(self);
        date.time = toInteger(toNumber(args[0]));
        return date.time;
    });
    const setters: [string, number][] = [
        ['Milliseconds', 1],
        ['Seconds', 2],
        ['Minutes', 3],
        ['Hours', 4],
        ['Date', 1],
        ['Month', 2],
        ['FullYear', 3],
    ];
    for (const [name, arity] of setters) {
        for (const utc of [false, true]) {
            method(dateProto, `set${utc ? 'UTC' : ''}${name}`, (self, args) => {
                const date = dateValue(self);
                const parts = args.slice(0, arity).map(toNumber);
                if (parts.length === 0 || parts.some(Number.isNaN)) {
                    date.time = Number.NaN;
                    return date.time;
                }
                const shift = utc ? 0 : JST;
                const d = new Date((Number.isNaN(date.time) ? 0 : date.time) + shift);
                const set = (d as unknown as Record<string, (...n: number[]) => number>)[`setUTC${name}`]!;
                set.apply(d, parts);
                date.time = d.getTime() - shift;
                return date.time;
            });
        }
    }
    method(dateProto, 'toString', (self) => formatDate(dateValue(self).time));
    method(dateProto, 'toLocaleString', (self) => formatDate(dateValue(self).time));
    method(dateProto, 'toUTCString', (self) => formatDate(dateValue(self).time, true));

    // 大域の関数
    realm.global.put('NaN', Number.NaN);
    realm.global.put('undefined', undefined);
    realm.global.put(
        'parseInt',
        native('parseInt', (_, args) => {
            const radix = args[1] === undefined ? 0 : toNumber(args[1]);
            const n = Number.parseInt(toStr(args[0]), Number.isNaN(radix) ? 0 : radix);
            // 整数だけの Number に収まらないもの (桁あふれ) は NaN
            return Number.isSafeInteger(n) ? n : Number.NaN;
        }),
    );
    realm.global.put(
        'isNaN',
        native('isNaN', (_, args) => Number.isNaN(toNumber(args[0]))),
    );
    return realm;
}

/**
 * 日付の文字列を日本の時刻で読む (`YYYY/MM/DD hh:mm:ss`・`YYYY-MM-DDThh:mm:ss` と、その頭の方だけ)。
 * 端末の時間帯で読む `Date.parse` には任せない。読めなければ NaN
 */
function parseDate(text: string): number {
    const match =
        /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?\s*$/.exec(text);
    if (match === null) return Number.NaN;
    const [, y, m, d, h = '0', mi = '0', s = '0'] = match;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)) - JST;
}
