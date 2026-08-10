import { describe, expect, test } from 'bun:test';
import { allowed, isPublicAddress, Refused } from './bml-network';

/*
 * **危ないのは繋ぎ先ではなく、繋ぐ範囲。**
 *
 * データ放送の双方向は、放送局のサーバへ取りに行く口。局ごとのドメイン表は
 * 持たない (必ず古くなる) 代わりに、**denpa のサーバが内側へ繋がないこと**を
 * ここで固定する ([bml-network.ts](bml-network.ts))。
 */

describe('繋いでよい住所か', () => {
    test('公開のものは通す', () => {
        for (const address of ['1.1.1.1', '203.0.113.9', '2400:2410::1', '8.8.8.8']) {
            expect(isPublicAddress(address)).toBe(true);
        }
    });

    test('内側は断る', () => {
        for (const address of [
            '127.0.0.1', // ループバック
            '10.0.0.5', // 私設
            '172.16.0.1', // 私設
            '172.31.255.254', // 私設 (端)
            '192.168.1.1', // 私設
            '169.254.169.254', // リンクローカル。雲のメタデータもここ
            '100.64.0.1', // 事業者内 (CGNAT)
            '0.0.0.0',
            '224.0.0.1', // 多重放送
            '::1',
            'fe80::1', // リンクローカル
            'fd00::1', // ユニークローカル
        ]) {
            expect(isPublicAddress(address), address).toBe(false);
        }
    });

    /*
     * **`::ffff:` は剥がしてから見る。** 被せただけの IPv4 なので、
     * 綴りのまま見ると「IPv6 だから通す」で素通りする
     */
    test('IPv4 を被せた IPv6 も剥がして見る', () => {
        expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
        expect(isPublicAddress('::ffff:10.1.2.3')).toBe(false);
        expect(isPublicAddress('::ffff:1.1.1.1')).toBe(true);
    });

    test('172 は 16〜31 だけが私設', () => {
        expect(isPublicAddress('172.15.0.1')).toBe(true);
        expect(isPublicAddress('172.32.0.1')).toBe(true);
    });
});

describe('取りに行ってよい URL か', () => {
    test('https でなければ断る', async () => {
        expect(allowed('http://example.com/x')).rejects.toThrow(Refused);
        // 別の仕組みへ逃がす道も塞ぐ
        expect(allowed('file:///etc/passwd')).rejects.toThrow(Refused);
        expect(allowed('ftp://example.com/x')).rejects.toThrow(Refused);
    });

    test('URL として読めなければ断る', async () => {
        expect(allowed('nhk.or.jp/data')).rejects.toThrow(Refused);
        expect(allowed('')).rejects.toThrow(Refused);
    });

    /*
     * **名前ではなく引いた先で見る。** `localhost` は名前で弾けるが、
     * 内側を指す公開の名前は綴りでは見分けが付かない
     */
    test('内側を指す名前は断る', async () => {
        expect(allowed('https://localhost/x')).rejects.toThrow(Refused);
    });
});
