/**
 * 2 進の表 (STD-B24 付属2 5.5 BinaryTable) と、NVRAM に書く並びの読み書き。
 *
 * 書式は `型:長さ単位` を `,` で並べたもの (`U:8b,S:16B,Z:1V`)。型は B (真偽)・U (符号なし)・
 * I (符号つき)・S (文字列)・Z (郵便番号の範囲)・P (詰め物)、単位は B (バイト)・b (ビット)・
 * V (長さが前に付く)。放送は 6 つの型と 3 つの単位を全部使う。
 */

export type FieldType = 'B' | 'U' | 'I' | 'S' | 'Z' | 'P';
export interface Field {
    type: FieldType;
    length: number;
    unit: 'B' | 'b' | 'V';
}

/** 郵便番号の範囲 (含む・除く) */
export interface ZipRanges {
    include: [number, number][];
    exclude: [number, number][];
}

export type Cell = boolean | number | string | ZipRanges;

export class BinaryError extends Error {}

export function parseStructure(text: string): Field[] | null {
    const fields: Field[] = [];
    for (const part of text.split(',')) {
        const match = /^([BUISZP]):([1-9][0-9]*)([BbVv])$/.exec(part.trim());
        if (match === null) return null;
        fields.push({
            type: match[1] as FieldType,
            length: Number(match[2]),
            unit: (match[3] === 'v' ? 'V' : match[3]) as Field['unit'],
        });
    }
    return fields;
}

class BitReader {
    constructor(
        private readonly data: Uint8Array,
        public position = 0,
    ) {}

    bits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++, this.position++) {
            value = value * 2 + (((this.data[this.position >> 3] ?? 0) >> (7 - (this.position & 7))) & 1);
        }
        return value;
    }

    aligned(): void {
        if ((this.position & 7) !== 0) throw new BinaryError('バイトの境目にありません');
    }

    bytes(count: number): Uint8Array {
        this.aligned();
        const at = this.position >> 3;
        this.position += count * 8;
        return this.data.subarray(at, at + count);
    }
}

function lengthInBits(field: Field): number {
    if (field.unit === 'b') return field.length;
    if (field.unit === 'B') return field.length * 8;
    throw new BinaryError(`${field.type} に V は使えません`);
}

/** 並びを 1 組読む。P は値にならない */
export function readFields(
    data: Uint8Array,
    fields: Field[],
    decode: (bytes: Uint8Array) => string,
    start = 0,
): [Cell[], number] {
    const reader = new BitReader(data, start);
    const out: Cell[] = [];
    for (const field of fields) {
        switch (field.type) {
            case 'B':
                out.push(reader.bits(lengthInBits(field)) !== 0);
                break;
            case 'U': {
                const bits = lengthInBits(field);
                if (bits > 32) throw new BinaryError('U は 32 ビットまで');
                out.push(reader.bits(bits));
                break;
            }
            case 'I': {
                if (field.unit !== 'B' || ![1, 2, 4].includes(field.length))
                    throw new BinaryError('I は 1/2/4 バイト');
                reader.aligned();
                const bits = field.length * 8;
                const value = reader.bits(bits);
                out.push(value >= 2 ** (bits - 1) ? value - 2 ** bits : value);
                break;
            }
            case 'S': {
                const size = field.unit === 'V' ? reader.bits(field.length * 8) : lengthInBits(field) / 8;
                const text = decode(reader.bytes(size));
                // 何も書いていなければ空 (NUL から後ろは捨てる)
                const nul = text.indexOf('\0');
                out.push(nul >= 0 ? text.slice(0, nul) : text);
                break;
            }
            case 'Z': {
                if (field.unit !== 'V') throw new BinaryError('Z は V だけ');
                const size = reader.bits(field.length * 8);
                out.push(decodeZip(reader.bytes(size)));
                break;
            }
            case 'P':
                reader.position += lengthInBits(field);
                break;
        }
    }
    return [out, reader.position];
}

