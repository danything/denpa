/**
 * 木 ([parser.ts](parser.ts)) を VM ([vm.ts](vm.ts)) の命令列にする。
 *
 * 積み上げ式 (stack machine)。名前は組むときに決める: 関数の中で宣言したもの
 * (引数・var・中の関数) は「何段外の、何番目」で引き、どこにも無ければ大域の物の
 * 名前で引く。入れ子の関数は外の変数をキャプチャする (クロージャ) が、放送はほぼ使わない。
 */

import { ScriptSyntaxError } from './lexer';
import { type Expr, type FunctionNode, parseScript, type Stmt } from './parser';
import type { Value } from './values';

/** 命令。番号は命令列の中の値 (後ろに引数が続くものがある) */
export const OP = {
    UNDEF: 0,
    NULL: 1,
    TRUE: 2,
    FALSE: 3,
    CONST: 4, // k
    THIS: 5,
    POP: 6,
    DUP: 7,
    DUP2: 8,
    ROT3: 9,
    ROT4: 10,
    LOAD: 11, // depth slot
    STORE: 12, // depth slot
    LOAD_GLOBAL: 13, // k
    STORE_GLOBAL: 14, // k
    TYPEOF_GLOBAL: 15, // k
    DELETE_GLOBAL: 16, // k
    GET: 17, // k
    SET: 18, // k
    GET_ELEM: 19,
    SET_ELEM: 20,
    DELETE: 21, // k
    DELETE_ELEM: 22,
    CALL: 23, // argc
    NEW: 24, // argc
    RETURN: 25,
    JUMP: 26, // to
    JUMP_FALSE: 27, // to
    JUMP_TRUE: 28, // to
    AND: 29, // to (偽ならそのまま残して飛ぶ)
    OR: 30, // to
    ADD: 31,
    SUB: 32,
    MUL: 33,
    DIV: 34,
    MOD: 35,
    SHL: 36,
    SHR: 37,
    USHR: 38,
    BAND: 39,
    BOR: 40,
    BXOR: 41,
    EQ: 42,
    NE: 43,
    SEQ: 44,
    SNE: 45,
    LT: 46,
    GT: 47,
    LE: 48,
    GE: 49,
    IN: 50,
    INSTANCEOF: 51,
    NOT: 52,
    NEG: 53,
    NUM: 54,
    BNOT: 55,
    TYPEOF: 56,
    ARRAY: 57, // n
    OBJECT: 58, // shapes の番号
    FORIN: 59,
    NEXT: 60, // to
    SWAP: 62,
} as const;

/** 組んだ関数 1 つ (大域のコードも 1 つの関数として扱う) */
export interface Code {
    name: string;
    ops: number[];
    consts: Value[];
    funcs: Code[];
    /** 引数の置き場所 (同じ名前が 2 度あれば同じ場所) */
    params: number[];
    /** 変数の数 (引数を含む) */
    slots: number;
    /** `arguments` の置き場所 (使わなければ -1) */
    argumentsSlot: number;
    /** 入ったときに作る関数宣言 [関数の番号, 置き場所 (大域なら -1)、大域の名前] */
    hoisted: [number, number, string][];
    /** 大域のコードで宣言した var (入ったときに無ければ undefined を置く) */
    globals: string[];
    /** オブジェクトのリテラルの名前の並び (OBJECT の引数が指す) */
    shapes: string[][];
}

interface Scope {
    names: Map<string, number>;
    parent: Scope | null;
}

interface Breakable {
    kind: 'loop' | 'forin' | 'switch';
    breaks: number[];
    continues: number[];
}

