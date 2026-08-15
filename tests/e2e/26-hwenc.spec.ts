import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, goto, reserveSoon, setRecording, syncEpg, test, waitWatchable } from './helpers';

/**
 * GPU で焼く (server/hwenc.ts)。
 *
 * **GPU は偽物** — `stack.hwDir` に `renderD128` のような名前でファイルを置くと
 * denpa には口として見え、偽 ffmpeg は渡された口が在るのを見て QSV / VA-API の
 * 試し焼きを通す。消せば、焼こうとした GPU の道が本物と同じく初期化で落ちる
 * (次の道・ソフトウェアへ倒れる道を試せる)
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

/** 1回ぶんの引数から「どの口を、何で焼いたか」。ソフトウェアなら口は無し */
function wayOf(run: string[]): string {
    const encoder = run.find((a) => /_(qsv|vaapi)$/.test(a) || a === 'libx264' || a === 'libsvtav1') ?? '?';
    const device = run.find((a) => a.startsWith('qsv=') || a.startsWith('vaapi='));
    const port = device
        ?.split(/child_device=|va:/)
        .at(-1)
        ?.split('/')
        .at(-1);
    return port === undefined ? encoder : `${port}:${encoder}`;
}

const GPUS = ['renderD128', 'renderD129'];
const IDS = ['qsv-av1', 'qsv-h264', 'vaapi-av1', 'vaapi-h264'];

test.describe('GPU で焼く', () => {
    const clearGpus = (dir: string) => {
        for (const name of readdirSync(dir)) rmSync(`${dir}/${name}`, { force: true });
    };
    test.afterAll(async ({ stack, request }) => {
        clearGpus(stack.hwDir);
        await setRecording(request);
        // 次に GPU を見る人が「無い」から始められるように
        await request.post('/settings?/probeHw', { form: {} });
    });

    test('見つかった GPU には口ごとに自動で印が付き、外した印は残る', async ({ page, stack }) => {
        clearGpus(stack.hwDir);
        await goto(page, '/settings');
        // GPU が無ければ、口の行も無い
        await page.getByTestId('hw-probe').click();
        await expect(page.getByTestId('hw-status')).toContainText('GPU が見えません');
        await expect(page.getByTestId('hw-device')).toHaveCount(0);

        // 2枚挿した → 確かめ直すと、口が2つ・どちらも4つとも使えて、勝手に印が付く
        for (const gpu of GPUS) writeFileSync(`${stack.hwDir}/${gpu}`, '1');
        await page.getByTestId('hw-probe').click();
        await expect(page.getByTestId('hw-status')).toContainText('2 口見つかり、2 口で GPU で焼けます');
        await expect(page.getByTestId('hw-device')).toHaveCount(2);
        for (const gpu of GPUS) {
            for (const id of IDS) {
                await expect(page.getByTestId(`hw-${gpu}-${id}`)).toBeEnabled();
                await expect(page.getByTestId(`hw-${gpu}-${id}`)).toBeChecked();
            }
        }

        // 口ごとに割り振る: 128 は AV1 だけ、129 は H.264 だけ (どちらも QSV/VA-API 両方)
        await page.getByTestId('hw-renderD128-qsv-h264').uncheck();
        await page.getByTestId('hw-renderD128-vaapi-h264').uncheck();
        await page.getByTestId('hw-renderD129-qsv-av1').uncheck();
        await page.getByTestId('hw-renderD129-vaapi-av1').uncheck();
        await page.getByTestId('hw-save').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
        await goto(page, '/settings');
        await expect(page.getByTestId('hw-renderD128-qsv-h264')).not.toBeChecked();
        await expect(page.getByTestId('hw-renderD128-qsv-av1')).toBeChecked();
        await expect(page.getByTestId('hw-renderD129-qsv-av1')).not.toBeChecked();
        await expect(page.getByTestId('hw-renderD129-vaapi-h264')).toBeChecked();
    });

    test('割り振った口で焼き、落ちたら次の道へ倒れる', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        // 上の割り振りのまま (128 = AV1、129 = H.264)
        for (const gpu of GPUS) writeFileSync(`${stack.hwDir}/${gpu}`, '1');
        await request.post('/settings?/probeHw', { form: {} });
        rmSync(stack.encodeArgsFile, { force: true });
        await setRecording(request, { codecs: ['av1', 'h264'] });

        let programId = await reserveSoon(page, request, 'BS');
        let row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await waitWatchable(page, row);
        // AV1 は 128 の QSV、H.264 は 129 の QSV (どちらも先頭の道で通る)
        expect(encodeRuns(stack.encodeArgsFile).map(wayOf)).toEqual([
            'renderD128:av1_qsv',
            'renderD129:h264_qsv',
        ]);

        /*
         * **GPU が途中で駄目になっても録画は失敗にならない。** 129 を抜いてから
         * (確かめ直さずに) H.264 を焼かせると、129 の道が初期化で落ちて、
         * ソフトウェアで焼き直される。試す順は 道ごとに 2回 (頭を捨てる分) → 次。
         * 128 は H.264 を外してあるので、そちらへは行かない
         */
        rmSync(`${stack.hwDir}/renderD129`, { force: true });
        rmSync(stack.encodeArgsFile, { force: true });
        await setRecording(request, { codecs: ['h264'] });
        programId = await reserveSoon(page, request, 'BS', 1);
        row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await waitWatchable(page, row);
        expect(encodeRuns(stack.encodeArgsFile).map(wayOf)).toEqual([
            'renderD129:h264_qsv',
            'renderD129:h264_qsv',
            'renderD129:h264_vaapi',
            'renderD129:h264_vaapi',
            'libx264',
        ]);
    });
});
