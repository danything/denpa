import { existsSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, goto, syncEpg, test, wakeControls } from './helpers';

/**
 * ライブを生で見る ([docs/stream.md](../../docs/stream.md) §5.5)。
 *
 * 焼く道の E2E (20-live) と違って、**ここは絵が出るところまで見る。** 偽エージェントは
 * 本当に解ける MPEG-2 と AAC を流していて (`src/lib/ts/synth-av.ts`)、ブラウザの中の
 * WASM の復号器 (`wasm/mpeg2`、Dockerfile の `mpeg2wasm` 段で組む) がそれを解く。
 * 復号器の置き場は `MPEG2_DIR` (CI は組んだものをランナーへ出して渡す)。
 *
 * 絵は worker の canvas に居て画面から画素を読めないので、**描いたコマ数と解けた音の
 * コマ数** (canvas の `data-shown` / `data-audio`) が進むこと、canvas を撮った絵が
 * 時間とともに変わることを見る。GPU の無いヘッドレス (SwiftShader) でも同じに動く。
 */

/** 画質の切り替えで MPEG-2 を選ぶ。操作列は触らないと引っ込む (`ControlBar`) ので動かして出す */
async function chooseRaw(page: Page): Promise<void> {
    await wakeControls(page, 'live-frame');
    await page.getByTestId('live-codec').click();
    await page.locator('[data-testid="live-codec-option"][data-codec="mpeg2"]').click();
}

/** 偽 ffmpeg に渡された引数を、1回ぶんずつに切る (`tests/fake/ffmpeg.sh`) */
function ffmpegRuns(file: string): string[][] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
        .split('---\n')
        .filter((run) => run.trim() !== '')
        .map((run) => run.split('\n'));
}