const BINARY_OPS: Record<string, number> = {
    '+': OP.ADD,
    '-': OP.SUB,
    '*': OP.MUL,
    '/': OP.DIV,
    '%': OP.MOD,
    '<<': OP.SHL,
    '>>': OP.SHR,
    '>>>': OP.USHR,
    '&': OP.BAND,
    '|': OP.BOR,
    '^': OP.BXOR,
    '==': OP.EQ,
    '!=': OP.NE,
    '===': OP.SEQ,
    '!==': OP.SNE,
    '<': OP.LT,
    '>': OP.GT,
    '<=': OP.LE,
    '>=': OP.GE,
    in: OP.IN,
    instanceof: OP.INSTANCEOF,
};

/** 文の中の var と関数宣言を集める (巻き上げ) */
function collect(body: Stmt[], vars: string[], funcs: FunctionNode[]): void {
    const visit = (stmt: Stmt): void => {
        switch (stmt.kind) {
            case 'var':
                for (const [name] of stmt.decls) vars.push(name);
                break;
            case 'func':
                funcs.push(stmt.func);
                break;
            case 'block':
                stmt.body.forEach(visit);
                break;
            case 'if':
                visit(stmt.then);
                if (stmt.else !== null) visit(stmt.else);
                break;
            case 'for':
                if (stmt.init !== null) visit(stmt.init);
                visit(stmt.body);
                break;
            case 'forin':
                if (stmt.declare && stmt.target.kind === 'name') vars.push(stmt.target.name);
                visit(stmt.body);
                break;
            case 'while':
            case 'do':
                visit(stmt.body);
                break;
            case 'switch':
                for (const c of stmt.cases) c.body.forEach(visit);
                break;
        }
    };
    body.forEach(visit);
}

/** 本体で `arguments` を使っているか (中の関数は数えない) */
function usesArguments(body: Stmt[]): boolean {
    let found = false;
    const expr = (e: Expr | null): void => {
        if (e === null || found) return;
        switch (e.kind) {
            case 'name':
                if (e.name === 'arguments') found = true;
                break;
            case 'array':
                e.items.forEach(expr);
                break;
            case 'object':
                for (const [, v] of e.props) expr(v);
                break;
            case 'member':
                expr(e.object);
                break;
            case 'index':
                expr(e.object);
                expr(e.index);
                break;
            case 'call':
            case 'new':
                expr(e.callee);
                e.args.forEach(expr);
                break;
            case 'unary':
            case 'update':
                expr(e.arg);
                break;
            case 'binary':
            case 'logical':
                expr(e.left);
                expr(e.right);
                break;
            case 'cond':
                expr(e.test);
                expr(e.then);
                expr(e.else);
                break;
            case 'assign':
                expr(e.target);
                expr(e.value);
                break;
            case 'seq':
                e.items.forEach(expr);
                break;
        }
    };
    const stmt = (s: Stmt | null): void => {
        if (s === null || found) return;
        switch (s.kind) {
            case 'var':
                for (const [, v] of s.decls) expr(v);
                break;
            case 'expr':
                expr(s.expr);
                break;
            case 'block':
                s.body.forEach(stmt);
                break;
            case 'if':
                expr(s.test);
                stmt(s.then);
                stmt(s.else);
                break;
            case 'for':
                stmt(s.init);
                expr(s.test);
                expr(s.update);
                stmt(s.body);
                break;
            case 'forin':
                expr(s.target);
                expr(s.object);
                stmt(s.body);
                break;
            case 'while':
            case 'do':
                expr(s.test);
                stmt(s.body);
                break;
            case 'switch':
                expr(s.disc);
                for (const c of s.cases) {
                    expr(c.test);
                    c.body.forEach(stmt);
                }
                break;
            case 'return':
                expr(s.value);
                break;
        }
    };
    body.forEach(stmt);
    return found;
}

class FunctionCompiler {
    readonly code: Code;
    private readonly constIndex = new Map<string, number>();
    private readonly breakables: Breakable[] = [];

    constructor(
        name: string,
        private readonly scope: Scope | null,
    ) {
        this.code = {
            name,
            ops: [],
            consts: [],
            funcs: [],
            params: [],
            slots: 0,
            argumentsSlot: -1,
            hoisted: [],
            globals: [],
            shapes: [],
        };
    }

