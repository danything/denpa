import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { expect, goto, reserveSoon, syncEpg, test } from './helpers';

/**
 * エンコードの中止。
 *
 * **押したその場で行が変わること**を見る。中止を頼むだけで返していた頃は、
 * 押した直後の読み直しが ffmpeg の死ぬ前に届くので、**同じ「エンコード中 60.9%」が
 * そのまま出た** (実機、2026-09-10)。行が変わるのは畳み終わりの知らせ (SSE) が
 * 来たときで、その繋ぎが切れている端末では**リロードするまで永久に変わらない**。
 *
 * 「走っている最中」を作るために偽 ffmpeg を長引かせる (`stack.slowFile`)。
 */
test.describe('エンコードの中止', () => {
    test.afterAll(({ stack }) => {
        if (existsSync(stack.slowFile)) rmSync(stack.slowFile);
    });

    test('中止を押すと、その場で録画済みに戻る', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // ここから先のエンコードを長引かせる (中止を押す間を作る)
        writeFileSync(stack.slowFile, '1');
        const programId = await reserveSoon(page, request, 'BS');
        const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);

        // 焼き始めるまで待つ (行に「エンコード中」と進み具合が出る)
        await expect(async () => {
            await goto(page, '/');
            await expect(row.getByTestId('recording-state')).toHaveText('エンコード中', { timeout: 1_000 });
        }).toPass({ timeout: 120_000, intervals: [500] });
        await expect(row.getByTestId('encode-cancel')).toBeVisible();

        /*
         * **画面ではなくサーバの答えで見る。** 押した結果が返ってきた時点で
         * 畳み終わっていること自体を確かめたいので、知らせ (SSE) の届かない
         * 経路で押して、返ってきた直後の画面を読み直す
         */
        const jobId = await row.locator('input[name="id"]').inputValue();
        const res = await request.post('/?/cancelEncode', { form: { id: jobId } });
        expect(res.ok()).toBe(true);

        /*
         * **読み直しは1回だけ、待たない。** ここで待ってしまうと、直っていなくても
         * 畳み終わりの知らせが追いついて通ってしまう
         */
        await goto(page, '/');
        await expect(row.getByTestId('recording-state')).toHaveText('録画済み', { timeout: 1_000 });
        // 中止の口は消え、焼き直せる状態に戻っている
        await expect(row.getByTestId('encode-cancel')).toHaveCount(0);
    });
});
