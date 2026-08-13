import { describe, expect, test } from 'bun:test';
import { parseTargets } from './vlc';

describe('parseTargets', () => {
    test('名前=ホスト:ポート のカンマ区切りを読む', () => {
        expect(parseTargets('リビング=192.168.10.20:8080, 寝室=10.0.0.5:9000')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080' },
            { name: '寝室', host: '10.0.0.5:9000' },
        ]);
    });

    test('ポートを略したら VLC の既定 (8080)', () => {
        expect(parseTargets('リビング=192.168.10.20')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080' },
        ]);
    });

    test('名前を略したらホストがそのまま名前になる', () => {
        expect(parseTargets('192.168.10.20')).toEqual([
            { name: '192.168.10.20', host: '192.168.10.20:8080' },
        ]);
    });

    test('http:// を付けて貼っても剥がして読む', () => {
        expect(parseTargets('リビング=http://192.168.10.20:8080')).toEqual([
            { name: 'リビング', host: '192.168.10.20:8080' },
        ]);
    });

    test('空や崩れは黙って飛ばす', () => {
        expect(parseTargets('')).toEqual([]);
        expect(parseTargets(' , リビング= , =:')).toEqual([]);
    });
});
