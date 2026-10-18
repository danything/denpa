import { rmSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, goto, pickCodec, recordOne, reserveSoon, syncEpg, test, wakeControls } from './helpers';

/**
 * **観る画面で、サーバがその場で流すものを観る** (`api/recordings/<id>/playback`・`stream`。
 * 選び方は `ts/playback.ts`、受け方は `remux-player.ts`)。
 *
 * 偽 ffmpeg は映像を作らないので、映像が出るところまでは見ない。見るのは**何をリクエストするか** —
 * どの形式を・どの位置から・どの音声でリクエストし、飛んだらリクエストし直し、混んでいると言われたら勧め直すか
 */

/** リクエストした `stream` の URL を順に控える */
function streamRequests(page: Page): URL[] {
    const seen: URL[] = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (/\/api\/recordings\/\d+\/stream$/.test(url.pathname)) seen.push(url);
    });
    return seen;
}

test.describe('観る画面でその場で流す', () => {
    test.afterAll(({ stack }) => {
        rmSync(stack.failFile, { force: true });
    });

    /**
     * **録り終えてエンコードできていない録画も観る画面で観る** (追っかけは録っている最中だけ)。
     * サーバが元の TS をその場で変換して流す。字幕は元の TS から抜き、データ放送は出さない
     * (エンコード済みの時刻で書いてあるため)
     */
    test('エンコードできていない録画は観る画面で開き、元の TS を変換させて流す', async ({
        page,
        request,
        stack,
    }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        writeFileSync(stack.failFile, '1');
        const programId = await reserveSoon(page, request, 'BS');
        const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await expect(async () => {
            await goto(page, '/');
            await expect(row.getByTestId('recording-state')).toHaveText('エンコード失敗', { timeout: 1_000 });
        }).toPass({ timeout: 120_000, intervals: [500] });
        rmSync(stack.failFile, { force: true });

        const id = await row.getAttribute('data-recording-id');
        const asked = streamRequests(page);
        await expect(row.getByTestId('play-hint')).toBeVisible();
        await row.click();
        await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));

        // 頭から、端末が受け取れる形式で (Playwright の Chromium は H.264 を持たないので AV1 のことがある)
        await expect.poll(() => asked.length).toBeGreaterThan(0);
        expect(asked[0]?.searchParams.get('codec')).toMatch(/^(h264|av1)$/);
        expect(asked[0]?.searchParams.get('from')).toBe('0.000');
        // ファイルそのままは渡さない (元の TS はブラウザで読めない)
        await expect(page.getByTestId('watch-video')).not.toHaveAttribute('src', /file/);

        // 字幕は元の TS から (偽 ffmpeg は作り置きの字幕を返す)。データ放送は出さない
        await expect(page.getByTestId('watch-captions')).toHaveCount(1);
        await expect(page.getByTestId('watch-data')).toHaveCount(0);
    });

    /**
     * **コーデックを選べる** (この端末で観られる方式が2つ以上あるとき)。エンコード済みと違うものを選ぶと
     * サーバに変換させて流す。選んだものは端末ごとに覚え、続きの位置からリクエストする。
     * サーバが混んでいると言えば、変換させずに観られるものを勧める。
     *
     * 何で観られるかはここで決めて渡す (H.264 のエンコード済みと、AV1 への変換)。Playwright の
     * Chromium は H.264 を持たないので、H.264 のファイルは読めることにする
     */
    test('エンコード済みと違うコーデックを選ぶと、続きの位置から変換させて流す', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);
        await page.addInitScript(() => {
            const real = HTMLMediaElement.prototype.canPlayType;
            HTMLMediaElement.prototype.canPlayType = function (type: string) {
                return type.includes('avc1') ? 'probably' : real.call(this, type);
            };
        });
        await page.route(`**/api/recordings/${id}/playback`, (route) =>
            route.fulfill({
                json: {
                    duration: 1800,
                    axis: 'encoded',
                    audios: [
                        { id: '0', label: '主音声' },
                        { id: '1', label: '副音声' },
                    ],
                    offers: [
                        { codec: 'h264', way: 'file', source: 'encoded', codecs: 'avc1.640028,opus' },
                        { codec: 'h264', way: 'stream', codecs: 'avc1.640028,mp4a.40.2' },
                        { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
                    ],
                },
            }),
        );
        let busy = false;
        await page.route(`**/api/recordings/${id}/stream?**`, (route) =>
            busy
                ? route.fulfill({ status: 503, json: { message: 'サーバが混んでいます' } })
                : route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }),
        );
        // 続きの位置 (10 分)
        expect(
            (await request.post(`/api/recordings/${id}/resume`, { data: { at: 600, length: 1800 } })).ok(),
        ).toBe(true);

        await goto(page, `/watch/${id}`);
        expect(
            await page.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08,opus"')),
            'Chromium の MSE が AV1 を受け取れること',
        ).toBe(true);
        // 自動ではエンコード済みのファイルそのまま
        const video = page.getByTestId('watch-video');
        await expect(video).toHaveAttribute('src', `/api/recordings/${id}/file?source=encoded`);

        const asked = streamRequests(page);
        await wakeControls(page, 'watch-stage');
        await pickCodec(page, 'watch', 'av1');
        await expect.poll(() => asked.length).toBeGreaterThan(0);
        expect(asked[0]?.searchParams.get('codec')).toBe('av1');
        expect(asked[0]?.searchParams.get('audio')).toBe('0');
        await expect(page.getByTestId('watch-codec')).toContainText('AV1');

        // 選んだものは端末ごとに覚える。開き直すと、はじめから変換させて続きの位置からリクエストする
        const reopened = streamRequests(page);
        await goto(page, `/watch/${id}`);
        await expect.poll(() => reopened.length).toBeGreaterThan(0);
        expect(reopened[0]?.searchParams.get('codec')).toBe('av1');
        expect(reopened[0]?.searchParams.get('from')).toBe('600.000');

        /*
         * 飛んだ先からのリクエストし直しは `remux-player.test.ts` が見ている (偽のストリームは中身が空で、
         * 尺が分からないうちは `<video>` が位置を受け付けない)
         *
         * 混んでいると言われたら、変換させずに観られるもの (H.264 のファイル) を勧める
         */
        busy = true;
        await goto(page, `/watch/${id}`);
        const note = page.getByTestId('watch-busy');
        await expect(note).toContainText('サーバが混んでいます');
        await note.getByTestId('watch-busy-switch').click();
        await expect(note).toHaveCount(0);
        await expect(video).toHaveAttribute('src', `/api/recordings/${id}/file?source=encoded`);
        await expect(page.getByTestId('watch-codec')).toContainText('H.264');
    });
});
