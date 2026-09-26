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
     * (前段が居ないときの ADDRESS_HEADER の既定)。外から同じ名前を付けて来ても消えるので、
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
});

/*
 * **生で送るのは家の中からだけ。** 決めるのはサーバで、札を取ったときの住所を見る
 * (`auth.mayStreamRaw`。ライブを生で見る道、docs/stream.md §5.5)。`TRUSTED_NETWORKS` を全部開けていても、外の住所なら生にしない
 */
test.describe('生で送ってよい相手', () => {
    test('家の外の住所には、札で生を許さない', async ({ stack }) => {
        const open = await bootClosed(test.info().workerIndex, stack.root, {
            TRUSTED_NETWORKS: '0.0.0.0/0',
            ADDRESS_HEADER: 'x-forwarded-for',
        });
        try {
            const ask = async (from: string) => {
                const res = await fetch(`${open.appUrl}/api/live/ticket`, {
                    method: 'POST',
                    headers: { 'x-forwarded-for': from },
                });
                expect(res.status).toBe(200);
                return (await res.json()) as { ticket: string; raw: boolean };
            };
            expect((await ask('203.0.113.5')).raw).toBe(false);
            // VPN (CGNAT) で外から入ってきた住所も外とみなす
            expect((await ask('100.64.1.2')).raw).toBe(false);
            expect((await ask('192.168.1.10')).raw).toBe(true);
        } finally {
            await open.shutdown();
        }
    });
});