    private emit(...ops: number[]): void {
        this.code.ops.push(...ops);
    }

    private constant(value: string | number): number {
        const key = `${typeof value}:${value}`;
        let index = this.constIndex.get(key);
        if (index === undefined) {
            index = this.code.consts.length;
            this.code.consts.push(value);
            this.constIndex.set(key, index);
        }
        return index;
    }

    /** 飛び先を後で埋める命令を出し、その位置を返す */
    private jump(op: number): number {
        this.emit(op, -1);
        return this.code.ops.length - 1;
    }

    private land(at: number): void {
        this.code.ops[at] = this.code.ops.length;
    }

    private landAll(list: number[]): void {
        for (const at of list) this.land(at);
    }

    /** 関数 (または大域のコード) の本体を組む */
    compileBody(params: string[], body: Stmt[]): Code {
        const vars: string[] = [];
        const funcs: FunctionNode[] = [];
        collect(body, vars, funcs);
        if (this.scope !== null) {
            const names = this.scope.names;
            for (const p of params) if (!names.has(p)) names.set(p, names.size);
            this.code.params = params.map((p) => names.get(p)!);
            for (const v of vars) if (!names.has(v)) names.set(v, names.size);
            for (const f of funcs) if (!names.has(f.name)) names.set(f.name, names.size);
            if (!names.has('arguments') && usesArguments(body)) {
                names.set('arguments', names.size);
                this.code.argumentsSlot = names.get('arguments')!;
            }
            this.code.slots = names.size;
        } else {
            this.code.globals = [...new Set(vars)];
        }
        for (const f of funcs) {
            const index = this.code.funcs.length;
            const inner = new FunctionCompiler(f.name, { names: new Map(), parent: this.scope });
            this.code.funcs.push(inner.compileBody(f.params, f.body));
            const slot = this.scope?.names.get(f.name) ?? -1;
            this.code.hoisted.push([index, slot, f.name]);
        }
        for (const stmt of body) this.statement(stmt);
        this.emit(OP.UNDEF, OP.RETURN);
        return this.code;
    }

    /** 名前の在り処。関数の中なら [段, 番号]、大域なら null */
    private resolve(name: string): [number, number] | null {
        let depth = 0;
        for (let s = this.scope; s !== null; s = s.parent, depth++) {
            const slot = s.names.get(name);
            if (slot !== undefined) return [depth, slot];
        }
        return null;
    }

    private load(name: string): void {
        const at = this.resolve(name);
        if (at === null) this.emit(OP.LOAD_GLOBAL, this.constant(name));
        else this.emit(OP.LOAD, at[0], at[1]);
    }

    private store(name: string): void {
        const at = this.resolve(name);
        if (at === null) this.emit(OP.STORE_GLOBAL, this.constant(name));
        else this.emit(OP.STORE, at[0], at[1]);
    }

