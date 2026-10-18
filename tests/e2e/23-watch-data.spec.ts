import { writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import {
    captionsSeenInDataWindow,
    expect,
    expectSharpCaptions,
    fakeDataBroadcast,
    goto,
    holdCaptions,
    holdMedia,
    recordOne,
    routeCaptions,
    test,
    wakeControls,
} from './helpers';

/**
 * 録画を観る画面 (`/watch/<id>`) でデータ放送を出すところ。
 *
 * 22-watch から分けた (あちらが e2e の組の時間の下限になっていた)。偽の録画には
 * データ放送が無いので、どのテストもサイドカー (`.bml.jsonl`) を置いてから出す
 */

/**
 * **「このブラウザでは再生できませんでした」の幕を畳む** (画像で字幕を確かめるテストだけ)。
 * 偽の録画は中身が無く、ブラウザは再生に転んで幕 (`watch-broken`。映像の箱を暗く覆う) を出す。
 * データ放送の小窓に寄せた映像の箱もその下にあるので、塗った字幕が暗く写る。本物の録画では出ない
 */
async function hideBroken(page: Page): Promise<void> {
    await page.addStyleTag({ content: '[data-testid="watch-broken"] { display: none !important; }' });
}

/** 録画のサイドカーにデータ放送を置く */
function placeDataBroadcast(libraryPath: string, script?: string): void {
    writeFileSync(
        `${libraryPath.slice(0, libraryPath.length - extname(libraryPath).length)}.bml.jsonl`,
        `${fakeDataBroadcast(script)
            .map((message) => JSON.stringify({ at: 0, message }))
            .join('\n')}\n`,
    );
}

/**
 * 小窓を持つ既定の BML を置いた録画は**1本を使い回す** (どのテストも同じサイドカーを読むだけ)。
 * 文書を差し替えるテストだけが自分のぶんを録る
 */
let shared: { id: string } | null = null;
async function withDataBroadcast(page: Page, request: APIRequestContext): Promise<string> {
    if (shared === null) {
        const { id, libraryPath } = await recordOne(page, request);
        placeDataBroadcast(libraryPath);
        shared = { id };
    }
    return shared.id;
}

test.describe('録画のデータ放送', () => {
    /**
     * **データ放送を出しても字幕は見えている。テレビと同じで映像と一緒に小窓へ縮む。**
     *
     * 映像の箱ごと BML の小窓へ寄せる。字幕の canvas が箱の外にあった頃は、映像だけ
     * 小窓へ行き、字幕は枠いっぱいのままデータ放送の面の下に隠れていた (実機で「データ放送を
     * 出すと字幕が出なくなる」)。**操作列を出したまま d を押す**
     * (持ち上げた字幕が小窓の中に残らないことも見る)
     */
    test('データ放送を出しても、字幕は映像と一緒に小窓へ縮んで見えている', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await withDataBroadcast(page, request);
        await goto(page, `/watch/${id}`);
        await hideBroken(page);
        await holdMedia(page, 'watch-video', 'watch-captions-canvas', 'watch-stage');
        await page
            .getByTestId('watch-captions-canvas')
            .evaluate((el) => el.setAttribute('data-ink', '0.8000,0.9700'));

        await wakeControls(page, 'watch-stage');
        // データ放送は ⚙ (再生の設定) の中
        await page.getByTestId('watch-settings').click();
        await page.getByTestId('watch-data').click();
        await expect(page.getByTestId('live-data')).toHaveAttribute('data-state', 'ready', {
            timeout: 15_000,
        });

        await captionsSeenInDataWindow(page);
    });

    /**
     * **録画の再生中は選局できない。** データ放送の文書が epgTune を
     * 呼んだら失敗を返し、観ている人には「録画の再生中は選局できません」と知らせる
     */
    test('録画のデータ放送が epgTune を呼ぶと、失敗にして知らせる', async ({ page, request }) => {
        test.setTimeout(180_000);
        // 文書を差し替えるので、使い回しの1本は汚さない
        const { id, libraryPath } = await recordOne(page, request);
        placeDataBroadcast(
            libraryPath,
            '<script><![CDATA[function tune() { var r = browser.epgTune("arib://7fe7.-1.428"); document.getElementById("r").firstChild.data = "r:" + r; }]]></script>' +
                '<bevent><beitem type="DataButtonPressed" onoccur="tune();" subscribe="subscribe"/></bevent>' +
                '<p id="r" style="left:0px;top:0px;width:200px;height:30px;"></p>',
        );
        await goto(page, `/watch/${id}`);
        await wakeControls(page, 'watch-stage');
        // データ放送は ⚙ (再生の設定) の中
        await page.getByTestId('watch-settings').click();
        await page.getByTestId('watch-data').click();
        await expect(page.getByTestId('live-data')).toHaveAttribute('data-state', 'ready', {
            timeout: 15_000,
        });
        await expect(page.getByText('録画の再生中は選局できません')).toBeVisible({ timeout: 15_000 });
        // 文書には失敗 (NaN) が返り、後に続く処理も動く
        await expect
            .poll(() =>
                page.evaluate(() => {
                    for (const host of document.querySelectorAll('[data-testid="live-data"] div')) {
                        const text = host.shadowRoot?.textContent ?? '';
                        if (text.includes('r:')) return text.trim();
                    }
                    return '';
                }),
            )
            .toBe('r:NaN');
    });
});

/**
 * **字幕は、見えている大きさ × 画面の画素で描く** (`caption-draw.ts` の `CaptionPainter`)。
 * データ放送の小窓の中でも同じ。PC とスマホの素の画面は 22-watch の「字幕をくっきり描く」が見る
 */
test.describe('字幕をくっきり描く (データ放送の小窓)', () => {
    test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });

    test('DPR 2 で、データ放送の小窓の中でも字幕の画素が見えている大きさ × DPR と合う', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const id = await withDataBroadcast(page, request);
        await routeCaptions(page);
        await goto(page, `/watch/${id}`);
        await hideBroken(page);
        await holdMedia(page, 'watch-video', 'watch-captions-canvas', 'watch-stage');
        await holdCaptions(page, 'watch-captions-canvas');
        await expectSharpCaptions(page, '小窓に入る前');

        await wakeControls(page, 'watch-stage');
        // データ放送は ⚙ (再生の設定) の中
        await page.getByTestId('watch-settings').click();
        await page.getByTestId('watch-data').click();
        await expect(page.getByTestId('live-data')).toHaveAttribute('data-state', 'ready', {
            timeout: 15_000,
        });
        await captionsSeenInDataWindow(page);
        await expectSharpCaptions(page, 'データ放送の小窓の中');
    });
});