/** 並びを書く。文字列は足りなければ空白で埋め、長ければ切る (TR-B14 第三分冊 8.1.15.6) */
export function writeFields(
    values: readonly Cell[],
    fields: Field[],
    encode: (text: string) => Uint8Array,
): Uint8Array {
    const bits: number[] = [];
    const push = (value: number, count: number): void => {
        for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) & 1);
    };
    const pushBytes = (bytes: Uint8Array): void => {
        for (const byte of bytes) push(byte, 8);
    };
    let index = 0;
    for (const field of fields) {
        if (field.type === 'P') {
            push(0, lengthInBits(field));
            continue;
        }
        const value = values[index++];
        switch (field.type) {
            case 'B':
                push(
                    value === true || (typeof value === 'number' && value !== 0) ? 1 : 0,
                    lengthInBits(field),
                );
                break;
            case 'U':
            case 'I': {
                const count = lengthInBits(field);
                const n = Number(value) || 0;
                push(((n % 2 ** count) + 2 ** count) % 2 ** count, count);
                break;
            }
            case 'S': {
                const encoded = encode(String(value ?? ''));
                if (field.unit === 'V') {
                    push(encoded.length, field.length * 8);
                    pushBytes(encoded);
                } else {
                    const size = lengthInBits(field) / 8;
                    const fixed = new Uint8Array(size).fill(0x20);
                    fixed.set(encoded.subarray(0, size));
                    pushBytes(fixed);
                }
                break;
            }
            case 'Z':
                throw new BinaryError('Z は書けません');
        }
    }
    const out = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => {
        if (bit) out[i >> 3]! |= 0x80 >> (i & 7);
    });
    return out;
}

/** 郵便番号の範囲を読む (STD-B24 付属2 5.5.2.3) */
function decodeZip(data: Uint8Array): ZipRanges {
    // [長さ, 除く並びの長さ, 除く並び…, 含む並び…] (web-bml の zip_code.ts と同じ読み方)
    const length = data[0] ?? 0;
    const exclude = data[1] ?? 0;
    return {
        exclude: zipList(data.subarray(2, 2 + exclude)),
        include: zipList(data.subarray(2 + exclude, 1 + length)),
    };
}

function zipList(data: Uint8Array): [number, number][] {
    const out: [number, number][] = [];
    let at = 0;
    let previous = 0;
    while (at + 4 <= data.length) {
        const first = data[at]!;
        if ((first & 0x80) === 0) {
            // 上 2 桁の範囲 (2 つまで)
            out.push([first * 100000, ((data[at + 1]! & 0x7f) + 1) * 100000 - 1]);
            if (data[at + 2]! & 0x80) {
                out.push([(data[at + 2]! & 0x7f) * 100000, ((data[at + 3]! & 0x7f) + 1) * 100000 - 1]);
            }
            at += 4;
            continue;
        }
        const top = first & 0x7f;
        const flag = data[at + 1]! >> 4;
        const d = [
            data[at + 1]! & 0xf,
            data[at + 2]! >> 4,
            data[at + 2]! & 0xf,
            data[at + 3]! >> 4,
            data[at + 3]! & 0xf,
        ];
        at += 4;
        const [a, b, c, e, f] = d as [number, number, number, number, number];
        switch (flag) {
            case 0x8:
                for (const digit of d)
                    if (digit < 10)
                        out.push([(top * 10 + digit) * 10000, (top * 10 + digit + 1) * 10000 - 1]);
                break;
            case 0x9:
                out.push([(top * 10 + b) * 10000, (top * 10 + c + 1) * 10000 - 1]);
                if (e < 10 && f < 10) out.push([(top * 10 + e) * 10000, (top * 10 + f + 1) * 10000 - 1]);
                break;
            case 0xa: {
                const base = top * 1000 + a * 100;
                out.push([(base + b * 10 + c) * 100, (base + b * 10 + c + 1) * 100 - 1]);
                if (e < 10 && f < 10)
                    out.push([(base + e * 10 + f) * 100, (base + e * 10 + f + 1) * 100 - 1]);
                break;
            }
            case 0xb:
                out.push([
                    (top * 1000 + a * 100 + b * 10 + c) * 100,
                    (top * 1000 + a * 100 + b * 10 + c) * 100,
                ]);
                break;
            case 0xc: {
                const last = out.at(-1);
                if (previous === 0xb && last !== undefined)
                    last[1] = (top * 1000 + a * 100 + b * 10 + c + 1) * 100 - 1;
                break;
            }
            case 0xd:
            case 0xf: {
                const n = top * 100000 + a * 10000 + b * 1000 + c * 100 + e * 10 + f;
                out.push([n, n]);
                break;
            }
            case 0xe: {
                const last = out.at(-1);
                if (previous === 0xd && last !== undefined)
                    last[1] = top * 100000 + a * 10000 + b * 1000 + c * 100 + e * 10 + f;
                break;
            }
        }
        previous = flag;
    }
    return out;
}

export function zipIncludes(ranges: ZipRanges, zip: number): boolean {
    const hit = (list: [number, number][]): boolean => list.some(([from, to]) => from <= zip && zip <= to);
    return hit(ranges.include) && !hit(ranges.exclude);
}

/** 表 (`new BinaryTable(ファイル, 書式)`)。書式の頭は行の長さのバイト数 (0 なら長さ無し) */
export class Table {
    readonly rows: Cell[][] = [];
    readonly fields: Field[];

