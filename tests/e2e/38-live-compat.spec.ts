import { rmSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { MX } from '../fake/services';
import { expect, goto, openSettings, pickCodec, syncEpg, test, wakeControls } from './helpers';

/**
 * **互換モード** — ライブの H.264 / AV1 も canvas に描く (`src/lib/canvas-video.ts`・`src/lib/raw/fmp4.ts`)。
 *
 * テスラの車載ブラウザは停車中でも `<video>` を止める。互換モードではエンコードしたもの (fMP4) を MSE に
 * 渡さず、放送のままの MPEG-2 と同じ worker でデコードして canvas に描く。ここは**描くところまで**見る —
 * 偽 ffmpeg に目印 (`stack.liveFmp4File`) を置くと、本物の H.264 + AAC・AV1 + Opus の fMP4 を流す
 * (`tests/fake/fmp4-loop.ts`)。映像は VideoDecoder が、音は WASM (`wasm/mpeg2`、28-live-raw と同じ
 * デコーダ。AAC は ADTS の頭を付けて、Opus は OpusHead で) がデコードする。
 *
 * H.264 は、走らせている Chromium の VideoDecoder がデコードできるときだけ描いて確かめる (デコードできなければ
 * 切り替えで選べないことを見る)。箱の読み方 (avcC・esds) は単体試験 (`ts/fmp4.test.ts`) が見る
 */

const TESLA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2026.32.1';

/** 選局して、AV1 にしておく (H.264 を描けない端末では、自分で AV1 に寄せている) */
async function watchAv1(page: Page): Promise<void> {
    await expect(page.getByTestId('live-title')).toBeVisible();
    await wakeControls(page, 'live-frame');
    await pickCodec(page, 'live', 'av1');
    await expect(page.getByTestId('live-codec')).toContainText('AV1');
}

/** canvas に描いて、音も鳴らしていること (数が進む・映像が変わる) */
async function expectDrawn(page: Page, prefix = 'live'): Promise<void> {
    const canvas = page.locator('[data-testid="live-raw"][data-input="fmp4"]');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const count = async (name: 'shown' | 'audio') => Number((await canvas.getAttribute(`data-${name}`)) ?? 0);
    await expect.poll(() => count('shown'), { timeout: 30_000 }).toBeGreaterThan(10);
    const first = await count('shown');
    await expect.poll(() => count('shown'), { timeout: 15_000 }).toBeGreaterThan(first + 10);
    // 音 (AAC・Opus) を WASM でデコードできている
    await expect.poll(() => count('audio'), { timeout: 15_000 }).toBeGreaterThan(0);
    // 映像が動いている (testsrc2 の模様が流れる)
    const one = await canvas.screenshot();
    await expect(async () => {
        expect((await canvas.screenshot()).equals(one)).toBe(false);
    }).toPass({ timeout: 10_000 });
    // **`<video>` では再生していない** (MSE を繋いでいない)
    const video = page.getByTestId(`${prefix}-video`);
    expect(await video.evaluate((v) => (v as HTMLVideoElement).currentSrc)).toBe('');
}

test.describe('互換モード', () => {
    test.beforeEach(async ({ request, stack }) => {
        await syncEpg(request);
        writeFileSync(stack.liveFmp4File, '');
    });
    test.afterEach(async ({ stack }) => {
        rmSync(stack.liveFmp4File, { force: true });
    });

    test('設定で入れると運転中の注意が出て、ライブを canvas に描く', async ({ page }) => {
        await goto(page, '/settings/general');
        const toggle = page.getByTestId('canvas-video-toggle');
        await expect(toggle).not.toBeChecked();
        // 使えるもの (この端末で描ける形式・テスラか) を出す
        const support = page.getByTestId('canvas-video-support');
        await expect(support).toContainText('AV1: 使えます');
        await expect(support).toContainText('テスラの車載ブラウザ: いいえ');

        // 取消なら入らない
        await toggle.click();
        const notice = page.getByTestId('drive-notice');
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('走行中は画面を見ないでください');
        // フォーカスは箱に置き (取消に枠が付かない)、Tab でボタンへ進む
        await expect(notice.locator('.modal-box')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.getByTestId('drive-notice-cancel')).toBeFocused();
        await page.getByTestId('drive-notice-cancel').click();
        await expect(notice).toBeHidden();
        await expect(toggle).not.toBeChecked();

        await toggle.click();
        await page.getByTestId('drive-notice-accept').click();
        await expect(notice).toBeHidden();
        await expect(toggle).toBeChecked();
        expect(await page.evaluate(() => localStorage.getItem('canvas-video'))).toBe('on');

        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        // 注意は設定で見せたので、ライブでは出さない
        await expect(page.getByTestId('drive-notice')).toBeHidden();

        const h264 = await page.evaluate(
            async () => (await VideoDecoder.isConfigSupported({ codec: 'avc1.640029' })).supported === true,
        );
        if (h264) {
            // 既定の H.264 をそのまま描く (AAC は ADTS の頭を付けて WASM へ)
            await expect(page.getByTestId('live-codec')).toContainText('H.264');
            await expectDrawn(page);
        } else {
            // 描けない形式は切り替えで選ばせない
            await wakeControls(page, 'live-frame');
            await openSettings(page, 'live');
            await page.getByTestId('live-codec').click();
            const option = page.locator('[data-testid="live-codec-option"][data-codec="h264"]');
            await expect(option).toHaveAttribute('data-disabled');
            await expect(option).toContainText('再生できません');
            await page.keyboard.press('Escape');
        }
        // AV1 (Opus は WASM)
        await watchAv1(page);
        await expectDrawn(page);

        // 止める・再開する (再開は放送の今から)
        const play = page.getByTestId('live-play');
        await wakeControls(page, 'live-frame');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '再生');
        await wakeControls(page, 'live-frame');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '一時停止');
        // 遡れないのでシークバーは出さない
        await expect(page.getByTestId('live-seek')).toHaveCount(0);
    });

    test.describe('テスラの車載ブラウザ', () => {
        test.use({ userAgent: TESLA });

        test('触らなくても入っていて、初めて再生する前に注意を出す。押すまで再生しない', async ({ page }) => {
            // 開けばサーバが決めた局 (一覧の先頭) をそのまま選局しに行く。その前に注意が出る
            await goto(page, '/live');
            const notice = page.getByTestId('drive-notice');
            await expect(notice).toBeVisible();
            // 再生の前では取消は出さない (押すまで待つ)
            await expect(page.getByTestId('drive-notice-cancel')).toHaveCount(0);
            await page.waitForTimeout(1_000);
            await expect(page.getByTestId('live-raw')).toHaveCount(0);
            await page.getByTestId('drive-notice-accept').click();
            await expect(notice).toBeHidden();
            expect(await page.evaluate(() => localStorage.getItem('canvas-drive-notice'))).toBe('1');

            await watchAv1(page);
            await expectDrawn(page);

            // 二度目からは出さない
            await goto(page, '/live');
            await expect(page.getByTestId('live-title')).toBeVisible();
            await expect(page.getByTestId('drive-notice')).toBeHidden();
            await expect(page.locator('[data-testid="live-raw"][data-input="fmp4"]')).toBeVisible({
                timeout: 30_000,
            });
        });

        test('設定で明示して切れば、テスラでも <video> で観る', async ({ page }) => {
            await goto(page, '/settings/general');
            const toggle = page.getByTestId('canvas-video-toggle');
            await expect(toggle).toBeChecked();
            await expect(page.getByTestId('canvas-video-support')).toContainText(
                'テスラの車載ブラウザ: はい',
            );
            await toggle.click();
            await expect(toggle).not.toBeChecked();
            expect(await page.evaluate(() => localStorage.getItem('canvas-video'))).toBe('off');

            await goto(page, '/live');
            await page.getByTestId('live-channel').first().click();
            await expect(page.getByTestId('live-title')).toBeVisible();
            // 注意も出さず、MSE に繋ぐ
            await expect(page.getByTestId('drive-notice')).toBeHidden();
            await expect
                .poll(
                    () => page.getByTestId('live-video').evaluate((v) => (v as HTMLVideoElement).currentSrc),
                    {
                        timeout: 15_000,
                    },
                )
                .toMatch(/^blob:/);
            await expect(page.getByTestId('live-raw')).toHaveCount(0);
        });
    });
});

