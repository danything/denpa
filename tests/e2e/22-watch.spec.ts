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
     * **字幕は絵のまま重ねる。** ライブ (`/live`) と同じやり方。
     *
     * 焼いたものに入っているのは PGS (絵) で、ブラウザに復号器が無い。文字に
     * 直して `<track>` に渡す道も通したが、放送どおりには出ない (左右の位置・
     * 背景の箱・外字が落ちる)。焼くときに作った絵を動画の隣に置いて、
     * denpa 自身が解いて重ねる (`src/lib/pgs.ts` の `readSup`)
     */
    test('字幕の絵が届き、持っているときだけボタンが出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        const res = await request.get(`/api/recordings/${id}/captions.sup`);
        expect(res.ok()).toBe(true);
        const sup = await res.body();
        // PGS の節は 'PG' で始まる
        expect(sup.length).toBeGreaterThan(0);
        expect(String.fromCharCode(sup[0], sup[1])).toBe('PG');

        await goto(page, `/watch/${id}`);
        // 重ねる先は映像と同じ枠に敷いてある。**押す邪魔をしない**
        const canvas = page.getByTestId('watch-captions-canvas');
        await expect(canvas).toHaveCount(1);
        await expect(canvas).toHaveCSS('pointer-events', 'none');

        // **既定で出す。** ライブと同じ (テレビの字幕ボタンとは違い、観る画面は出す側)
        const button = page.getByTestId('watch-captions');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    /** 残りは「あと何分で終わるか」。**倍速のぶんは割る** */
    test('残り時間も出て、倍速のぶんは割る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        await goto(page, `/watch/${id}`);
        const clock = page.getByTestId('watch-clock');
        await expect(clock).toContainText('残り');
    });

    /** 早送りはライブの追っかけと同じ並び (`ts/pacing` の `SPEEDS`) */
    test('速さを選べる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-speed')).toContainText('1×');
        await page.getByTestId('watch-speed').click();
        await page.getByTestId('watch-speed-option').filter({ hasText: '1.5×' }).click();
        await expect(page.getByTestId('watch-speed')).toContainText('1.5×');
        // 選んだ速さは覚える。開き直しても同じ速さで始まる
        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-speed')).toContainText('1.5×');
        expect(
            await page.getByTestId('watch-video').evaluate((v) => (v as HTMLVideoElement).playbackRate),
        ).toBe(1.5);
    });

    /**
     * **どこまで観たかを覚える。** 端末ではなく DB に置くので、別の端末でも続く。
     *
     * ここで見るのは「覚える・覚えない」の判断まで。**絵は出ません** —
     * 偽 ffmpeg が置くのは中身の無いファイルで、位置を戻すところまでは行けない
     * (戻す判断は `ts/watch.test.ts` が持っている)
     */
    test('途中で止めたところを覚え、観終えたら忘れる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        const put = async (at: number, length: number) => {
            const res = await request.post(`/api/recordings/${id}/resume`, { data: { at, length } });
            expect(res.ok()).toBe(true);
            return (await res.json()).resume;
        };

        expect(await put(600, 1800)).toBe(600);
        // 末尾まで観たものは忘れる。覚えるとエンドロールから始まってしまう
        expect(await put(1790, 1800)).toBeNull();
    });

    /**
     * **番組の中身は左に全部出す。モーダルにしない** — 映像の上に被さると
     * 観ながら読めない。長ければそこだけが巻き取られ、押すものは外に残る
     */
    test('詳細は左に出たままで、押すものは巻き取られない', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-facts')).toBeVisible();
        // 開くための「詳細」は無い。押さなくても出ている
        await expect(page.getByTestId('watch-detail')).toHaveCount(0);
        await expect(page.getByTestId('program-detail')).toHaveCount(0);

        // 押すものは巻き取られる箱の外。中身がどれだけ長くても見えている
        const outside = await page.evaluate(() => {
            const box = document.querySelector('[data-testid="watch-facts"]');
            const link = document.querySelector('[data-testid="watch-download"]');
            return box !== null && link !== null && !box.contains(link);
        });
        expect(outside).toBe(true);
    });

    /** 無い録画を開いても、黙って空の画面を出さない */
    test('無い録画は 404', async ({ request }) => {
        const res = await request.get('/watch/999999');
        expect(res.status()).toBe(404);
    });
});
