import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configured, inNetwork, isFilePath, isOpenPath, trusted } from './auth';
import { config } from './config';

/**
 * どの口をどう守るか。
 *
 * **プレイヤーが来る口は、期限付きの署名リンクで開ける。** 相手は
 * ログイン画面へのリダイレクトを扱えないので、ここを OIDC にすると再生できなくなる。
 */
describe('ファイルを取りに来る口', () => {
    test('録画の配信', () => {
        expect(isFilePath('/api/recordings/12/file')).toBe(true);
    });

    test('画面と、それ以外の API は含まない', () => {
        expect(isFilePath('/')).toBe(false);
        expect(isFilePath('/settings')).toBe(false);
        // 同じ録画でも、コマの切り出しは画面から呼ぶもの
        expect(isFilePath('/api/recordings/12/frame')).toBe(false);
        // 似ているだけの道。前方一致で緩めない
        expect(isFilePath('/api/recordings/12/file/extra')).toBe(false);
    });
});

/**
 * ログインの入口。**ここを守ると入れなくなる** (ログイン画面へ行くのに
 * ログインが要る、という輪になる)。
 */
describe('素通しにする口', () => {
    test('ログインとログアウト', () => {
        expect(isOpenPath('/login')).toBe(true);
        expect(isOpenPath('/login/callback')).toBe(true);
        expect(isOpenPath('/login/out')).toBe(true);
        expect(isOpenPath('/logout')).toBe(true);
    });

    /*
     * **生死確認。** Kubernetes の livenessProbe が叩く。守ると Pod が
     * 再起動を繰り返す — 掛ける範囲を選べるのをやめたときに実際に踏んだ
     */
    test('生死確認', () => {
        expect(isOpenPath('/api/health')).toBe(true);
    });

    /*
     * **マニフェスト。** ブラウザは資格情報を付けずに取りに行くので、守ると
     * ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
     * hooks より手前で返していて、そもそも掛かっていなかった
     */
    test('PWA のマニフェスト', () => {
        expect(isOpenPath('/manifest.webmanifest')).toBe(true);
    });

    test('似た名前は素通しにしない', () => {
        expect(isOpenPath('/loginx')).toBe(false);
        expect(isOpenPath('/logoutx')).toBe(false);
        expect(isOpenPath('/api/healthz')).toBe(false);
        expect(isOpenPath('/manifest.webmanifest.map')).toBe(false);
        expect(isOpenPath('/')).toBe(false);
    });
});

/**
 * **入る道が1つも無ければ、全部断る** (fail-closed)。OIDC はこのテストでは
 * 設定していないので、TRUSTED_NETWORKS の有無がそのまま答えになる。
 */
describe('入る道が設定してあるか', () => {
    const original = config.trustedNetworks;
    afterEach(() => {
        config.trustedNetworks = original;
    });

    test('TRUSTED_NETWORKS があれば設定済み', () => {
        config.trustedNetworks = '10.10.0.0/16';
        expect(configured()).toBe(true);
    });

    test('何も無ければ未設定 (全部断る)', () => {
        config.trustedNetworks = '';
        expect(configured()).toBe(false);
    });
});

/**
 * **何も聞かずに通す相手。** 家の中のプレイヤーやテレビに資格情報を
 * 入れずに使わせるためのもの。ここに当たると OIDC も掛からない。
 *
 * 見るのは住所だけ。どの名前で来たかは問わない (名前で分けるのは前段の仕事)。
 */
describe('ネットワークの中なら素通しにする', () => {
    const original = config.trustedNetworks;
    beforeEach(() => {
        config.trustedNetworks = '10.10.0.0/16';
    });
    afterEach(() => {
        config.trustedNetworks = original;
    });

    test('ネットワークの中なら通す', () => {
        expect(trusted('10.10.5.9')).toBe(true);
    });

    test('ネットワークの外は通さない', () => {
        expect(trusted('203.0.113.9')).toBe(false);
    });

    test('住所が読めなければ通さない', () => {
        // `clientAddress` は読めないとき空文字を返す。閉じる側に倒す
        expect(trusted('')).toBe(false);
    });

    test('何も書かなければ誰も通さない', () => {
        config.trustedNetworks = '';
        expect(trusted('10.10.5.9')).toBe(false);
    });

    test('いくつでも並べられる', () => {
        config.trustedNetworks = '10.10.0.0/16, 10.20.0.0/16, 192.168.1.5';
        expect(trusted('10.10.1.1')).toBe(true);
        expect(trusted('10.20.1.1')).toBe(true);
        // CIDR でなく住所そのままでも書ける
        expect(trusted('192.168.1.5')).toBe(true);
        expect(trusted('192.168.1.6')).toBe(false);
    });
});

describe('住所がネットワークの中か', () => {
    test('CIDR の中と外', () => {
        expect(inNetwork('10.10.0.1', '10.10.0.0/16')).toBe(true);
        expect(inNetwork('10.10.255.254', '10.10.0.0/16')).toBe(true);
        // 隣の /16。1ビット違いを通してしまわないこと
        expect(inNetwork('10.11.0.1', '10.10.0.0/16')).toBe(false);
        expect(inNetwork('10.9.255.255', '10.10.0.0/16')).toBe(false);
    });

    test('境界の長さ', () => {
        expect(inNetwork('192.168.1.5', '192.168.1.5/32')).toBe(true);
        expect(inNetwork('192.168.1.6', '192.168.1.5/32')).toBe(false);
        // /0 は全部。書いた人がそう書いたなら通す
        expect(inNetwork('8.8.8.8', '0.0.0.0/0')).toBe(true);
    });

    test('長さを書かなければ1台だけ', () => {
        expect(inNetwork('10.0.0.1', '10.0.0.1')).toBe(true);
        expect(inNetwork('10.0.0.2', '10.0.0.1')).toBe(false);
    });

    /*
     * IPv4 の住所が IPv6 の形で届くことがある。素で比べると
     * `::ffff:10.10.0.1` が `10.10.0.0/16` に当たらず、LAN から入れなくなる
     */
    test('IPv6 に包まれた IPv4 も解く', () => {
        expect(inNetwork('::ffff:10.10.0.1', '10.10.0.0/16')).toBe(true);
        expect(inNetwork('::FFFF:10.11.0.1', '10.10.0.0/16')).toBe(false);
    });

    test('IPv6 は書いたとおりに一致したときだけ', () => {
        expect(inNetwork('fd00::1', 'fd00::1')).toBe(true);
        expect(inNetwork('fd00::2', 'fd00::1')).toBe(false);
        expect(inNetwork('fd00::1', 'fd00::/8')).toBe(false);
    });

    test('壊れた指定では通さない', () => {
        expect(inNetwork('10.0.0.1', '10.0.0.0/33')).toBe(false);
        expect(inNetwork('10.0.0.1', '10.0.0.0/-1')).toBe(false);
        expect(inNetwork('10.0.0.1', '10.0.0.0/abc')).toBe(false);
        expect(inNetwork('10.0.0.1', '')).toBe(false);
        // 桁が溢れているもの。数として読めても住所ではない
        expect(inNetwork('10.0.0.1', '10.0.0.256/24')).toBe(false);
    });
});
