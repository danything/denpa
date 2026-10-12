import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { mkvFromClip } from '../fake/mkv-clip';
import { expect, FAKE_CAPTION, goto, recordOne, test, wakeControls } from './helpers';

/**
 * **互換モードで、端末に保存した録画も canvas に描く** (`src/lib/mkv-source.ts`・`src/lib/raw/mkv.ts`)。
 *
 * 端末に保存してあるのはエンコード済みの Matroska。互換モードでは `<video>` に渡さず、worker がそのまま
 * 読んで、サーバから流すときと同じ器で描く。飛ぶ位置は Matroska の Cues から引く。
 *
 * 偽 ffmpeg がエンコードする録画は中身が無いので、作り置きの fMP4 (AV1 + Opus) から組んだ Matroska を端末に
 * 保存したことにする (`tests/fake/mkv-clip.ts`。IndexedDB に直に置く。置き方は `offline-db.ts` と同じ)。
 * サーバへは頼まない (`/stream` を1度も読まない) ことも見る
 */

/** 操作バーの「m:ss / m:ss」の左 (いまの位置。秒) */
async function where(page: Page): Promise<number> {
    const text = (await page.getByTestId('watch-clock').textContent()) ?? '';
    const parts = text.split(' / ')[0]!.trim().split(':').map(Number);
    return parts.reduce((sum, part) => sum * 60 + part, 0);
}

test('端末に保存した録画も canvas に描き、飛ぶ・CM 飛ばし・字幕・止めて再開が効く', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    const mkv = mkvFromClip(
        new Uint8Array(readFileSync(new URL('../fake/live-av1.mp4', import.meta.url))),
        40,
    );

    const streams: string[] = [];
    page.on('request', (r) => {
        if (/\/api\/recordings\/\d+\/stream/.test(r.url())) streams.push(r.url());
    });
    await page.addInitScript(() => {
        localStorage.setItem('canvas-video', 'on');
        localStorage.setItem('canvas-drive-notice', '1');
    });
    await goto(page, '/');
    // 端末に保存したことにする。4〜16 秒が CM、字幕は 20 秒から
    await page.evaluate(
        async ({ id, base64, caption }) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open('denpa-offline', 1);
                req.onupgradeneeded = () => {
                    for (const store of ['videos', 'outbox', 'resume'])
                        if (!req.result.objectStoreNames.contains(store))
                            req.result.createObjectStore(store, { keyPath: 'id' });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction('videos', 'readwrite');
                tx.objectStore('videos').put({
                    id,
                    name: '保存した録画',
                    serviceName: 'BS',
                    startAt: Date.now(),
                    durationMs: 40_000,
                    source: 'encoded',
                    state: 'ready',
                    downloadedAt: Date.now(),
                    video: new Blob([bytes], { type: 'video/x-matroska' }),
                    chapters: {
                        chapters: [
                            { start: 0, end: 4, title: '本編' },
                            { start: 4, end: 16, title: 'CM' },
                            { start: 16, end: 40, title: '本編' },
                        ],
                    },
                    captionText: { v: 1, pages: [{ at: 20, page: caption }] },
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            db.close();
        },
        { id: Number(id), base64: Buffer.from(mkv).toString('base64'), caption: FAKE_CAPTION },
    );

    await goto(page, `/watch/${id}`);
    // Matroska をそのまま読んで canvas に描く。`<video>` には渡さない
    const canvas = page.locator('[data-testid="live-raw"][data-input="mkv"]');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const count = async (name: 'shown' | 'audio') => Number((await canvas.getAttribute(`data-${name}`)) ?? 0);
    await expect.poll(() => count('shown'), { timeout: 30_000 }).toBeGreaterThan(5);
    await expect.poll(() => count('audio'), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('watch-video').evaluate((v) => (v as HTMLVideoElement).currentSrc)).toBe(
        '',
    );
    // 端末のもので観ている印
    await wakeControls(page, 'watch-stage');
    await expect(page.getByTestId('watch-controls').getByText('端末', { exact: true })).toBeVisible();

    /*
     * **CM 飛ばしで飛ぶ** (Cues で CM の終わりの手前の Cluster から読み直す)。偽の録画はロゴでの判定に
     * 失敗したことになっていて、観はじめは CM 飛ばしが外れている (`skipCmAtStart`)。押して有効にする —
     * CM の中で押せばその場で、手前で押せば CM に入るところで飛ぶ
     */
    const skip = page.getByTestId('watch-skip-cm');
    await expect(skip).toHaveAttribute('aria-pressed', 'false');
    await skip.click();
    await expect(skip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('watch-skipped')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(16);

    // **飛ぶ** (→ で 10 秒先)。位置と字幕がそこに合う
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const before = await where(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 9);
    expect(await where(page)).toBeLessThan(before + 15);
    await expect(page.getByTestId('watch-captions-canvas')).toHaveAttribute('data-drawn', '', {
        timeout: 15_000,
    });
    const shown = await count('shown');
    await expect.poll(() => count('shown'), { timeout: 15_000 }).toBeGreaterThan(shown + 5);

    // **止めて再開しても位置が保たれる**
    const play = page.getByTestId('watch-play');
    await wakeControls(page, 'watch-stage');
    await play.click();
    await expect(play).toHaveAttribute('aria-label', '再生');
    const paused = await where(page);
    await page.waitForTimeout(2_500);
    expect(await where(page)).toBe(paused);
    await wakeControls(page, 'watch-stage');
    await play.click();
    await expect(play).toHaveAttribute('aria-label', '一時停止');
    await expect.poll(() => where(page), { timeout: 15_000 }).toBeGreaterThan(paused);
    expect(await where(page)).toBeLessThan(paused + 5);

    // サーバからは流していない
    expect(streams).toEqual([]);
});
