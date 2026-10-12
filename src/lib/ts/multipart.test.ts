import { describe, expect, test } from 'bun:test';
import { parseMediaType, readEntity } from './multipart';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const str = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('parseMediaType', () => {
    test('型と引数を読み、名前は小文字にそろえる', () => {
        expect(parseMediaType('text/X-arib-bml; Charset="EUC-JP"')).toEqual({
            type: 'text',
            originalType: 'text',
            subtype: 'x-arib-bml',
            originalSubtype: 'X-arib-bml',
            parameters: [{ attribute: 'charset', originalAttribute: 'Charset', value: 'EUC-JP' }],
        });
    });

    test('引数が崩れていても、読めたところまで返す', () => {
        const media = parseMediaType('multipart/mixed; boundary=abc; broken');
        expect(media?.subtype).toBe('mixed');
        expect(media?.parameters.map((p) => p.value)).toEqual(['abc']);
    });

    test('型すら無ければ null', () => {
        expect(parseMediaType('')).toBeNull();
        expect(parseMediaType(';x=1')).toBeNull();
    });

    test('引用の中の \\ は次の字をそのまま', () => {
        expect(parseMediaType('a/b; q="x\\"y"')?.parameters[0]?.value).toBe('x"y');
    });
});

describe('readEntity', () => {
    test('ヘッダと本体を分ける。折り返しは1つの値に', () => {
        const entity = readEntity(bytes('Content-Type: image/png\r\nX-Long: a\r\n b\r\n\r\nBODY'));
        expect(entity?.headers).toEqual([
            { name: 'content-type', value: 'image/png' },
            { name: 'x-long', value: 'a b' },
        ]);
        expect(str(entity!.body)).toBe('BODY');
        expect(entity?.parts).toBeNull();
    });

    test('ヘッダの終わりが無ければ null', () => {
        expect(readEntity(bytes('Content-Type: image/png\r\n'))).toBeNull();
    });

    test('multipart/mixed を区切りで切る。本体の中の似た並びでは切らない', () => {
        const entity = readEntity(
            bytes(
                'Content-Type: multipart/mixed; boundary="b"\r\n\r\n' +
                    'preamble\r\n' +
                    '--b\r\nContent-Location: a.bml\r\n\r\nA\r\n--bb\r\n' +
                    '--b\r\nContent-Location: c.png\r\n\r\nC\r\n' +
                    '--b--\r\nepilogue',
            ),
        );
        expect(entity?.parts?.map((part) => part.headers[0]?.value)).toEqual(['a.bml', 'c.png']);
        expect(entity?.parts?.map((part) => str(part.body))).toEqual(['A\r\n--bb', 'C']);
    });

    test('中身が空の部品も 1 つとして数える (空行の CRLF が区切りに食われる形も)', () => {
        for (const empty of ['\r\n', '']) {
            const entity = readEntity(
                bytes(
                    'Content-Type: multipart/mixed; boundary=b\r\n\r\n' +
                        `--b\r\nContent-Location: empty.drc\r\n${empty}\r\n` +
                        '--b\r\nContent-Location: a.bml\r\n\r\nA\r\n' +
                        '--b--\r\n',
                ),
            );
            expect(entity?.parts?.map((part) => part.headers[0]?.value)).toEqual(['empty.drc', 'a.bml']);
            expect(entity?.parts?.map((part) => part.body.length)).toEqual([0, 1]);
        }
    });

    test('閉じの区切りが無ければ捨てる', () => {
        const entity = readEntity(
            bytes('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Location: a\r\n\r\nA'),
        );
        expect(entity?.parts).toBeNull();
    });
});
