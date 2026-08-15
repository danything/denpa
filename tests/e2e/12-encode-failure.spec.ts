import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { expect, goto, reserveSoon, syncEpg, test, waitRowState } from './helpers';

/**
 * エンコードが失敗したときの見え方と後始末。
 * 失敗の表示が消せないと、直したあとも延々と残って邪魔になる。
 */
test.describe('エンコードの失敗', () => {
    test.afterAll(({ stack }) => {
        if (existsSync(stack.failFile)) rmSync(stack.failFile);
    });

    test('失敗したエンコードは行の状態に出て、理由は詳細で見られる', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // ここから先のエンコードを失敗させる
        writeFileSync(stack.failFile, '1');

        await reserveSoon(page, request, 'BS');

        /*
         * 失敗したものは進み具合を出さない。行に残るのは状態だけ。
         *
         * 出るのは「エンコード失敗」であって「失敗」ではない。落ちたのは焼き直しの
         * ほうなので、録画そのものの状態 (録画済み) には手を付けない
         */
        await waitRowState(
            page,
            '/',
            page.locator('[data-testid="recording-row"]').first(),
            'エンコード失敗',
        );
        await goto(page, '/');
        await expect(page.getByTestId('encode-progress')).toHaveCount(0);
        const failed = page
            .getByTestId('recording-row')
            .filter({ has: page.getByTestId('recording-state').getByText('エンコード失敗') })
            .first();
        await expect(failed.getByTestId('recording-state')).toHaveText('エンコード失敗');

        /*
         * **観られる。** 焼けていなくても生TSは無事で、追っかけ再生の器 (/chase) が
         * サーバで焼き直して運ぶ (25-chase)。行には再生の印が出て、押すと追っかけへ。
         * 以前は「焼けていない = 観られない」で印を消していたが、生TSがある限り観られる
         */
        await expect(failed.getByTestId('play-hint')).toBeVisible();

        // 理由は行の「詳細」から。ffmpeg の出力は長いので一覧には貼らない
        // (観られる行は押すと再生に行くので、詳細は別のボタン)
        await failed.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        // 落とす口も詳細の中。生TSは無事なのでダウンロードできる
        await expect(detail.getByTestId('download-link')).toHaveCount(1);
        // 理由は1つだけ。録画そのものは失敗していないので、出るのはジョブ側の理由だけ
        const note = detail.getByTestId('detail-error');
        await expect(note).toHaveCount(1);
        await expect(note).toContainText('エンコードに失敗しました');
        await expect(note).toContainText('Error initializing the encoder');
        // 警告に埋もれず、止まった理由だけが出ていること
        await expect(note).not.toContainText('has not been used for any stream');
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);

        // 削除は2回押させる。1回目は聞き返すだけで、まだ消えない
        await failed.getByTestId('delete-button').click();
        await expect(failed.getByTestId('delete-confirm')).toBeVisible();
        await expect(failed).toHaveCount(1);

        /*
         * **他所を触ったら取り下げる。**
         *
         * 時間で戻すだけだと、間違えて押したことに気付いて別のところを触っても
         * まだ構えたままで、その数秒のうちに同じ場所をもう一度押すと消える
         */
        // 画面から出ない場所を触る (行を押すと再生・詳細に行ってしまう)
        await page.getByRole('heading', { name: '予約', exact: true }).click();
        await expect(failed.getByTestId('delete-confirm')).toHaveCount(0);
        await expect(failed.getByTestId('delete-button')).toBeVisible();

        await failed.getByTestId('delete-button').click();
        await expect(failed.getByTestId('delete-confirm')).toBeVisible();

        const id = await failed.getAttribute('data-recording-id');
        await failed.getByTestId('delete-confirm').click();
        await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);

        rmSync(stack.failFile);
    });
});
