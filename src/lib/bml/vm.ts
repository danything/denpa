/**
 * スクリプトを動かす。**ブラウザの JS (eval / Function) は使わない。**
 *
 * - 放送のコードをページの realm で動かさない (CSP で eval を禁じても動く)
 * - `browser.sleep` で**同期のまま止まれる**: 組み込みが `Suspend` を返すと、ここで手を
 *   放して約束を待ち、返ってきた値を積んで続きから動く
 * - `launchDocument` で今の実行を**打ち切れる** (`Abort`)
 * - 時間で区切る: `run(deadline)` は締め切りが来たら `yield` を返す。呼び手が次の
 *   隙間で `run` し直す (ページを固めない)
 * - 上限: 呼び出しの深さ・1 回の実行の命令の数 (終わらないループ)・配列と文字列の大きさ
 */

import { type Code, OP } from './compiler';
import {
    ABORT,
    Abort,
    add,
    divide,
    isObject,
    JSArray,
    JSFunction,
    JSObject,
    lessThan,
    looseEquals,
    modulo,
    ScriptError,
    Suspend,
    strictEquals,
    toBoolean,
    toNumber,
    toStr,
    typeOf,
    type Value,
} from './values';

/** 1 つの文書ぶんの大域と組み込みの元 */
export interface Realm {
    global: JSObject;
    objectProto: JSObject;
    functionProto: JSObject;
    arrayProto: JSObject;
    stringProto: JSObject;
    numberProto: JSObject;
    booleanProto: JSObject;
}

interface Env {
    vars: Value[];
    parent: Env | null;
}

interface Frame {
    code: Code;
    pc: number;
    env: Env | null;
    /** この呼び出しが始まったときの積み上げの高さ */
    base: number;
    thisValue: Value;
    /** `new` で呼ばれたときにできた物 */
    construct: JSObject | null;
}

export type RunResult =
    | { kind: 'done'; value: Value }
    | { kind: 'yield' }
    | { kind: 'suspend'; promise: Promise<Value> }
    | { kind: 'abort' }
    | { kind: 'error'; error: Error };

/** for-in の列挙。積み上げに置くために物の形をしている */
class Enumeration extends JSObject {
    at = 0;
    constructor(
        readonly object: JSObject | null,
        readonly keys: string[],
    ) {
        super(null, 'Enumeration');
    }
}

export interface VmLimits {
    /** 呼び出しの深さ (規格は 16 段。余裕を持たせる) */
    depth: number;
    /** 1 回の実行の命令の数 */
    steps: number;
}

const DEFAULT_LIMITS: VmLimits = { depth: 32, steps: 50_000_000 };

export class Vm {
    private stack: Value[] = [];
    private frames: Frame[] = [];
    private steps = 0;
    /** 組み込みの返事を待っているか (`resume` を受けるのはこのときだけ) */
    private waiting = false;
    private readonly limits: VmLimits;

    constructor(
        readonly realm: Realm,
        limits: Partial<VmLimits> = {},
    ) {
        this.limits = { ...DEFAULT_LIMITS, ...limits };
    }

    /** 動いている途中か (止まっている・待っているも含む) */
    get busy(): boolean {
        return this.frames.length > 0;
    }

    /** 途中のものを捨てる */
    reset(): void {
        this.stack = [];
        this.frames = [];
        this.steps = 0;
        this.waiting = false;
    }

    /** 始めてよいか。**動いている途中に重ねて始めない** (待たせる順番は呼び手が持つ) */
    private idle(): void {
        if (this.frames.length > 0) throw new Error('VM は動いている途中です');
    }

    makeFunction(code: Code, env: Env | null): JSFunction {
        return new JSFunction(
            this.realm.functionProto,
            code.name,
            { kind: 'script', code, env },
            this.realm.objectProto,
        );
    }

