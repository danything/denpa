import { bootClosed } from '../stack';
import { expect, test } from './helpers';

/**
 * 誰を通すか (docs/auth.md)。
 *
 * ベーシック認証は廃止した。入る道は **OIDC / TRUSTED_NETWORKS /
 * 期限付きの署名リンク (ファイルの口だけ)** で、どれも設定していなければ
 * **全部断る**。普段のスタックはローカルを信頼したネットワーク (`TRUSTED_NETWORKS=127.0.0.1`)
 * にしてあるので、「何も設定していない」ほうは別の口 (`bootClosed`) で確かめる。
 */
test.describe('信頼したネットワークから来たとき', () => {
    test('何も聞かずに通る', async ({ anonymous }) => {
        // ローカルからの素の fetch = 信頼したネットワークから来た人
        const res = await anonymous('/');
        expect(res.status).toBe(200);
    });
});

test.describe('入る道を何も設定していないとき', () => {
    test('全部断り、生死確認とマニフェストだけ通す', async ({ stack }) => {
        const closed = await bootClosed(test.info().workerIndex, stack.root);
        try {
            // 画面もファイルの口も断る。理由は本文に書いてある (謎の403にしない)
            const screen = await fetch(`${closed.appUrl}/`);
            expect(screen.status).toBe(403);
            expect(await screen.text()).toContain('TRUSTED_NETWORKS');

            const file = await fetch(`${closed.appUrl}/api/recordings/1/file`);
            expect(file.status).toBe(403);

            /*
             * **生死確認だけは通す。** ここを守ると Kubernetes の livenessProbe が
             * 落ち、Pod が再起動を繰り返す (この E2E のスタックも起動待ちで固まった)
             */
            const health = await fetch(`${closed.appUrl}/api/health`);
            expect(health.status).toBe(200);
            expect((await health.json()).ok).toBe(true);

            // ホーム画面に置くためのマニフェストも素通し (資格情報なしで取りに来る)
            const manifest = await fetch(`${closed.appUrl}/manifest.webmanifest`);
            expect(manifest.status).toBe(200);
        } finally {
            await closed.shutdown();
        }
    });
});

test.describe('接続元の住所', () => {
    /*
     * server.js の中継は、本当の接続元を `x-denpa-remote` に**上書きで**入れて内側へ渡す
     * (adapter-node は常にそれを読む)。外から同じ名前を付けて来ても消えるので、
     * ヘッダを書くだけで信頼したネットワークを名乗ることはできない
     */
    test('外から x-denpa-remote を付けても、信頼したネットワークは名乗れない', async ({ stack }) => {
        const closed = await bootClosed(test.info().workerIndex, stack.root, {
            TRUSTED_NETWORKS: '10.10.0.0/16',
        });
        try {
            const spoofed = await fetch(`${closed.appUrl}/`, { headers: { 'x-denpa-remote': '10.10.5.9' } });
            expect(spoofed.status).toBe(403);
        } finally {
            await closed.shutdown();
        }
    });

    /*
     * `X-Forwarded-For` は、直の相手が `TRUSTED_PROXIES` に入っているときだけ読む。
     * テストの相手は 127.0.0.1 なので、入れていなければ付けても効かない
     */
    test('前段と認めていない相手の x-forwarded-for は読まない', async ({ stack }) => {
        const closed = await bootClosed(test.info().workerIndex, stack.root, {
            TRUSTED_NETWORKS: '10.10.0.0/16',
            // 前の版の設定が残っていても読まない (起動時に知らせるだけ)
            ADDRESS_HEADER: 'x-forwarded-for',
        });
        try {
            const spoofed = await fetch(`${closed.appUrl}/`, { headers: { 'x-forwarded-for': '10.10.5.9' } });
            expect(spoofed.status).toBe(403);
        } finally {
            await closed.shutdown();
        }
    });

    test('前段と認めた相手なら、x-forwarded-for を右から辿る', async ({ stack }) => {
        const closed = await bootClosed(test.info().workerIndex, stack.root, {
            TRUSTED_NETWORKS: '10.10.0.0/16',
            TRUSTED_PROXIES: '127.0.0.1,10.42.0.0/16',
        });
        try {
            // 2段目の前段 (10.42.0.7) を飛ばして、その左が接続元
            const inside = await fetch(`${closed.appUrl}/`, {
                headers: { 'x-forwarded-for': '10.10.5.9, 10.42.0.7' },
            });
            // 通ったことだけ見る (断られれば 403。画面の中身はここでは問わない)
            expect(inside.status).not.toBe(403);
            // 客が左に偽の住所を足して来ても、前段が足した右端 (本当の相手) を使う
            const spoofed = await fetch(`${closed.appUrl}/`, {
                headers: { 'x-forwarded-for': '10.10.5.9, 203.0.113.9' },
            });
            expect(spoofed.status).toBe(403);
        } finally {
            await closed.shutdown();
        }
    });
});