    private statement(stmt: Stmt): void {
        switch (stmt.kind) {
            case 'var':
                for (const [name, init] of stmt.decls) {
                    if (init === null) continue;
                    this.expression(init);
                    this.store(name);
                    this.emit(OP.POP);
                }
                return;
            case 'func':
            case 'empty':
                return;
            case 'expr':
                this.expression(stmt.expr);
                this.emit(OP.POP);
                return;
            case 'block':
                for (const s of stmt.body) this.statement(s);
                return;
            case 'if': {
                this.expression(stmt.test);
                const skip = this.jump(OP.JUMP_FALSE);
                this.statement(stmt.then);
                if (stmt.else === null) {
                    this.land(skip);
                    return;
                }
                const end = this.jump(OP.JUMP);
                this.land(skip);
                this.statement(stmt.else);
                this.land(end);
                return;
            }
            case 'while': {
                const top = this.code.ops.length;
                this.expression(stmt.test);
                const exit = this.jump(OP.JUMP_FALSE);
                const loop = this.loop('loop', stmt.body);
                this.patch(loop.continues, top);
                this.emit(OP.JUMP, top);
                this.land(exit);
                this.landAll(loop.breaks);
                return;
            }
            case 'do': {
                const top = this.code.ops.length;
                const loop = this.loop('loop', stmt.body);
                this.landAll(loop.continues);
                this.expression(stmt.test);
                this.emit(OP.JUMP_TRUE, top);
                this.landAll(loop.breaks);
                return;
            }
            case 'for': {
                if (stmt.init !== null) this.statement(stmt.init);
                const top = this.code.ops.length;
                let exit = -1;
                if (stmt.test !== null) {
                    this.expression(stmt.test);
                    exit = this.jump(OP.JUMP_FALSE);
                }
                const loop = this.loop('loop', stmt.body);
                this.landAll(loop.continues);
                if (stmt.update !== null) {
                    this.expression(stmt.update);
                    this.emit(OP.POP);
                }
                this.emit(OP.JUMP, top);
                if (exit >= 0) this.land(exit);
                this.landAll(loop.breaks);
                return;
            }
            case 'forin': {
                this.expression(stmt.object);
                this.emit(OP.FORIN);
                const top = this.code.ops.length;
                const exit = this.jump(OP.NEXT);
                // 名前が 1 つ積まれている。左辺へ入れる
                this.assignTop(stmt.target);
                const loop = this.loop('forin', stmt.body);
                this.patch(loop.continues, top);
                this.emit(OP.JUMP, top);
                this.land(exit);
                this.landAll(loop.breaks);
                // 使い終わった列挙を降ろす
                this.emit(OP.POP);
                return;
            }
            case 'switch': {
                this.expression(stmt.disc);
                const entries: number[] = [];
                for (const c of stmt.cases) {
                    if (c.test === null) {
                        entries.push(-1);
                        continue;
                    }
                    this.emit(OP.DUP);
                    this.expression(c.test);
                    this.emit(OP.SEQ);
                    entries.push(this.jump(OP.JUMP_TRUE));
                }
                const fallback = this.jump(OP.JUMP);
                const entry: Breakable = { kind: 'switch', breaks: [], continues: [] };
                this.breakables.push(entry);
                let hasDefault = false;
                stmt.cases.forEach((c, i) => {
                    const at = entries[i]!;
                    if (at === -1) {
                        hasDefault = true;
                        this.land(fallback);
                    } else {
                        this.land(at);
                    }
                    for (const s of c.body) this.statement(s);
                });
                this.breakables.pop();
                if (!hasDefault) this.land(fallback);
                this.landAll(entry.breaks);
                this.emit(OP.POP);
                return;
            }
            case 'break': {
                const target = this.breakables.at(-1);
                if (target === undefined) throw new ScriptSyntaxError('break がループの外にあります');
                target.breaks.push(this.jump(OP.JUMP));
                return;
            }
            case 'continue': {
                // 間にある switch / for-in の積んだものを降ろしてから、いちばん内側のループへ
                for (let i = this.breakables.length - 1; i >= 0; i--) {
                    const target = this.breakables[i]!;
                    if (target.kind === 'switch') {
                        this.emit(OP.POP);
                        continue;
                    }
                    target.continues.push(this.jump(OP.JUMP));
                    return;
                }
                throw new ScriptSyntaxError('continue がループの外にあります');
            }
            case 'return':
                if (this.scope === null) throw new ScriptSyntaxError('return が関数の外にあります');
                if (stmt.value === null) this.emit(OP.UNDEF);
                else this.expression(stmt.value);
                this.emit(OP.RETURN);
                return;
        }
    }

    private loop(kind: 'loop' | 'forin', body: Stmt): Breakable {
        const entry: Breakable = { kind, breaks: [], continues: [] };
        this.breakables.push(entry);
        this.statement(body);
        this.breakables.pop();
        return entry;
    }

    private patch(list: number[], to: number): void {
        for (const at of list) this.code.ops[at] = to;
    }