test.describe('互換モードの追っかけ', () => {
    /** 録っている番組 (止めるのに使う) */
    let programId: number | null = null;
    test.beforeEach(async ({ request, stack }) => {
        await syncEpg(request);
        writeFileSync(stack.liveFmp4File, '');
    });
    test.afterEach(async ({ request, stack }) => {
        // 地上波の偽番組は30分あるので、止めないと次のテストまでチューナーを塞ぐ
        if (programId !== null) {
            await request.post('/guide?/cancel', { form: { programId: String(programId) } });
        }
        programId = null;
        rmSync(stack.liveFmp4File, { force: true });
        rmSync(stack.failFile, { force: true });
    });

    test('追っかけも canvas に描き、速さは出さず、止めた所から再開する', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        /*
         * **録っている最中に観る。** 追っかけは録っている最中だけで、録り終えた録画は観る画面へ送られる
         * (25-chase と同じく、地上波のいまの番組 (偽番組は30分) を録る)。エンコードは失敗させておく
         * (止めたあとエンコードできると元の TS が無くなり、リクエストし直しが断られる)
         */
        writeFileSync(stack.failFile, '1');
        // 入れてあり、注意も見せたことにしておく (出し方はライブのテストが見る)
        await page.addInitScript(() => {
            localStorage.setItem('canvas-video', 'on');
            localStorage.setItem('canvas-drive-notice', '1');
        });
        const services = (await (await request.get('/api/services')).json()) as {
            id: number;
            now: { id: number } | null;
        }[];
        programId = services.find((s) => s.id === MX.id)?.now?.id ?? null;
        expect(programId, `${MX.name} にいま放送中の番組が要る`).not.toBeNull();
        expect((await request.post('/live?/record', { form: { service: String(MX.id) } })).ok()).toBe(true);
        let id = 0;
        await expect(async () => {
            type Item = { id: number; recording: boolean };
            const list = (await (await request.get('/api/recordings')).json()) as Item[];
            id = list.find((rec) => rec.recording)?.id ?? 0;
            expect(id).toBeGreaterThan(0);
        }).toPass({ timeout: 120_000, intervals: [500] });

        await goto(page, `/chase/${id}`);
        await expect(page.getByTestId('chase-title')).toBeVisible();
        await wakeControls(page, 'chase');
        await pickCodec(page, 'chase', 'av1');
        await expectDrawn(page, 'chase');

        // 速さは等速だけ (切り替えを出さない)
        await wakeControls(page, 'chase');
        await expect(page.getByTestId('chase-speed')).toHaveCount(0);

        // 止めても映像は止めた所のまま。再開すると続きから描く (リクエストし直さない — プレイヤーはそのまま数え続ける)
        const canvas = page.locator('[data-testid="live-raw"][data-input="fmp4"]');
        const shown = async () => Number((await canvas.getAttribute('data-shown')) ?? 0);
        const play = page.getByTestId('chase-play');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '再生');
        const paused = await shown();
        await page.waitForTimeout(1_500);
        expect(await shown()).toBeLessThanOrEqual(paused + 2);
        await wakeControls(page, 'chase');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '一時停止');
        await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(paused + 10);

        /*
         * **リクエストし直したあとも再生位置が飛ばない。** シークバーを動かすと (溢れの読み直しと同じく) いまの位置から
         * リクエストし直す。新しいストリームの時刻は 0 から数え直しになるので、再生位置はサーバが返す頭 (`timeline`) +
         * 新しいストリームの中の秒になる。前のストリームの秒を足したまま先へ飛んでいないことを見る
         */
        // 再生位置は読みものの「m:ss / m:ss」の左 (シークバーの値は録れている長さで頭打ちになるので使わない)
        const status = page.getByTestId('chase-controls').getByText(/^\d+:\d\d \/ \d+:\d\d$/);
        const where = async () => {
            const text = (await status.textContent()) ?? '';
            const [m = 0, s = 0] = text.split(' / ')[0]!.split(':').map(Number);
            return m * 60 + s;
        };
        await expect.poll(where, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
        const before = await where();
        // シークバーを動かすのと同じ (`seekBy`)。頭へ戻す。押したボタンにフォーカスがあると矢印は効かない (`keys.ts`) ので外す
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('ArrowLeft');
        // リクエストした所へ戻り、そこから進む。3秒後も、前の再生位置より手前にある (前のストリームの秒を足していない)
        await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan((await shown()) + 30);
        await page.waitForTimeout(3_000);
        const after = await where();
        expect(after).toBeLessThan(before);
        await expect.poll(where, { timeout: 15_000 }).toBeGreaterThan(after);
    });
});