    /** 大域のコード (`<script>` 1 つ) を始める */
    startProgram(code: Code): void {
        this.idle();
        const global = this.realm.global;
        for (const name of code.globals) if (!global.has(name)) global.put(name, undefined);
        for (const [index, , name] of code.hoisted)
            global.put(name, this.makeFunction(code.funcs[index]!, null));
        this.steps = 0;
        this.frames.push({
            code,
            pc: 0,
            env: null,
            base: this.stack.length,
            thisValue: global,
            construct: null,
        });
    }

    /** 関数を呼び始める (イベントの受け手)。呼べないものなら誤り */
    startCall(fn: Value, args: Value[] = []): void {
        if (!(fn instanceof JSFunction) || fn.call.kind !== 'script') {
            throw new ScriptError(`${toStr(fn)} はスクリプトの関数ではありません`);
        }
        this.idle();
        this.steps = 0;
        this.stack.push(undefined, fn, ...args);
        this.call(args.length, false);
    }

    /** `Suspend` で待っていた値を受け取る。続きは `run` */
    resume(value: Value): void {
        if (!this.waiting) throw new Error('VM は返事を待っていません');
        this.waiting = false;
        this.stack.push(value);
    }

    /**
     * 締め切りまで動かす。
     *
     * @param deadline `performance.now()` の値
     */
    run(deadline: number): RunResult {
        if (this.waiting) throw new Error('VM は返事を待っています (先に resume)');
        try {
            return this.loop(deadline);
        } catch (error) {
            const where = this.frames.at(-1)?.code.name ?? '';
            this.reset();
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'error', error: new ScriptError(where === '' ? message : `${where}: ${message}`) };
        }
    }

    private property(base: Value, key: string): Value {
        if (isObject(base)) return base.get(key);
        if (typeof base === 'string') {
            if (key === 'length') return base.length;
            return this.realm.stringProto.get(key);
        }
        if (typeof base === 'number') return this.realm.numberProto.get(key);
        if (typeof base === 'boolean') return this.realm.booleanProto.get(key);
        throw new ScriptError(`${toStr(base)} の ${key} は読めません`);
    }

    private setProperty(base: Value, key: string, value: Value): void {
        if (isObject(base)) base.put(key, value);
        else if (base == null) throw new ScriptError(`${toStr(base)} の ${key} に書けません`);
    }

    /**
     * 呼ぶ。積み上げは [this, 関数, 引数…]。スクリプトの関数なら枠を積んで null、
     * 組み込みなら結果を積んで null、待つ・打ち切るならその印を返す
     */
    private call(argc: number, construct: boolean): Suspend | Abort | null {
        const args = this.stack.splice(this.stack.length - argc, argc);
        const fn = this.stack.pop();
        const thisValue = construct ? undefined : this.stack.pop();
        if (!(fn instanceof JSFunction)) throw new ScriptError(`${toStr(fn)} は関数ではありません`);
        const body = fn.call;
        if (body.kind === 'native') {
            let result: ReturnType<typeof body.impl>;
            if (construct) {
                if (body.construct === undefined) throw new ScriptError(`${fn.name} は new できません`);
                result = body.construct(args);
            } else {
                result = body.impl(thisValue, args);
            }
            if (result instanceof Suspend || result instanceof Abort) return result;
            this.stack.push(result);
            return null;
        }
        if (this.frames.length >= this.limits.depth) throw new ScriptError('呼び出しが深すぎます');
        const code = body.code as Code;
        const env: Env = {
            vars: new Array<Value>(code.slots).fill(undefined),
            parent: body.env as Env | null,
        };
        code.params.forEach((slot, i) => {
            env.vars[slot] = args[i];
        });
        if (code.argumentsSlot >= 0) env.vars[code.argumentsSlot] = new JSArray(this.realm.arrayProto, args);
        for (const [index, slot] of code.hoisted) env.vars[slot] = this.makeFunction(code.funcs[index]!, env);
        let made: JSObject | null = null;
        if (construct) {
            const prototype = fn.get('prototype');
            made = new JSObject(isObject(prototype) ? prototype : this.realm.objectProto);
        }
        this.frames.push({
            code,
            pc: 0,
            env,
            base: this.stack.length,
            thisValue: construct ? made : thisValue == null ? this.realm.global : thisValue,
            construct: made,
        });
        return null;
    }

    private loop(deadline: number): RunResult {
        const stack = this.stack;
        let frame = this.frames.at(-1);
        if (frame === undefined) return { kind: 'done', value: undefined };
        let ops = frame.code.ops;
        let consts = frame.code.consts;
        // 前に数えてからの命令の数。256 ごと・組み込みを呼んだすぐ後に、時計と上限を見る
        // (組み込みは 1 つで重いことがある。待つ (suspend) ときも数を持ち越す — 持ち越さないと、
        // すぐ返る待ちを挟むループは上限に届かない)
        let count = 0;
        let check = 256;
        for (;;) {
            if (++count >= check) {
                this.steps += count;
                count = 0;
                check = 256;
                if (this.steps > this.limits.steps) throw new ScriptError('スクリプトが終わりません');
                if (performance.now() >= deadline) return { kind: 'yield' };
            }
            const op = ops[frame.pc++]!;
            switch (op) {
                case OP.UNDEF:
                    stack.push(undefined);
                    break;
                case OP.NULL:
                    stack.push(null);
                    break;
                case OP.TRUE:
                    stack.push(true);
                    break;
                case OP.FALSE:
                    stack.push(false);
                    break;
                case OP.CONST:
                    stack.push(consts[ops[frame.pc++]!]);
                    break;
                case OP.THIS:
                    stack.push(frame.thisValue);
                    break;
                case OP.POP:
                    stack.pop();
                    break;
                case OP.DUP:
                    stack.push(stack[stack.length - 1]);
                    break;
                case OP.DUP2:
                    stack.push(stack[stack.length - 2], stack[stack.length - 1]);
                    break;
                case OP.SWAP: {
                    const top = stack.pop();
                    stack.splice(stack.length - 1, 0, top);
                    break;
                }
                case OP.ROT3: {
                    const top = stack.pop();
                    stack.splice(stack.length - 2, 0, top);
                    break;
                }
                case OP.ROT4: {
                    const top = stack.pop();
                    stack.splice(stack.length - 3, 0, top);
                    break;
                }
                case OP.LOAD:
                case OP.STORE: {
                    let depth = ops[frame.pc++]!;
                    const slot = ops[frame.pc++]!;
                    let env = frame.env!;
                    while (depth-- > 0) env = env.parent!;
                    if (op === OP.LOAD) stack.push(env.vars[slot]);
                    else env.vars[slot] = stack[stack.length - 1];
                    break;
                }
                case OP.LOAD_GLOBAL: {
                    const name = consts[ops[frame.pc++]!] as string;
                    const value = this.realm.global.getOwn(name);
                    if (typeof value === 'symbol') {
                        if (!this.realm.global.has(name))
                            throw new ScriptError(`${name} は定義されていません`);
                        stack.push(this.realm.global.get(name));
                    } else {
                        stack.push(value);
                    }
                    break;
                }
                case OP.STORE_GLOBAL:
                    this.realm.global.put(consts[ops[frame.pc++]!] as string, stack[stack.length - 1]);
                    break;
                case OP.TYPEOF_GLOBAL: {
                    const name = consts[ops[frame.pc++]!] as string;
                    stack.push(
                        this.realm.global.has(name) ? typeOf(this.realm.global.get(name)) : 'undefined',
                    );
                    break;
                }
                case OP.DELETE_GLOBAL:
                    stack.push(this.realm.global.delete(consts[ops[frame.pc++]!] as string));
                    break;
                case OP.GET: {
                    const base = stack.pop();
                    stack.push(this.property(base, consts[ops[frame.pc++]!] as string));
                    break;
                }
                case OP.SET: {
                    const value = stack.pop();
                    const base = stack.pop();
                    this.setProperty(base, consts[ops[frame.pc++]!] as string, value);
                    stack.push(value);
                    break;
                }
                case OP.GET_ELEM: {
                    const key = toStr(stack.pop());
                    const base = stack.pop();
                    if (typeof base === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
                        const at = Number(key);
                        stack.push(at < base.length ? base.charAt(at) : undefined);
                    } else {
                        stack.push(this.property(base, key));
                    }
                    break;
                }
                case OP.SET_ELEM: {
                    const value = stack.pop();
                    const key = toStr(stack.pop());
                    this.setProperty(stack.pop(), key, value);
                    stack.push(value);
                    break;
                }
                case OP.DELETE: {
                    const key = consts[ops[frame.pc++]!] as string;
                    const base = stack.pop();
                    stack.push(isObject(base) ? base.delete(key) : true);
                    break;
                }
                case OP.DELETE_ELEM: {
                    const key = toStr(stack.pop());
                    const base = stack.pop();
                    stack.push(isObject(base) ? base.delete(key) : true);
                    break;
                }
                case OP.CALL:
                case OP.NEW: {
                    const argc = ops[frame.pc++]!;
                    const before = this.frames.length;
                    const result = this.call(argc, op === OP.NEW);
                    if (result instanceof Suspend) {
                        this.steps += count;
                        this.waiting = true;
                        return { kind: 'suspend', promise: result.promise };
                    }
                    if (result === ABORT || result instanceof Abort) {
                        this.reset();
                        return { kind: 'abort' };
                    }
                    // 組み込みだった (枠が増えていない) なら、次の命令で時計を見る
                    if (this.frames.length === before) check = count + 1;
                    frame = this.frames.at(-1)!;
                    ops = frame.code.ops;
                    consts = frame.code.consts;
                    break;
                }
                case OP.RETURN: {
                    let value = stack.pop();
                    stack.length = frame.base;
                    this.frames.pop();
                    if (frame.construct !== null && !isObject(value)) value = frame.construct;
                    const caller = this.frames.at(-1);
                    if (caller === undefined) {
                        this.reset();
                        return { kind: 'done', value };
                    }
                    stack.push(value);
                    frame = caller;
                    ops = frame.code.ops;
                    consts = frame.code.consts;
                    break;
                }
                case OP.JUMP:
                    frame.pc = ops[frame.pc]!;
                    break;
                case OP.JUMP_FALSE:
                case OP.JUMP_TRUE: {
                    const to = ops[frame.pc++]!;
                    if (toBoolean(stack.pop()) === (op === OP.JUMP_TRUE)) frame.pc = to;
                    break;
                }
                case OP.AND:
                case OP.OR: {
                    const to = ops[frame.pc++]!;
                    if (toBoolean(stack[stack.length - 1]) === (op === OP.OR)) frame.pc = to;
                    else stack.pop();
                    break;
                }
                case OP.ADD: {
                    const b = stack.pop();
                    stack.push(add(stack.pop(), b));
                    break;
                }
                case OP.SUB:
                case OP.MUL:
                case OP.DIV:
                case OP.MOD:
                case OP.SHL:
                case OP.SHR:
                case OP.USHR:
                case OP.BAND:
                case OP.BOR:
                case OP.BXOR: {
                    const b = toNumber(stack.pop());
                    const a = toNumber(stack.pop());
                    stack.push(arithmetic(op, a, b));
                    break;
                }
                case OP.EQ:
                case OP.NE: {
                    const b = stack.pop();
                    stack.push(looseEquals(stack.pop(), b) === (op === OP.EQ));
                    break;
                }
                case OP.SEQ:
                case OP.SNE: {
                    const b = stack.pop();
                    stack.push(strictEquals(stack.pop(), b) === (op === OP.SEQ));
                    break;
                }
                case OP.LT:
                case OP.GT:
                case OP.LE:
                case OP.GE: {
                    const b = stack.pop();
                    const a = stack.pop();
                    let result: boolean | undefined;
                    if (op === OP.LT) result = lessThan(a, b);
                    else if (op === OP.GT) result = lessThan(b, a);
                    else if (op === OP.LE)
                        result = lessThan(b, a) === undefined ? undefined : !lessThan(b, a);
                    else result = lessThan(a, b) === undefined ? undefined : !lessThan(a, b);
                    stack.push(result === true);
                    break;
                }
                case OP.IN: {
                    const object = stack.pop();
                    const key = toStr(stack.pop());
                    if (!isObject(object)) throw new ScriptError('in の右が物ではありません');
                    stack.push(object.has(key));
                    break;
                }
                case OP.INSTANCEOF: {
                    const fn = stack.pop();
                    const value = stack.pop();
                    if (!(fn instanceof JSFunction))
                        throw new ScriptError('instanceof の右が関数ではありません');
                    const prototype = fn.get('prototype');
                    let found = false;
                    if (isObject(value)) {
                        for (let o = value.proto; o !== null; o = o.proto) if (o === prototype) found = true;
                    }
                    stack.push(found);
                    break;
                }
                case OP.NOT:
                    stack.push(!toBoolean(stack.pop()));
                    break;
                case OP.NEG:
                    stack.push(-toNumber(stack.pop()) + 0);
                    break;
                case OP.NUM:
                    stack.push(toNumber(stack.pop()));
                    break;
                case OP.BNOT:
                    stack.push(~toNumber(stack.pop()));
                    break;
                case OP.TYPEOF:
                    stack.push(typeOf(stack.pop()));
                    break;
                case OP.ARRAY: {
                    const n = ops[frame.pc++]!;
                    stack.push(new JSArray(this.realm.arrayProto, stack.splice(stack.length - n, n)));
                    break;
                }
                case OP.OBJECT: {
                    const keys = frame.code.shapes[ops[frame.pc++]!]!;
                    const values = stack.splice(stack.length - keys.length, keys.length);
                    const object = new JSObject(this.realm.objectProto);
                    for (let i = 0; i < keys.length; i++) object.put(keys[i]!, values[i]);
                    stack.push(object);
                    break;
                }
                case OP.FORIN: {
                    const object = stack.pop();
                    const keys: string[] = [];
                    if (isObject(object)) {
                        const seen = new Set<string>();
                        for (let o: JSObject | null = object; o !== null; o = o.proto) {
                            for (const key of o.ownKeys()) {
                                if (seen.has(key)) continue;
                                seen.add(key);
                                keys.push(key);
                            }
                        }
                    }
                    stack.push(new Enumeration(isObject(object) ? object : null, keys));
                    break;
                }
                case OP.NEXT: {
                    const to = ops[frame.pc++]!;
                    const enumeration = stack[stack.length - 1] as Enumeration;
                    // ループの中で消した名前は出さない
                    let key = enumeration.keys[enumeration.at++];
                    while (key !== undefined && enumeration.object !== null && !enumeration.object.has(key)) {
                        key = enumeration.keys[enumeration.at++];
                    }
                    if (key === undefined) frame.pc = to;
                    else stack.push(key);
                    break;
                }
                default:
                    throw new Error(`知らない命令 ${op}`);
            }
        }
    }
}

function arithmetic(op: number, a: number, b: number): number {
    switch (op) {
        case OP.SUB:
            return a - b;
        case OP.MUL:
            return a * b + 0;
        case OP.DIV:
            return divide(a, b);
        case OP.MOD:
            return modulo(a, b);
        case OP.SHL:
            return a << b;
        case OP.SHR:
            return a >> b;
        case OP.USHR:
            return a >>> b;
        case OP.BAND:
            return a & b;
        case OP.BOR:
            return a | b;
        default:
            return a ^ b;
    }
}