    /** 積まれた値を左辺に入れて降ろす (for-in の名前) */
    private assignTop(target: Expr): void {
        if (target.kind === 'name') {
            this.store(target.name);
        } else if (target.kind === 'member') {
            this.expression(target.object);
            this.emit(OP.SWAP, OP.SET, this.constant(target.name));
        } else if (target.kind === 'index') {
            this.expression(target.object);
            this.expression(target.index);
            // [名前, 物, 鍵] を [物, 鍵, 名前] に回す
            this.emit(OP.ROT3, OP.ROT3, OP.SET_ELEM);
        }
        this.emit(OP.POP);
    }

    private expression(expr: Expr): void {
        switch (expr.kind) {
            case 'num':
                this.emit(OP.CONST, this.constant(Math.trunc(expr.value)));
                return;
            case 'str':
                this.emit(OP.CONST, this.constant(expr.value));
                return;
            case 'bool':
                this.emit(expr.value ? OP.TRUE : OP.FALSE);
                return;
            case 'null':
                this.emit(OP.NULL);
                return;
            case 'this':
                this.emit(OP.THIS);
                return;
            case 'name':
                this.load(expr.name);
                return;
            case 'array':
                for (const item of expr.items) this.expression(item);
                this.emit(OP.ARRAY, expr.items.length);
                return;
            case 'object':
                for (const [, value] of expr.props) this.expression(value);
                this.emit(OP.OBJECT, this.code.shapes.length);
                this.code.shapes.push(expr.props.map(([k]) => k));
                return;
            case 'member':
                this.expression(expr.object);
                this.emit(OP.GET, this.constant(expr.name));
                return;
            case 'index':
                this.expression(expr.object);
                this.expression(expr.index);
                this.emit(OP.GET_ELEM);
                return;
            case 'call':
                if (expr.callee.kind === 'member') {
                    this.expression(expr.callee.object);
                    this.emit(OP.DUP, OP.GET, this.constant(expr.callee.name));
                } else if (expr.callee.kind === 'index') {
                    this.expression(expr.callee.object);
                    this.emit(OP.DUP);
                    this.expression(expr.callee.index);
                    this.emit(OP.GET_ELEM);
                } else {
                    this.emit(OP.UNDEF);
                    this.expression(expr.callee);
                }
                for (const arg of expr.args) this.expression(arg);
                this.emit(OP.CALL, expr.args.length);
                return;
            case 'new':
                this.expression(expr.callee);
                for (const arg of expr.args) this.expression(arg);
                this.emit(OP.NEW, expr.args.length);
                return;
            case 'unary':
                this.unary(expr.op, expr.arg);
                return;
            case 'update':
                this.update(expr);
                return;
            case 'binary':
                this.expression(expr.left);
                this.expression(expr.right);
                this.emit(BINARY_OPS[expr.op]!);
                return;
            case 'logical': {
                this.expression(expr.left);
                const end = this.jump(expr.op === '&&' ? OP.AND : OP.OR);
                this.expression(expr.right);
                this.land(end);
                return;
            }
            case 'cond': {
                this.expression(expr.test);
                const otherwise = this.jump(OP.JUMP_FALSE);
                this.expression(expr.then);
                const end = this.jump(OP.JUMP);
                this.land(otherwise);
                this.expression(expr.else);
                this.land(end);
                return;
            }
            case 'assign':
                this.assign(expr.op, expr.target, expr.value);
                return;
            case 'seq':
                expr.items.forEach((item, i) => {
                    this.expression(item);
                    if (i < expr.items.length - 1) this.emit(OP.POP);
                });
                return;
        }
    }

