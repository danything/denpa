import { expect, goto, test } from './helpers';

const CREDENTIALS = { username: 'denpa', password: 'ひみつ' };

/**
 * 録画の配信の守り。
 *
 * プレイヤーは、画面の前段に置くリダイレクト型の認証を扱えない。
 * ファイルを取りに来る口はベーシック認証で守る。
 *
 * **掛かる範囲は選べない。** 以前は「配信だけ / 画面も含めて全部」を
 * 選べたが、既定のままだと画面が誰にでも開き、しかも再生リンクのURLに
 * パスワードが埋まっているので、画面を開ければ全部見えていた。
 */
test.describe('資格情報が無いとき', () => {
    test('画面も断る', async ({ anonymous }) => {
        const res = await anonymous('/');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic');
    });

    test('ファイルの口も断る', async ({ anonymous }) => {
        const res = await anonymous('/api/recordings/1/file');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic');
    });

    /*
     * **生死確認だけは通す。** ここを守ると Kubernetes の livenessProbe が落ち、
     * Pod が再起動を繰り返す (この E2E のスタックも起動待ちで固まった)
     */
    test('生死確認は通す', async ({ anonymous }) => {
        const res = await anonymous('/api/health');
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
    });
});

test.describe('設定画面からの認証', () => {
    test.use({ httpCredentials: CREDENTIALS });

    test('設定画面から認証を変えられる', async ({ page }) => {
        await goto(page, '/settings');
        // ユーザー名は固定。入力欄そのものが無い
        await expect(page.getByTestId('auth-user')).toHaveText('denpa');
        /*
         * いま効いているパスワードをそのまま出す。プレイヤーに入れるときに要るものを
         * 隠していると、思い出せないたびに作り直すことになり、そのたびに
         * 登録済みの端末が全部つながらなくなる
         */
        await expect(page.getByTestId('auth-password')).toHaveValue('ひみつ');
        await expect(page.getByTestId('auth-password')).toHaveAttribute('type', 'password');
        await page.getByTestId('auth-reveal').click();
        await expect(page.getByTestId('auth-password')).toHaveAttribute('type', 'text');

        // 範囲は選ばせない。何が守られているかを書いて出すだけ
        await expect(page.getByTestId('auth-scope-note')).toBeVisible();
        await expect(page.getByTestId('auth-scope-note')).toContainText('まとめて守ります');
    });

    test('パスワードは空にできない', async ({ page }) => {
        // 空にすると録画のファイルが誰でも取れる状態になり、しかもそれが画面から分からない
        await goto(page, '/settings');
        await page.getByTestId('auth-password').fill('');
        await page.getByTestId('save-auth').click();
        await expect(page.getByText('パスワードは空にできません')).toBeVisible();

        // 効いているものは変わっていない
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-password')).toHaveValue('ひみつ');
    });

    /*
     * **作り直すと、その端末は締め出される。** 画面にもベーシック認証が掛かるので、
     * ブラウザが持っている古いほうでは次の読み込みから 401 になる。押した本人が
     * 新しいものを受け取れないので、作り直したぶんは**起動ログにも出している**。
     *
     * ここで押してしまうと後ろのテストが全部入れなくなるので、E2E では
     * 「入れたものが効く」ところまでを見る。作る中身そのものは単体試験
     * (`src/lib/server/auth.test.ts`) で押さえてある
     */
    test('入れたパスワードがその場で効く', async ({ page, anonymous, stack }) => {
        // btoa は Latin-1 しか受けない。日本語のパスワードは UTF-8 で組む
        const auth = (password: string) =>
            `Basic ${Buffer.from(`denpa:${password}`, 'utf8').toString('base64')}`;

        await goto(page, '/settings');
        await page.getByTestId('auth-password').fill('あたらしい');
        await page.getByTestId('save-auth').click();

        // 新しいほうで通り、古いほうでは通らない = 効いている
        await expect
            .poll(
                async () => (await anonymous('/', { headers: { authorization: auth('あたらしい') } })).status,
            )
            .toBe(200);
        expect((await anonymous('/', { headers: { authorization: auth('ひみつ') } })).status).toBe(401);

        // 後ろのテストのために戻す。ブラウザはもう入れないので直に投げる
        const restored = await anonymous('/settings?/saveAuth', {
            method: 'POST',
            headers: {
                authorization: auth('あたらしい'),
                origin: stack.appUrl,
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ basicAuthPassword: 'ひみつ' }),
        });
        expect(restored.status).toBeLessThan(400);
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-password')).toHaveValue('ひみつ');
    });
});
