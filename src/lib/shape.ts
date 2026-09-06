/**
 * 外から来た JSON の形を確かめて、型を付ける。
 *
 * `res.json() as X` はキャストで、相手が本当にその形を返しているかは見ていない。
 * 相手が別のもの (チューナーエージェント、OIDC の相手、取り込み元の DB) なら、
 * 境界で1回だけ形を確かめて、以降は型のとおりに触る — DB の列を `schema.ts` の
 * 読み手で読むのと同じ理屈。ライブラリは入れていない。要るのは下の 10 個で足りる。
 *
 * 形は `object({ ... })` のように書き、型はそこから導く (`Infer<typeof SHAPE>`)。
 * 型と読み手を別々に書くと、片方だけ直したときに TS は何も言わない。
 *
 * 読めなければ `ShapeError` を投げる。どこが違うかを道筋 (`tuners[0].name`) で言う —
 * 「形が違う」だけでは、相手のどの版と噛み合っていないのか分からない
 */

export class ShapeError extends Error {}

/** 読み手。`path` は失敗したときに言う道筋 */
export type Shape<T> = (value: unknown, path: string) => T;

export type Infer<S> = S extends Shape<infer T> ? T : never;

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return '無し';
    if (Array.isArray(value)) return '配列';
    if (typeof value === 'string') return `文字列 ${JSON.stringify(value.slice(0, 40))}`;
    if (typeof value === 'object') return 'オブジェクト';
    return `${typeof value} ${String(value)}`;
}

function refuse(path: string, expected: string, value: unknown): never {
    throw new ShapeError(`${path === '' ? '全体' : path} は${expected}のはずが ${describe(value)}`);
}

export const string: Shape<string> = (value, path) =>
    typeof value === 'string' ? value : refuse(path, '文字列', value);

/** 有限の数。JSON に NaN は無いが、`Infinity` を投げてくる実装はある */
export const number: Shape<number> = (value, path) =>
    typeof value === 'number' && Number.isFinite(value) ? value : refuse(path, '数', value);

export const boolean: Shape<boolean> = (value, path) =>
    typeof value === 'boolean' ? value : refuse(path, '真偽', value);

/** 何でもよい。形を見ないところ (相手に丸ごと渡すもの) にだけ使う */
export const unknown: Shape<unknown> = (value) => value;

/** 決まった値のどれか。`literal('GR', 'BS')` で `'GR' | 'BS'` */
export function literal<const L extends string | number | boolean>(...options: L[]): Shape<L> {
    return (value, path) =>
        options.some((option) => option === value)
            ? (value as L)
            : refuse(path, `決まった値 (${options.map((o) => JSON.stringify(o)).join(' / ')})`, value);
}

/** 無くてもよい。`object` の中では、無ければ鍵ごと付けない */
export function optional<T>(shape: Shape<T>): Shape<T | undefined> {
    return (value, path) => (value === undefined ? undefined : shape(value, path));
}

/** null でもよい。**無いのも null と読む** — null の鍵を省いて書く実装がある (手で書いた設定ファイルも) */
export function nullable<T>(shape: Shape<T>): Shape<T | null> {
    return (value, path) => (value === null || value === undefined ? null : shape(value, path));
}

export function array<T>(item: Shape<T>): Shape<T[]> {
    return (value, path) =>
        Array.isArray(value)
            ? value.map((entry, i) => item(entry, `${path}[${i}]`))
            : refuse(path, '配列', value);
}

/** 鍵が決まっていないオブジェクト。値の形だけ見る */
export function record<T>(item: Shape<T>): Shape<Record<string, T>> {
    return (value, path) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return refuse(path, 'オブジェクト', value);
        }
        const out: Record<string, T> = {};
        for (const [key, entry] of Object.entries(value))
            out[key] = item(entry, path === '' ? key : `${path}.${key}`);
        return out;
    };
}

/** どちらか。先に当たったほうの形になる */
export function either<A, B>(a: Shape<A>, b: Shape<B>): Shape<A | B> {
    return (value, path) => {
        try {
            return a(value, path);
        } catch (first) {
            try {
                return b(value, path);
            } catch {
                throw first;
            }
        }
    };
}

type Fields = Record<string, Shape<unknown>>;
type OptionalKeys<F extends Fields> = { [K in keyof F]: undefined extends Infer<F[K]> ? K : never }[keyof F];
/** `optional()` の鍵は省ける形にする (exactOptionalPropertyTypes に合わせて、無ければ鍵ごと無い) */
type ObjectOf<F extends Fields> = { [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & {
    [K in OptionalKeys<F>]?: Infer<F[K]>;
};

/**
 * 決まった鍵を持つオブジェクト。**知らない鍵は捨てる** — 相手が足したものを
 * こちらの型に混ぜないため。丸ごと要るなら `record(unknown)` で受ける
 */
export function object<F extends Fields>(fields: F): Shape<ObjectOf<F>> {
    return (value, path) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return refuse(path, 'オブジェクト', value);
        }
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, shape] of Object.entries(fields)) {
            const parsed = shape(source[key], path === '' ? key : `${path}.${key}`);
            if (parsed !== undefined || key in source) out[key] = parsed;
        }
        return out as ObjectOf<F>;
    };
}

/**
 * 読む。**形が違えば止める。** 失敗の言葉に、何を読んでいたかを添える
 * (`ID トークンの形が違います: exp は数のはずが 無し`)。
 *
 * 止めてよいのは、違う形のまま進むと危ないところ (ID トークン) だけ。相手が
 * 別の版で動いているだけなら止めずに通す (`tolerate`)
 */
export function read<T>(shape: Shape<T>, value: unknown, what: string): T {
    try {
        return shape(value, '');
    } catch (error) {
        if (error instanceof ShapeError) throw new ShapeError(`${what}の形が違います: ${error.message}`);
        throw error;
    }
}

/** 同じ警告を繰り返さない (チューナーの状態は何秒かおきに読む) */
const warned = new Set<string>();

/**
 * 読む。**形が違っても止めない。** 警告を1回だけ出して、来たものをそのまま型にする
 * (前の `as X` と同じ振る舞い)。
 *
 * 相手 (チューナーエージェント) は別のリポジトリで、版がずれると鍵が増えたり
 * 名前が変わったりする。そのたびに録画が止まるのでは困る — 動いているものは
 * 動かしたまま、**どこが違うかを言う**。直すのは人
 */
export function tolerate<T>(shape: Shape<T>, value: unknown, what: string, warn = console.warn): T {
    try {
        return shape(value, '');
    } catch (error) {
        if (!(error instanceof ShapeError)) throw error;
        const message = `[shape] ${what}の形が違います (相手の版がずれている?)。そのまま使います: ${error.message}`;
        if (!warned.has(message)) {
            warned.add(message);
            warn(message);
        }
        return value as T;
    }
}
