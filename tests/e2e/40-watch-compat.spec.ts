import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { clipFrom, readClip } from '../fake/fmp4-clip';
import { expect, FAKE_CAPTION, goto, recordOne, setRecording, test, wakeControls } from './helpers';

/**
 * **互換モードで録画を観る** — 観る画面も `<video>` を使わず canvas に描く (`src/lib/canvas-player.ts`)。
 *
 * テスラの車載ブラウザは停車中でも `<video>` を止める。互換モードの観る画面は `/stream` を fetch で
 * 読んで、ライブ・追っかけと同じ器 (`raw/engine.ts`) へ流す。ここは**描くところまで**見る:
 *
 * - 本物のストリーム (偽 ffmpeg が作り置きの fMP4 を出す `fmp4-out.ts` と、偽の放送の MPEG-2 をそのまま) を描く。
 *   元の TS は `X-Denpa-Origin` で物差しに直す
 * - 飛ぶ・CM 飛ばし・字幕・止めて再開は、長い録画のふりをして見る (`playback` を差し替え、`stream` は
 *   作り置きの fMP4 を頼まれた位置から並べて返す。`fmp4-clip.ts`)
 *
 * 映像は AV1 で見る (Playwright の Chromium の VideoDecoder は H.264 をデコードできないことがある。38-live-compat と同じ)
 */

/** 頼んだ `stream` の URL を順に控える */
function streamRequests(page: Page): URL[] {
    const seen: URL[] = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (/\/api\/recordings\/\d+\/stream$/.test(url.pathname)) seen.push(url);
    });
    return seen;
}

/** 互換モードを入れて、運転中の注意も見せたことにしておく (出し方はライブのテストが見る) */
async function compatOn(page: Page): Promise<void> {
    await page.addInitScript(() => {
        localStorage.setItem('canvas-video', 'on');
        localStorage.setItem('canvas-drive-notice', '1');
    });
}

/** canvas に描いて、音もデコードできていること (数が進む)。**`<video>` は空** */
async function expectDrawn(page: Page, input: 'fmp4' | 'ts-mpeg2'): Promise<void> {
    const canvas = page.locator(`[data-testid="live-raw"][data-input="${input}"]`);
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const count = async (name: 'shown' | 'audio') => Number((await canvas.getAttribute(`data-${name}`)) ?? 0);
    await expect.poll(() => count('shown'), { timeout: 30_000 }).toBeGreaterThan(5);
    await expect.poll(() => count('audio'), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('watch-video').evaluate((v) => (v as HTMLVideoElement).currentSrc)).toBe(
        '',
    );
}

/** 操作バーの「m:ss / m:ss」の左 (いまの位置。秒) */
async function where(page: Page): Promise<number> {
    const text = (await page.getByTestId('watch-clock').textContent()) ?? '';
    const parts = text.split(' / ')[0]!.trim().split(':').map(Number);
    return parts.reduce((sum, part) => sum * 60 + part, 0);
}

