import { describe, expect, test } from 'bun:test';
import {
    array,
    boolean,
    either,
    type Infer,
    literal,
    nullable,
    number,
    object,
    optional,
    read,
    record,
    ShapeError,
    string,
    tolerate,
} from './shape';

const TUNER = object({
    index: number,
    name: string,
    types: array(literal('GR', 'BS', 'CS')),
    channel: nullable(object({ type: string, channel: string })),
    error: optional(string),
});
type Tuner = Infer<typeof TUNER>;

describe('外から来た JSON の形', () => {
    test('合っていればそのまま型が付く', () => {
        const tuner: Tuner = read(
            TUNER,
            { index: 0, name: 'PT3', types: ['GR'], channel: null, error: undefined },
            'チューナー',
        );
        expect(tuner).toEqual({ index: 0, name: 'PT3', types: ['GR'], channel: null });
        expect(tuner.channel?.type).toBeUndefined();
    });

    test('知らない鍵は捨て、無い optional は鍵ごと付けない', () => {
        const tuner = read(
            TUNER,
            { index: 0, name: 'PT3', types: [], channel: null, extra: 1 },
            'チューナー',
        );
        expect('extra' in tuner).toBe(false);
        expect('error' in tuner).toBe(false);
    });

    test('違うところを道筋で言う', () => {
        expect(() =>
            read(TUNER, { index: 0, name: 'PT3', types: ['SKY'], channel: null }, 'チューナー'),
        ).toThrow(
            /チューナーの形が違います: types\[0\] は決まった値 \("GR" \/ "BS" \/ "CS"\)のはずが 文字列 "SKY"/,
        );
        expect(() => read(TUNER, { index: '0', name: 'PT3', types: [], channel: null }, 'x')).toThrow(
            /index は数のはずが 文字列 "0"/,
        );
        expect(() => read(TUNER, { index: 0, name: 'PT3', types: [], channel: { type: 'GR' } }, 'x')).toThrow(
            /channel\.channel は文字列のはずが 無し/,
        );
        expect(() => read(TUNER, null, 'x')).toThrow(ShapeError);
        expect(() => read(TUNER, [], 'x')).toThrow(/全体 はオブジェクトのはずが 配列/);
    });

    test('nullable は無いのも null と読む', () => {
        const tuner = read(TUNER, { index: 0, name: 'PT3', types: [] }, 'チューナー');
        expect(tuner.channel).toBeNull();
        expect(() => read(TUNER, { index: 0, name: 'PT3', types: [], channel: 1 }, 'x')).toThrow(
            /channel はオブジェクトのはずが number 1/,
        );
    });

    test('数は有限のものだけ', () => {
        expect(() => read(number, Number.POSITIVE_INFINITY, 'x')).toThrow(ShapeError);
        expect(() => read(number, Number.NaN, 'x')).toThrow(ShapeError);
        expect(read(number, -1.5, 'x')).toBe(-1.5);
    });

    test('either は先に当たったほう', () => {
        const aud = either(string, array(string));
        expect(read(aud, 'a', 'x')).toBe('a');
        expect(read(aud, ['a', 'b'], 'x')).toEqual(['a', 'b']);
        // どちらでもなければ、最初の形の言い分で断る
        expect(() => read(aud, 1, 'x')).toThrow(/文字列のはずが number 1/);
    });

    test('record は鍵を決めず、値の形だけ見る', () => {
        expect(read(record(boolean), { a: true, b: false }, 'x')).toEqual({ a: true, b: false });
        expect(() => read(record(boolean), { a: 1 }, 'x')).toThrow(/a は真偽のはずが number 1/);
        expect(() => read(record(boolean), [], 'x')).toThrow(/オブジェクトのはずが 配列/);
    });

    test('tolerate は形が違っても止めず、1回だけ警告して通す', () => {
        const warnings: string[] = [];
        const warn = (message: string) => warnings.push(message);
        const odd: unknown = { index: 0, name: 'PT3', types: ['SAT'], channel: null };
        // 型は付くが中身はそのまま (版がずれた相手を止めない)
        const first: unknown = tolerate(TUNER, odd, 'エージェントの /denpa/tuners', warn);
        const second: unknown = tolerate(TUNER, odd, 'エージェントの /denpa/tuners', warn);
        expect(first).toBe(odd);
        expect(second).toBe(odd);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(
            /^\[shape\] エージェントの \/denpa\/tunersの形が違います \(相手の版がずれている\?\)。そのまま使います: /,
        );
        expect(warnings[0]).toContain('types[0] は決まった値');
        // 合っていれば黙って読む
        expect(tolerate(TUNER, { index: 1, name: 'x', types: [] }, 'y', warn).channel).toBeNull();
        expect(warnings).toHaveLength(1);
    });

    test('ShapeError 以外はそのまま通す', () => {
        const broken = () => {
            throw new TypeError('別の失敗');
        };
        expect(() => read(broken, 1, 'x')).toThrow(TypeError);
    });
});