    constructor(data: Uint8Array, structure: string, decode: (bytes: Uint8Array) => string) {
        const comma = structure.indexOf(',');
        const lengthBytes = Number(structure.slice(0, comma));
        const fields = comma < 0 ? null : parseStructure(structure.slice(comma + 1));
        if (!Number.isInteger(lengthBytes) || lengthBytes < 0 || fields === null)
            throw new BinaryError('書式が読めません');
        let position = 0;
        while (position < data.length * 8) {
            let length = 0;
            if (lengthBytes > 0) {
                length = new BitReader(data, position).bits(lengthBytes * 8);
                position += lengthBytes * 8;
            }
            const [row, end] = readFields(data, fields, decode, position);
            this.rows.push(row);
            // 行は必ずバイトの境目で終わる (付属2 5.5.2.4)
            const next = lengthBytes > 0 ? position + length * 8 : Math.ceil(end / 8) * 8;
            if (next <= position) break;
            position = next;
        }
        this.fields = fields.filter((field) => field.type !== 'P');
    }

    /**
     * 検索 (search)。条件は [列, 比べる値, 演算子] の並び、`or` が真なら どれか、偽なら すべて。
     * 見つけた行の郵便番号の列は、その列の条件の結果 (条件が無ければ null) にする (web-bml と同じ)。
     * 列や演算子が型に合わない・件数が 1 未満なら null (呼び手は NaN を返す)
     */
    search(
        start: number,
        conditions: [number, unknown, number][],
        or: boolean,
        limit: number,
    ): [(boolean | number | string | null)[][], number] | null {
        if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1) return null;
        for (const [column, , operator] of conditions) {
            const field = Number.isInteger(column) ? this.fields[column] : undefined;
            if (field === undefined || !operatorFits(field.type, operator)) return null;
        }
        const found: (boolean | number | string | null)[][] = [];
        for (let i = start; i < this.rows.length; i++) {
            const row = this.rows[i]!;
            const results = conditions.map(([column, compared, operator]) =>
                test(row[column], this.fields[column], compared, operator),
            );
            if (!(or ? results.some(Boolean) : results.every(Boolean))) continue;
            found.push(
                row.map((value, column) => {
                    if (typeof value !== 'object') return value;
                    const mine = results.filter((_, k) => conditions[k]![0] === column);
                    if (mine.length === 0) return null;
                    return or ? mine.some(Boolean) : mine.every(Boolean);
                }),
            );
            if (found.length >= limit) return [found, i];
        }
        return [found, -1];
    }
}

/** 検索の比べ方 (付属2 5.5.3.6) */
function test(
    cell: Cell | undefined,
    field: Field | undefined,
    compared: unknown,
    operator: number,
): boolean {
    if (cell === undefined || field === undefined) return false;
    if (typeof cell === 'number') {
        const n = Number(compared);
        const bits = field.unit === 'b' ? field.length : field.length * 8;
        const mask = bits >= 32 ? 0xffffffff : 2 ** bits - 1;
        switch (operator) {
            case 0:
                return cell === n;
            case 1:
                return cell !== n;
            case 2:
                return cell < n;
            case 3:
                return cell <= n;
            case 4:
                return cell > n;
            case 5:
                return cell >= n;
            case 6:
                return (cell & n & mask) !== 0;
            case 7:
                return ((cell | n) & mask) !== 0;
            case 8:
                return ((cell ^ n) & mask) !== 0;
            case 9:
                return (~cell & n & mask) !== 0;
            case 10:
                return ((~cell | n) & mask) !== 0;
            case 11:
                return ((~cell ^ n) & mask) !== 0;
        }
        return false;
    }
    if (typeof cell === 'string') {
        const s = String(compared);
        switch (operator) {
            case 32:
                return cell === s;
            case 33:
                return cell.includes(s);
            case 34:
                return cell.startsWith(s);
            case 35:
                return cell.endsWith(s);
            case 36:
                return cell !== s;
            case 37:
                return !cell.includes(s);
        }
        return false;
    }
    if (typeof cell === 'boolean') {
        if (operator === 64) return cell === Boolean(compared);
        if (operator === 65) return cell !== Boolean(compared);
        return false;
    }
    if (operator === 96) return zipIncludes(cell, Number(compared));
    if (operator === 97) return !zipIncludes(cell, Number(compared));
    return false;
}

/** 演算子が列の型に合うか (付属2 5.5.3.6) */
function operatorFits(type: FieldType, operator: number): boolean {
    if (type === 'U' || type === 'I') return operator >= 0 && operator <= 11;
    if (type === 'S') return operator >= 32 && operator <= 37;
    if (type === 'B') return operator === 64 || operator === 65;
    if (type === 'Z') return operator === 96 || operator === 97;
    return false;
}