test.describe('互換モードの観る画面', () => {
    test.afterEach(({ stack }) => {
        rmSync(stack.liveFmp4File, { force: true });
    });
    test.afterAll(async ({ request }) => {
        await setRecording(request, {});
    });

    test('録画を canvas に描き、MPEG-2 は元の TS の時刻を物差しに直す', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        // エンコードしない録画 (元の TS だけ)。H.264 / AV1 は変換、MPEG-2 はそのまま流せる
        await setRecording(request, { codecs: [] });
        const { id } = await recordOne(page, request);
        writeFileSync(stack.liveFmp4File, '');
        await compatOn(page);
        const asked = streamRequests(page);

        await goto(page, `/watch/${id}`);
        // 変換させたもの (fMP4) を描く。`<video>` には流さない
        await expectDrawn(page, 'fmp4');
        expect(asked[0]?.searchParams.get('codec')).toMatch(/^(h264|av1)$/);
        expect(asked[0]?.searchParams.get('from')).toBe('0.000');

        // 速さは等速だけ (切り替えを出さない)
        await wakeControls(page, 'watch-stage');
        await expect(page.getByTestId('watch-speed')).toHaveCount(0);

        // MPEG-2 を選ぶと、元の TS をそのまま描く
        await page.getByTestId('watch-codec').click();
        const h264 = page.locator('[data-testid="watch-codec-option"][data-codec="h264"]');
        const decodable = await page.evaluate(
            async () => (await VideoDecoder.isConfigSupported({ codec: 'avc1.640029' })).supported === true,
        );
        // 描けない形は選べない
        if (!decodable) await expect(h264).toHaveAttribute('data-disabled');
        await page.locator('[data-testid="watch-codec-option"][data-codec="mpeg2"]').click();
        await expectDrawn(page, 'ts-mpeg2');
        expect(asked.at(-1)?.searchParams.get('codec')).toBe('mpeg2');
        /*
         * **物差しに直せている。** 元の TS の PTS のままなら何時間にもなる。偽の番組は数秒なので、
         * 位置は頭からの数秒に収まる
         */
        await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThan(0);
        expect(await where(page)).toBeLessThan(30);
        // 選んだものは覚える
        expect(await page.evaluate(() => localStorage.getItem('watch-codec'))).toBe('mpeg2');
    });

    test('飛ぶ・CM 飛ばし・字幕・止めて再開が、canvas でも <video> と同じに効く', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        /*
         * **エンコードしない録画にする** (流すものは下で差し替えるので、中身は使わない)。エンコードすると CM 検出が
         * 走り、偽の録画ではロゴの判定に失敗したと覚え書きに残るので、観はじめの CM 飛ばしが切れる
         * (`skipCmAtStart`)。設定はワーカーのアプリに残るので、前のテストに任せず自分で決める
         */
        await setRecording(request, { codecs: [] });
        const { id } = await recordOne(page, request);
        const clip = readClip(new Uint8Array(readFileSync(new URL('../fake/live-av1.mp4', import.meta.url))));
        // 30分の録画のふり。AV1 でエンコードしてある (互換モードは同じ形の詰め替えを選ぶ)
        await page.route(`**/api/recordings/${id}/playback`, (route) =>
            route.fulfill({
                json: {
                    duration: 1800,
                    axis: 'encoded',
                    audios: [{ id: '0', label: '' }],
                    offers: [
                        { codec: 'av1', way: 'file', source: 'encoded', codecs: 'av01.0.08M.08,opus' },
                        { codec: 'h264', way: 'stream', codecs: 'avc1.640028,mp4a.40.2' },
                        { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
                    ],
                },
            }),
        );
        // 頼まれた位置から 60 秒ぶん (時刻はページの物差しのまま)
        await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
            const from = Number(new URL(route.request().url()).searchParams.get('from') ?? 0);
            return route.fulfill({
                status: 200,
                contentType: 'video/mp4',
                body: Buffer.from(clipFrom(clip, from, 60)),
            });
        });
        // 604〜640 秒が CM
        await page.route(`**/api/recordings/${id}/chapters`, (route) =>
            route.fulfill({
                json: {
                    chapters: [
                        { start: 0, end: 604, title: '本編' },
                        { start: 604, end: 640, title: 'CM' },
                        { start: 640, end: 1800, title: '本編' },
                    ],
                },
            }),
        );
        // 字幕は 645 秒から
        await page.route(`**/api/recordings/${id}/captions.json`, (route) =>
            route.fulfill({ json: { v: 1, pages: [{ at: 645, page: FAKE_CAPTION }] } }),
        );
        // 続きの位置 (10 分)
        expect(
            (await request.post(`/api/recordings/${id}/resume`, { data: { at: 600, length: 1800 } })).ok(),
        ).toBe(true);
        await compatOn(page);
        const asked = streamRequests(page);

        await goto(page, `/watch/${id}`);
        await expectDrawn(page, 'fmp4');
        expect(asked[0]?.searchParams.get('codec')).toBe('av1');
        expect(asked[0]?.searchParams.get('from')).toBe('600.000');
        await expect(page.getByTestId('watch-resumed')).toBeVisible();
        expect(await where(page)).toBeGreaterThanOrEqual(600);

        // **CM 飛ばしで飛ぶ。** 観はじめから入っていて、CM の手前まで来たら、CM の終わりから頼み直す
        await expect(page.getByTestId('watch-skip-cm')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => asked.length, { timeout: 30_000 }).toBeGreaterThan(1);
        expect(asked[1]?.searchParams.get('from')).toBe('640.000');
        await expect(page.getByTestId('watch-skipped')).toBeVisible();
        await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(640);

        // **飛ぶ** (→ で 10 秒先)。飛んだ先から頼み直し、位置と字幕がそこに合う
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const before = await where(page);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => asked.length).toBeGreaterThan(2);
        const jumped = Number(asked[2]?.searchParams.get('from'));
        expect(jumped).toBeGreaterThanOrEqual(before + 9);
        expect(jumped).toBeLessThan(before + 12);
        await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(Math.floor(jumped));
        expect(await where(page)).toBeLessThan(jumped + 10);
        await expect(page.getByTestId('watch-captions-canvas')).toHaveAttribute('data-drawn', '', {
            timeout: 15_000,
        });
        await expectDrawn(page, 'fmp4');

        // **止めて再開しても位置が保たれる** (止めている間も進まず、再開は止めた所から。頼み直さない)
        const play = page.getByTestId('watch-play');
        await wakeControls(page, 'watch-stage');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '再生');
        const paused = await where(page);
        const requests = asked.length;
        await page.waitForTimeout(2_500);
        expect(await where(page)).toBe(paused);
        await wakeControls(page, 'watch-stage');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '一時停止');
        await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThan(paused);
        expect(await where(page)).toBeLessThan(paused + 5);
        expect(asked.length).toBe(requests);
    });

    /*
     * **デコーダの読み込みが遅くても描ける** (遅い回線)。偽の録画は数秒しかなく、読み込みの間に尻まで
     * 読み切る。「尻まで読んだのに音が来ない」を 2 秒で終わりと見なしていた頃は、デコーダが 2 秒より
     * 遅れると1コマも出さずに「観終わった」になっていた (`RawEngine.finish`)
     */
    test('デコーダの読み込みが遅くても、短い録画を描く', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await setRecording(request, { codecs: [] });
        const { id } = await recordOne(page, request);
        writeFileSync(stack.liveFmp4File, '');
        await compatOn(page);
        await page.route('**/api/live/mpeg2/decoder.wasm', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            await route.continue();
        });

        await goto(page, `/watch/${id}`);
        await expectDrawn(page, 'fmp4');
    });
});
