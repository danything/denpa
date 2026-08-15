import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, goto, reserveSoon, setRecording, syncEpg, test, waitWatchable } from './helpers';

/**
 * GPU で焼く (server/hwenc.ts)。
 *
 * **GPU は偽物** — `stack.hwFile` を置くと denpa にはデバイスとして見え、偽 ffmpeg は
 * QSV / VA-API の試し焼きを通す。消せば、焼こうとした GPU の道が本物と同じく
 * 初期化で落ちる (ソフトウェアへ倒れる道を試せる)
 */

/**
 * 焼くときに偽 ffmpeg へ渡された引数、1回ぶんずつ。**書き途中の名前 (`.encoding`) へ
 * 出しているものだけ** — サムネイルなど、同じ道を通る他の呼び出しは省く
 */
function encodeRuns(file: string): string[][] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
        .split('---\n')
        .filter((run) => run.trim() !== '')
        .map((run) => run.split('\n'))
        .filter((run) => run.some((a) => a.endsWith('.encoding')));
}

test.describe('GPU で焼く', () => {
    test.afterAll(async ({ stack, request }) => {
        rmSync(stack.hwFile, { force: true });
        await setRecording(request);
        // 次に GPU を見る人が「無い」から始められるように
        await request.post('/settings?/probeHw', { form: {} });
    });

    test('見つかった GPU には自動で印が付き、外した印は残る', async ({ page, stack }) => {
        rmSync(stack.hwFile, { force: true });
        await goto(page, '/settings');
        // GPU が無ければ、印は触れず・付いていない
        await page.getByTestId('hw-probe').click();
        await expect(page.getByTestId('hw-status')).toContainText('GPU が見えません');
        for (const id of ['hw-qsv-av1', 'hw-qsv-h264', 'hw-vaapi-av1', 'hw-vaapi-h264']) {
            await expect(page.getByTestId(id)).toBeDisabled();
            await expect(page.getByTestId(id)).not.toBeChecked();
        }

        // 挿した → 確かめ直すと、4つとも使えて、勝手に印が付く
        writeFileSync(stack.hwFile, '1');
        await page.getByTestId('hw-probe').click();
        await expect(page.getByTestId('hw-status')).toContainText('GPU で焼けます');
        for (const id of ['hw-qsv-av1', 'hw-qsv-h264', 'hw-vaapi-av1', 'hw-vaapi-h264']) {
            await expect(page.getByTestId(id)).toBeEnabled();
            await expect(page.getByTestId(id)).toBeChecked();
        }

        // 外して保存すれば、外れたまま。ほかは付いたまま
        await page.getByTestId('hw-qsv-av1').uncheck();
        await page.getByTestId('save-recording').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
        await goto(page, '/settings');
        await expect(page.getByTestId('hw-qsv-av1')).not.toBeChecked();
        await expect(page.getByTestId('hw-qsv-h264')).toBeChecked();
        await expect(page.getByTestId('hw-vaapi-av1')).toBeChecked();
    });

    test('印の付いた道で焼き、落ちたら次の道へ倒れる', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        // QSV の AV1 だけ外す → AV1 は VA-API で焼く。H.264 は QSV
        writeFileSync(stack.hwFile, '1');
        await request.post('/settings?/probeHw', { form: {} });
        rmSync(stack.encodeArgsFile, { force: true });
        await setRecording(request, { codecs: ['av1', 'h264'], hw: { qsv: ['h264'] } });

        let programId = await reserveSoon(page, request, 'BS');
        let row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await waitWatchable(page, row);
        // 焼いたのは2本、どちらも GPU。AV1 は VA-API (QSV は外した)、H.264 は QSV
        const runs = encodeRuns(stack.encodeArgsFile);
        expect(runs.map((run) => run.find((a) => /_(qsv|vaapi)$/.test(a)))).toEqual([
            'av1_vaapi',
            'h264_qsv',
        ]);

        /*
         * **GPU が途中で駄目になっても録画は失敗にならない。** 抜いてから
         * (確かめ直さずに) 焼かせると、GPU の道が初期化で落ちて、ソフトウェアで
         * 焼き直される。試す順は 道ごとに 2回 (頭を捨てる分) → 次
         */
        rmSync(stack.hwFile, { force: true });
        rmSync(stack.encodeArgsFile, { force: true });
        await setRecording(request, { codecs: ['h264'], hw: { qsv: ['h264'] } });
        programId = await reserveSoon(page, request, 'BS', 1);
        row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await waitWatchable(page, row);
        const fallen = encodeRuns(stack.encodeArgsFile).map(
            (run) => run.find((a) => /_(qsv|vaapi)$/.test(a) || a === 'libx264') ?? '?',
        );
        expect(fallen).toEqual(['h264_qsv', 'h264_qsv', 'h264_vaapi', 'h264_vaapi', 'libx264']);
    });
});
