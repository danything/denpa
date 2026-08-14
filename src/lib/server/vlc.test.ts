import { describe, expect, test } from 'bun:test';
import { parseTargets, serializeTargets } from './vlc';

describe('parseTargets', () => {
    test('名前=ホスト:ポート のカンマ区切りを読む', () => {
        expect(parseTargets('リビング=192.168.10.20:8080, 寝室=10.0.0.5:9000')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080', codec: 'auto' },
            { name: '寝室', host: '10.0.0.5:9000', codec: 'auto' },
        ]);
    });

    test('ポートを略したら VLC の既定 (8080)', () => {
        expect(parseTargets('リビング=192.168.10.20')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080', codec: 'auto' },
        ]);
    });

    test('名前を略したらホスト (ポート込みに整えた形) がそのまま名前になる', () => {
        // 名前がホストと同じ = 無名の印 (設定の画面は名前の欄を空で出す)
        expect(parseTargets('192.168.10.20')).toEqual([
            { name: '192.168.10.20:8080', host: '192.168.10.20:8080', codec: 'auto' },
        ]);
    });

    test('#コーデック が付いていたら読む (名前を略した形でも)', () => {
        expect(parseTargets('リビング=192.168.10.20:8080#h264, 10.0.0.5#ts')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080', codec: 'h264' },
            { name: '10.0.0.5:8080', host: '10.0.0.5:8080', codec: 'ts' },
        ]);
    });

    test('知らないコーデックはおまかせに落とす', () => {
        expect(parseTargets('192.168.10.20#mpeg2')).toEqual([
            { name: '192.168.10.20:8080', host: '192.168.10.20:8080', codec: 'auto' },
        ]);
    });

    test('http:// を付けて貼っても剥がして読む', () => {
        expect(parseTargets('リビング=http://192.168.10.20:8080')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080', codec: 'auto' },
        ]);
    });

    test('空や崩れは黙って飛ばす', () => {
        expect(parseTargets('')).toEqual([]);
        expect(parseTargets(' , リビング= , =:, #h264')).toEqual([]);
    });
});

describe('serializeTargets', () => {
    test('parseTargets と往復して同じになる', () => {
        const list = [
            { name: 'リビング', host: '192.168.10.20:8080', codec: 'h264' as const },
            { name: '10.0.0.5:9000', host: '10.0.0.5:9000', codec: 'auto' as const },
            { name: '寝室', host: '10.0.0.6:9000', codec: 'ts' as const },
        ];
        expect(parseTargets(serializeTargets(list))).toEqual(list);
    });

    test('名前がホストと同じ (付けていない) とおまかせは書かない', () => {
        expect(
            serializeTargets([{ name: '192.168.1.99:8080', host: '192.168.1.99:8080', codec: 'auto' }]),
        ).toBe('192.168.1.99:8080');
    });
});