    private unary(op: string, arg: Expr): void {
        if (op === 'typeof' && arg.kind === 'name' && this.resolve(arg.name) === null) {
            // 宣言していない大域の名前でも誤りにしない
            this.emit(OP.TYPEOF_GLOBAL, this.constant(arg.name));
            return;
        }
        if (op === 'delete') {
            if (arg.kind === 'member') {
                this.expression(arg.object);
                this.emit(OP.DELETE, this.constant(arg.name));
            } else if (arg.kind === 'index') {
                this.expression(arg.object);
                this.expression(arg.index);
                this.emit(OP.DELETE_ELEM);
            } else if (arg.kind === 'name') {
                // var で宣言したものは消せない。宣言せずに作った大域だけ消える
                if (this.resolve(arg.name) === null) this.emit(OP.DELETE_GLOBAL, this.constant(arg.name));
                else this.emit(OP.FALSE);
            } else {
                this.expression(arg);
                this.emit(OP.POP, OP.TRUE);
            }
            return;
        }
        this.expression(arg);
        switch (op) {
            case '!':
                this.emit(OP.NOT);
                return;
            case '-':
                this.emit(OP.NEG);
                return;
            case '+':
                this.emit(OP.NUM);
                return;
            case '~':
                this.emit(OP.BNOT);
                return;
            case 'typeof':
                this.emit(OP.TYPEOF);
                return;
            case 'void':
                this.emit(OP.POP, OP.UNDEF);
                return;
        }
    }

    /** `++x` / `x--` など */
    private update(expr: Expr & { kind: 'update' }): void {
        const step = expr.op === '++' ? OP.ADD : OP.SUB;
        const one = this.constant(1);
        const target = expr.arg;
        if (target.kind === 'name') {
            this.load(target.name);
            this.emit(OP.NUM);
            if (!expr.prefix) this.emit(OP.DUP);
            this.emit(OP.CONST, one, step);
            this.store(target.name);
            if (!expr.prefix) this.emit(OP.POP);
            return;
        }
        if (target.kind === 'member') {
            const name = this.constant(target.name);
            this.expression(target.object);
            this.emit(OP.DUP, OP.GET, name, OP.NUM);
            // 後置: [o, 古] → [古, o, 古] にしてから足す
            if (!expr.prefix) this.emit(OP.DUP, OP.ROT3);
            this.emit(OP.CONST, one, step, OP.SET, name);
            if (!expr.prefix) this.emit(OP.POP);
            return;
        }
        if (target.kind === 'index') {
            this.expression(target.object);
            this.expression(target.index);
            this.emit(OP.DUP2, OP.GET_ELEM, OP.NUM);
            if (!expr.prefix) this.emit(OP.DUP, OP.ROT4);
            this.emit(OP.CONST, one, step, OP.SET_ELEM);
            if (!expr.prefix) this.emit(OP.POP);
        }
    }

    private assign(op: string, target: Expr, value: Expr): void {
        const binary = op === '=' ? null : BINARY_OPS[op.slice(0, -1)]!;
        if (target.kind === 'name') {
            if (binary !== null) this.load(target.name);
            this.expression(value);
            if (binary !== null) this.emit(binary);
            this.store(target.name);
            return;
        }
        if (target.kind === 'member') {
            const name = this.constant(target.name);
            this.expression(target.object);
            if (binary !== null) this.emit(OP.DUP, OP.GET, name);
            this.expression(value);
            if (binary !== null) this.emit(binary);
            this.emit(OP.SET, name);
            return;
        }
        if (target.kind === 'index') {
            this.expression(target.object);
            this.expression(target.index);
            if (binary !== null) this.emit(OP.DUP2, OP.GET_ELEM);
            this.expression(value);
            if (binary !== null) this.emit(binary);
            this.emit(OP.SET_ELEM);
        }
    }
}

/** 大域のコード (`<script>` 1 つ) を組む。誤りは投げる */
export function compileProgram(body: Stmt[], name: string): Code {
    return new FunctionCompiler(name, null).compileBody([], body);
}

/** スクリプトの文字列を組む。構文の誤りは `ScriptSyntaxError` で投げる */
export function compileScript(source: string, name: string): Code {
    return compileProgram(parseScript(source), name);
}
