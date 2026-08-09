import { expect, goto, recordOne, test } from './helpers';

/**
 * 録画をブラウザで観る画面 (`/watch/<id>`)。
 *
 * **絵が出るところまでは見ません。** 偽 ffmpeg が置くのは中身の無いファイルで、
 * ブラウザは当然読めない。ここで確かめるのは**画面の作り**のほう —
 * 一覧から1回で来られるか、左に番組の中身が出るか、観たその場で消せるか。
 * 押したときの読み方 (どこでも一時停止・左右2回で10秒・チャプター送り) は
 * `src/lib/ts/watch.test.ts` が持っている。
 */
test.describe('録画を観る', () => {
    test('一覧の行から観る画面へ行き、左に番組の中身が出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        await goto(page, '/');
        const row = page.locator(`[data-testid="recording-row"][data-recording-id="${id}"]`);
        /*
         * **行そのものが観る入口。** 再生ボタンは置いていない (印は出す) ので、
         * 行を押したら観る画面へ来ること
         */
        await expect(row.getByTestId('play-hint')).toBeVisible();
        await row.click();
        await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));

        /*
         * **観るのは焼いたものだけ。** 生TSは MPEG-2 で、ブラウザに復号器が
         * 無い (docs/stream.md §5.5)。名指ししていないと、焼いている最中は
         * 生TSが返ってきて何も映らない
         */
        const video = page.getByTestId('watch-video');
        await expect(video).toHaveAttribute('src', `/api/recordings/${id}/file?source=encoded`);

        // 左には番組の中身。一覧のモーダルと同じものを枠なしで置いてある
        await expect(page.getByTestId('detail-badges')).toBeVisible();
        await expect(page.getByTestId('watch-meta')).toBeVisible();
        // 落とす口も残す。ブラウザが読めない形式でも手元のプレイヤーでは観られる
        await expect(page.getByTestId('watch-download')).toBeVisible();
    });

    /**
     * **観終わったその場で消せる。** 末尾はたいてい CM なので、流したまま消せる
     * のが狙い。押し間違い防止に2回押させるのは一覧と同じ
     */
    test('観ながら消せる。1回目は聞き返すだけ', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        await goto(page, `/watch/${id}`);
        await page.getByTestId('watch-delete').click();
        await expect(page.getByTestId('watch-delete-confirm')).toBeVisible();

        // 他所を触ったら取り下げる (一覧と同じ癖)
        await page.getByTestId('watch-download').click({ trial: true });
        await page.getByTestId('detail-badges').click();
        await expect(page.getByTestId('watch-delete-confirm')).toHaveCount(0);

        await page.getByTestId('watch-delete').click();
        await page.getByTestId('watch-delete-confirm').click();

        // 消えたら一覧へ戻る。消したものの画面に留まっても見るものが無い
        await expect(page).toHaveURL(/\/$/);
        await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);
    });

    /**
     * **チャプターの位置は焼いたものから読む** (`api/recordings/<id>/chapters`)。
     *
     * 偽 ffmpeg が置くファイルにチャプターは入っていないので、ここで見るのは
     * 「無くても落ちない」こと。**取れないだけで観られなくなってはいけない**
     */
    test('チャプターが読めなくても観る画面は出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        const res = await request.get(`/api/recordings/${id}/chapters`);
        expect(res.ok()).toBe(true);
        expect((await res.json()).chapters).toEqual([]);

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-video')).toBeVisible();
        // 入っていないときは送りのボタンを出さない (押しても何も起きない操作を並べない)
        await expect(page.getByTestId('watch-next-chapter')).toHaveCount(0);
    });

    /**
     * **字幕は動画の隣に置いた文字のほうから出す。**
     *
     * 入れ物に入っているのは PGS (絵) で、ブラウザに復号器が無い。焼くときに
     * 同じ字幕を文字でも取り出して `<動画名>.ja.ass` に置いてあるので、
     * それを WebVTT に直して `<track>` へ渡す (`server/subtitle.ts` の `buildText`)
     */
    test('字幕は WebVTT に直って届き、持っているときだけボタンが出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        const res = await request.get(`/api/recordings/${id}/subtitle.vtt`);
        expect(res.ok()).toBe(true);
        expect(res.headers()['content-type']).toContain('text/vtt');
        const vtt = await res.text();
        expect(vtt.startsWith('WEBVTT')).toBe(true);
        // 色は WebVTT が元から持っている名前で残す
        expect(vtt).toContain('<c.yellow>にせの字幕です</c>');
        // 「消す」だけの枚は出さない。終わりの時刻としてだけ残る
        expect(vtt).toContain('--> 00:00:03.000');
        expect(vtt).not.toContain('00:00:03.000 -->');

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-track')).toHaveCount(1);
        // 最初は消えている。字幕は絵の上に重なるものなので、要る人が出す
        const button = page.getByTestId('watch-captions');
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
    });

    /** 無い録画を開いても、黙って空の画面を出さない */
    test('無い録画は 404', async ({ request }) => {
        const res = await request.get('/watch/999999');
        expect(res.status()).toBe(404);
    });
});