test.describe('ライブを生で見る', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('MPEG-2 を選ぶと、焼かずに放送そのままを解いて描き、音も解く', async ({ page, stack }) => {
        const before = ffmpegRuns(stack.liveArgsFile).length;
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await chooseRaw(page);

        const canvas = page.getByTestId('live-raw');
        await expect(canvas).toBeVisible({ timeout: 30_000 });
        // 切り替えに選んだものが出る
        await expect(page.getByTestId('live-codec')).toContainText('MPEG-2');

        // **コマが進む。** 1秒に 60 枚 (フィールドごと) 描くので、数秒で数十は進む
        const shown = async () => Number((await canvas.getAttribute('data-shown')) ?? 0);
        await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);
        const first = await shown();
        await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(first + 10);

        // **音も解けている** (WASM の AAC 復号器が ADTS を解いた)
        await expect
            .poll(async () => Number((await canvas.getAttribute('data-audio')) ?? 0), { timeout: 15_000 })
            .toBeGreaterThan(0);

        // **絵が動いている。** 縞が流れるので、時間をおいて撮った2枚は違う
        const one = await canvas.screenshot();
        await expect(async () => {
            const two = await canvas.screenshot();
            expect(two.equals(one)).toBe(false);
        }).toPass({ timeout: 10_000 });

        // 再生中になり、止める・再開するも繋がっている (再開は放送の今から)
        await expect(page.getByTestId('live-status')).toHaveCount(0);
        const play = page.getByTestId('live-play');
        // 操作列は触らないと引っ込む (`ControlBar`)。動かして出してから押す
        await wakeControls(page, 'live-frame');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '再生');
        await wakeControls(page, 'live-frame');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '一時停止');
        const resumed = await shown();
        await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(resumed + 10);

        /*
         * **焼く ffmpeg は起こさない。** 起きるのは字幕だけを描く1本で、放送の時刻のまま
         * 出させる (`-copyts`。`server/captions.ts` の `rawCaptionArgs`)。
         *
         * MPEG-2 を選ぶまでは焼いている。見るのは**生で頼んだあと**に焼き始めていないこと
         */
        const runs = ffmpegRuns(stack.liveArgsFile).slice(before);
        const captions = runs.findIndex((run) => run.includes('-copyts'));
        expect(captions).toBeGreaterThanOrEqual(0);
        const baked = runs
            .slice(captions)
            .some((run) => run.includes('libx264') || run.includes('libsvtav1'));
        expect(baked).toBe(false);
    });

    test('局を変えても生のまま、新しい局の絵が出る', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        await channels.first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await chooseRaw(page);
        const canvas = page.getByTestId('live-raw');
        const shown = async () => Number((await canvas.getAttribute('data-shown')) ?? 0);
        await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);

        await channels.nth(1).click();
        await expect(channels.nth(1)).toHaveAttribute('data-current', 'true');
        // 切り替えの間も前の局の絵のまま (テレビと同じ)。幕で塗り潰さない
        await expect(page.locator('[data-testid="live-status"][data-veiled="true"]')).toHaveCount(0);
        // 器は作り直さない (同じ canvas のまま、数え続ける)
        const after = await shown();
        await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(after + 10);
        await expect(page.getByTestId('live-codec')).toContainText('MPEG-2');
    });

    /*
     * **生で見ている間も切り抜ける。** 絵は worker の canvas に居て `<video>` は空なので、
     * worker に1枚貰う (`raw/engine.ts` の `grab`)。描いたものは残さない作り
     * (`preserveDrawingBuffer` 無し) なので、**描き直さずに読むと真っ黒**になる — 黒くないことまで見る
     */
    test('生で見ている間も切り抜きは絵ごと PNG に落ちる', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await chooseRaw(page);
        const canvas = page.getByTestId('live-raw');
        await expect
            .poll(async () => Number((await canvas.getAttribute('data-shown')) ?? 0), { timeout: 30_000 })
            .toBeGreaterThan(10);

        await wakeControls(page, 'live-frame');
        const download = page.waitForEvent('download');
        await page.getByTestId('live-shot').click();
        const file = await download;
        expect(file.suggestedFilename()).toMatch(/^.+_\d{8}-\d{6}\.png$/);

        const png = readFileSync(await file.path()).toString('base64');
        const lit = await page.evaluate(async (data) => {
            const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
            const bitmap = await createImageBitmap(blob);
            const board = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = board.getContext('2d') as OffscreenCanvasRenderingContext2D;
            ctx.drawImage(bitmap, 0, 0);
            const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
            let bright = 0;
            for (let i = 0; i < pixels.length; i += 4 * 97) {
                if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 60) bright++;
            }
            return { width: bitmap.width, bright };
        }, png);
        expect(lit.width).toBeGreaterThan(0);
        expect(lit.bright).toBeGreaterThan(0);
    });

    /*
     * **生でも小窓 (PiP) に絵が出る。** 絵は worker の canvas に居て `<video>` は空なので、
     * canvas から流れを取って見えない `<video>` (`pip-raw`) に映し、それを小窓にする。
     *
     * その `<video>` は生に入った時点で1枚目まで受け取っておく。押されてから待つと、
     * iPhone の Safari は「押された直後」と見なさなくなって断った (`NotAllowedError`)。
     * 押す前に1枚目が届いていること、押したら小窓に入ってコマが流れること、
     * 小窓で止めると帯も止まることを見る
     */
    test('生でも小窓に絵が出て、小窓で止めると帯も止まる', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await chooseRaw(page);
        const canvas = page.getByTestId('live-raw');
        await expect
            .poll(async () => Number((await canvas.getAttribute('data-shown')) ?? 0), { timeout: 30_000 })
            .toBeGreaterThan(10);

        // 押す前に1枚目が届いている (`HAVE_METADATA` 以上)
        const proxy = page.getByTestId('pip-raw');
        await expect
            .poll(() => proxy.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 10_000 })
            .toBeGreaterThanOrEqual(1);

        /*
         * **Chrome は worker が描いたコマを直に書き込む** (`MediaStreamTrackGenerator`)。canvas の
         * 画面への更新から取っていた頃は、Chrome の窓が小窓の後ろに隠れると絵が止まった (Ubuntu)
         */
        expect(
            await proxy.evaluate((v) => {
                const Generator = (globalThis as { MediaStreamTrackGenerator?: unknown })
                    .MediaStreamTrackGenerator as (new () => unknown) | undefined;
                const track = ((v as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0];
                return Generator === undefined || track instanceof Generator;
            }),
        ).toBe(true);

        await wakeControls(page, 'live-frame');
        const pip = page.getByTestId('live-pip');
        await pip.click();
        await expect(pip).toHaveAttribute('aria-pressed', 'true');
        expect(await proxy.evaluate((v) => document.pictureInPictureElement === v)).toBe(true);
        // 小窓にコマが流れている (押す前は流れを切ってある)
        const frames = await proxy.evaluate(
            (v) =>
                new Promise<number>((done) => {
                    const video = v as HTMLVideoElement;
                    let count = 0;
                    const next = () => {
                        count += 1;
                        video.requestVideoFrameCallback(next);
                    };
                    video.requestVideoFrameCallback(next);
                    setTimeout(() => done(count), 1000);
                }),
        );
        expect(frames).toBeGreaterThan(5);

        /*
         * **字幕も小窓に出る** (`compose.ts`)。偽の放送に字幕は乗っていないので、画面の字幕の
         * canvas に赤い帯を描いて「描いている」印を立てる (`paint.ts` の `drawOverlay` と同じ)。
         * 小窓のコマの同じ所が赤くなり、印を下ろせば (字幕を消した) 元の絵に戻る
         */
        const captionShown = (on: boolean) =>
            page.getByTestId('live-captions').evaluate((c, on) => {
                const canvas = c as HTMLCanvasElement;
                canvas.width = 1920;
                canvas.height = 1080;
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                ctx.clearRect(0, 0, 1920, 1080);
                if (on) {
                    ctx.fillStyle = 'rgb(255, 0, 0)';
                    ctx.fillRect(0, 810, 1920, 216);
                    canvas.dataset['drawn'] = '';
                } else delete canvas.dataset['drawn'];
            }, on);
        // 小窓のコマの、字幕の帯の真ん中 (下から 1/6) の色
        const pipPixel = () =>
            proxy.evaluate((v) => {
                const video = v as HTMLVideoElement;
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                ctx.drawImage(video, 0, 0);
                const [r = 0, g = 0, b = 0] = ctx.getImageData(
                    Math.floor(canvas.width / 2),
                    Math.floor((canvas.height * 11) / 12),
                    1,
                    1,
                ).data;
                return r > 200 && g < 60 && b < 60;
            });
        await captionShown(true);
        await expect.poll(pipPixel, { timeout: 5_000 }).toBe(true);
        await captionShown(false);
        await expect.poll(pipPixel, { timeout: 5_000 }).toBe(false);

        // 小窓の再生ボタン (代わりの `<video>` を直に止める) で、帯も止まる・再開する
        const play = page.getByTestId('live-play');
        await proxy.evaluate((v) => (v as HTMLVideoElement).pause());
        await expect(play).toHaveAttribute('aria-label', '再生');
        await proxy.evaluate((v) => (v as HTMLVideoElement).play());
        await expect(play).toHaveAttribute('aria-label', '一時停止');

        await wakeControls(page, 'live-frame');
        await pip.click();
        await expect(pip).toHaveAttribute('aria-pressed', 'false');
        expect(await page.evaluate(() => document.pictureInPictureElement)).toBeNull();
    });

    /*
     * **生の絵の流れを取れない端末では、生の間だけ小窓のボタンを出さない。** Firefox は
     * 書き込む口 (`MediaStreamTrackGenerator`) が無く、worker に渡した canvas からも流れを
     * 取れない。押せても必ず断られる
     */
    test('生の絵の流れを取れない端末では、生の間は小窓のボタンを出さない', async ({ page }) => {
        await page.addInitScript(() => {
            Reflect.deleteProperty(globalThis, 'MediaStreamTrackGenerator');
            HTMLCanvasElement.prototype.captureStream = () => {
                throw new DOMException('取れない', 'NotSupportedError');
            };
        });
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await wakeControls(page, 'live-frame');
        // 焼いたものでは出る
        await expect(page.getByTestId('live-pip')).toBeVisible();
        await chooseRaw(page);
        await expect
            .poll(async () => Number((await page.getByTestId('live-raw').getAttribute('data-shown')) ?? 0), {
                timeout: 30_000,
            })
            .toBeGreaterThan(10);
        await wakeControls(page, 'live-frame');
        await expect(page.getByTestId('live-pip')).toHaveCount(0);
    });

    test('選んでいなければ、いつもどおり焼いたものを見る', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await expect(page.getByTestId('live-codec').first()).toBeVisible();
        await expect(page.getByTestId('live-raw')).toHaveCount(0);
    });

    test('解けない端末では焼いたものに戻り、理由を出す', async ({ page }) => {
        // worker へ描く先を渡せない端末 (OffscreenCanvas の無い古い Safari)
        await page.addInitScript(() => {
            // biome-ignore lint/suspicious/noExplicitAny: 端末に無いことにする
            delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
        });
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await chooseRaw(page);
        await expect(page.getByTestId('live-warning')).toContainText('MPEG-2 を再生できません');
        await expect(page.getByTestId('live-codec')).toContainText('H.264');
        await expect(page.getByTestId('live-raw')).toHaveCount(0);
    });

    test('選んだものは焼き方と同じくこの端末に覚える', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await chooseRaw(page);
        await expect(page.getByTestId('live-raw')).toBeVisible({ timeout: 30_000 });

        // 開き直しても MPEG-2 のまま
        await goto(page, '/live');
        await expect(page.getByTestId('live-raw')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('live-codec')).toContainText('MPEG-2');

        // H.264 に戻すと焼いたものになり、それも覚える
        await wakeControls(page, 'live-frame');
        await page.getByTestId('live-codec').click();
        await page.locator('[data-testid="live-codec-option"][data-codec="h264"]').click();
        await expect(page.getByTestId('live-raw')).toHaveCount(0, { timeout: 30_000 });
        await goto(page, '/live');
        await expect(page.getByTestId('live-title')).toBeVisible();
        await expect(page.getByTestId('live-codec')).toContainText('H.264');
        await expect(page.getByTestId('live-raw')).toHaveCount(0);
    });
});
