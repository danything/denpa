import type { APIRequestContext, Page } from '@playwright/test';
import { expect, goto, recordOne, test, wakeControls } from './helpers';

/**
 * 録画をブラウザで観る画面 (`/watch/<id>`)。
 *
 * **絵が出るところまでは見ません。** 偽 ffmpeg が置くのは中身の無いファイルで、
 * ブラウザは当然読めない。ここで確かめるのは**画面の作り**のほう —
 * 一覧から1回で来られるか、右に番組の中身が出るか、観たその場で消せるか。
 * 押したときの読み方 (どこでも一時停止・左右2回で10秒・チャプター送り) は
 * `src/lib/ts/watch.test.ts` が持っている。
 */

/**
 * 読み取りだけのテストは**1本の録画を使い回す**。全テストが `recordOne`
 * (予約→録画→焼き上がり待ちで各15秒前後) を自前でやっていた頃は、この
 * ファイルだけで3分近く掛かり、e2e の一番遅いシャードそのものだった。
 * 録画を消すテストだけが自分のぶんを録る (使い回しの1本を壊さない)
 */
let shared: { id: string } | null = null;
async function watchable(page: Page, request: APIRequestContext): Promise<string> {
    if (shared === null) shared = await recordOne(page, request);
    return shared.id;
}

test.describe('録画を観る', () => {
    test('一覧の行から観る画面へ行き、右に番組の中身が出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

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

        // 右には番組の中身。一覧のモーダルと同じものを枠なしで置いてある
        await expect(page.getByTestId('detail-badges')).toBeVisible();
        await expect(page.getByTestId('watch-meta')).toBeVisible();
        // 観ている横にダウンロードは置かない (録画の詳細の「その他…」にある)
        await expect(page.getByTestId('watch-download')).toHaveCount(0);
    });

    /*
     * **番組表から消えても、ジャンルと音声の札は出る。** 録画の行は録り始めに
     * 番組表から写している (recorder)。番組表の行は24時間で消えるので、そのあとは
     * この写しだけが頼り — なのに詳細の種を組み直すところで null に潰していて、
     * **1日過ぎた録画だけ札が消えていた** (実機、2026-09-11)。
     *
     * 番組表から引き直す口を 404 にして「消えたあと」を作る
     */
    test('番組表から消えた録画でも、行が持っているジャンルと音声の札が出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);
        await page.route('/api/programs/*', (route) => route.fulfill({ status: 404, body: '' }));
        await goto(page, `/watch/${id}`);

        const badges = page.getByTestId('detail-badges');
        await expect(badges).toBeVisible();
        // 偽の番組表は全部「アニメ／特撮 > 国内アニメ」(05-rules と同じ前提)
        await expect(badges.getByTestId('detail-genre').first()).toHaveText('アニメ／特撮 > 国内アニメ');
        await expect(badges.getByTestId('detail-audio').first()).toBeVisible();
    });

    /**
     * **観終わったその場で消せる。** 末尾はたいてい CM なので、流したまま消せる
     * のが狙い。押し間違い防止に2回押させるのは一覧と同じ
     */
    test('観ながら消せる。1回目は聞き返すだけ', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        await goto(page, `/watch/${id}`);
        await wakeControls(page, 'watch-stage');
        await page.getByTestId('watch-delete').click();
        await expect(page.getByTestId('watch-delete-confirm')).toBeVisible();

        // 他所を触ったら取り下げる (一覧と同じ癖)
        await page.getByTestId('detail-badges').click();
        await expect(page.getByTestId('watch-delete-confirm')).toHaveCount(0);

        // 右の列は絵から離れた間に引っ込んでいる。起こしてから押す
        await wakeControls(page, 'watch-stage');
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
        const id = await watchable(page, request);

        const res = await request.get(`/api/recordings/${id}/chapters`);
        expect(res.ok()).toBe(true);
        expect((await res.json()).chapters).toEqual([]);

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-video')).toBeVisible();
        // 入っていないときは送りのボタンを出さない (押しても何も起きない操作を並べない)
        await expect(page.getByTestId('watch-next-chapter')).toHaveCount(0);
    });

    /**
     * **字幕は canvas に描いて重ねる。** ライブ (`/live`) と同じやり方。
     *
     * 文字を `<track>` に渡す道は放送どおりには出ない (左右の位置・背景の箱・外字が落ちる)。
     * 入れ物に入っている放送の字幕 (`S_ARIBSUB`) をサーバが解いて文字の配置で渡し
     * (`captions.json`)、画面が描く (`caption-draw.ts`)
     */
    test('字幕が届き、持っているときだけボタンが出る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        const text = await request.get(`/api/recordings/${id}/captions.json`);
        expect(text.ok()).toBe(true);
        const pages = (await text.json()) as {
            v: number;
            pages: { at: number; page: { runs: unknown[] } }[];
        };
        expect(pages.v).toBe(1);
        expect(pages.pages.some((p) => p.page.runs.length > 0)).toBe(true);

        await goto(page, `/watch/${id}`);
        // 重ねる先は映像と同じ枠に敷いてある。**押す邪魔をしない**
        const canvas = page.getByTestId('watch-captions-canvas');
        await expect(canvas).toHaveCount(1);
        await expect(canvas).toHaveCSS('pointer-events', 'none');

        // **既定で出す。** ライブと同じ (テレビの字幕ボタンとは違い、観る画面は出す側)
        const button = page.getByTestId('watch-captions');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await wakeControls(page, 'watch-stage');
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    /**
     * **Ctrl+C は字幕の切り替えではなく、コピーのまま。** 観ながら番組名や
     * URL を写せなかった (キーの `c` が修飾キーを見ずに横取りして
     * `preventDefault` していた)。素の `c` だけが字幕を切り替えること
     */
    test('修飾キー付きのショートカットは横取りしない', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);
        await goto(page, `/watch/${id}`);

        const button = page.getByTestId('watch-captions');
        await expect(button).toHaveAttribute('aria-pressed', 'true');

        // コピー (Ctrl / Cmd) は素通し。字幕は出たまま。**1回ずつ見る** (2回で元に戻ると見逃す)
        await page.keyboard.press('Control+c');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Meta+c');
        await expect(button).toHaveAttribute('aria-pressed', 'true');

        // 素の c は今までどおり字幕を切り替える
        await page.keyboard.press('c');
        await expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    /**
     * **切り抜きは字幕ごと PNG に落ちる** (`番組名_YYYYMMDD-HHMMSS.png`)。PC では
     * クリップボードにも置くが、置けるかは繋ぎ次第なので、ここで見るのは落ちるところまで。
     * 指の端末の共有シートはヘッドレスに無い
     */
    test('切り抜きは番組名と時刻の名前で PNG に落ちる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        await goto(page, `/watch/${id}`);
        const shot = page.getByTestId('watch-shot');
        await expect(shot).toBeVisible();
        const name = (await page.getByTestId('watch-name').textContent())?.trim() ?? '';

        // 絵が無いうちは押しても何も起きない (落とすものが無い)。画面も壊れない
        await wakeControls(page, 'watch-stage');
        await shot.click();
        await expect(page.getByTestId('watch-video')).toBeVisible();

        /*
         * 偽 ffmpeg の焼いたものは中身が無く、絵は来ない。**絵が来たことにする** —
         * 大きささえあれば写せる (中身の無い映像は黒く写る)
         */
        await page.getByTestId('watch-video').evaluate((video) => {
            Object.defineProperty(video, 'videoWidth', { get: () => 320 });
            Object.defineProperty(video, 'videoHeight', { get: () => 180 });
        });
        await wakeControls(page, 'watch-stage');
        const download = page.waitForEvent('download');
        await shot.click();
        const file = await download;
        expect(file.suggestedFilename()).toMatch(/_\d{8}-\d{6}\.png$/);
        expect(
            file.suggestedFilename().startsWith(`${name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}_`),
        ).toBe(true);
        await expect(page.getByText('切り抜きを保存しました', { exact: false })).toBeVisible();
    });

    /** 残りは「あと何分で終わるか」。**倍速のぶんは割る** */
    test('残り時間も出て、倍速のぶんは割る', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        await goto(page, `/watch/${id}`);
        const clock = page.getByTestId('watch-clock');
        await expect(clock).toContainText('残り');
    });

    /** 早送りはライブの追っかけと同じ並び (`ts/pacing` の `SPEEDS`) */
    test('速さを選べる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-speed')).toContainText('×1');
        await page.getByTestId('watch-speed').click();
        await page.getByTestId('watch-speed-option').filter({ hasText: '×1.5' }).click();
        await expect(page.getByTestId('watch-speed')).toContainText('×1.5');
        // 選んだ速さは覚える。開き直しても同じ速さで始まる
        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-speed')).toContainText('×1.5');
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
        const id = await watchable(page, request);

        const put = async (at: number, length: number) => {
            const res = await request.post(`/api/recordings/${id}/resume`, { data: { at, length } });
            expect(res.ok()).toBe(true);
            return (await res.json()).resume;
        };

        const watchedAt = async () => {
            const list: { id: number; watchedAt: number | null }[] = await (
                await request.get('/api/recordings')
            ).json();
            return list.find((rec) => String(rec.id) === id)?.watchedAt;
        };

        expect(await put(600, 1800)).toBe(600);
        // 途中ではまだ観終えていない (一覧の「未視聴」は進捗バーに替わるだけ)
        expect(await watchedAt()).toBeNull();
        // 末尾まで観たものは忘れる。覚えるとエンドロールから始まってしまう
        expect(await put(1790, 1800)).toBeNull();
        // 代わりに観終えた時刻が入る (一覧の「未視聴」の印が外れる)
        expect(await watchedAt()).toEqual(expect.any(Number));

        // 詳細の「その他…」から未視聴に戻すと、一覧に点が戻る
        await goto(page, '/');
        const row = page.locator(`[data-testid="recording-row"][data-recording-id="${id}"]`);
        await expect(row.getByTestId('recording-unwatched')).toHaveCount(0);
        await row.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await detail.getByTestId('detail-more').click();
        await expect(detail.getByTestId('watched-button')).toHaveText('未視聴に戻す');
        await detail.getByTestId('watched-button').click();
        await expect(row.getByTestId('recording-unwatched')).toHaveCount(1);
        expect(await watchedAt()).toBeNull();
    });

    /**
     * **番組の中身は右に全部出す。モーダルにしない** — 映像の上に被さると
     * 観ながら読めない。長ければそこだけが巻き取られる
     */
    test('詳細は右に出たまま', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        await goto(page, `/watch/${id}`);
        await expect(page.getByTestId('watch-facts')).toBeVisible();
        // 開くための「詳細」は無い。押さなくても出ている
        await expect(page.getByTestId('watch-detail')).toHaveCount(0);
        await expect(page.getByTestId('program-detail')).toHaveCount(0);
    });

    /**
     * **形はライブと同じ。** 絵が左、読むものが右で、右は**画面の残りをぜんぶ**
     * 使う。ページごとは動かない。
     *
     * 周りの余白を自分でも足していた頃は、外の `<main>` のぶんと重なって
     * **他の画面より内側から始まり**、足したぶんだけ縦がはみ出して
     * ページごとスクロールバーが出ていた。詳細の高さは**映像に揃えていた** —
     * そのためだけに `absolute` で浮かせる作りをここだけ抱えていたうえ、
     * 縦長の画面では下に余りがあるのに説明だけ狭い窓から覗くことになっていた
     */
    test('右は画面の残りをぜんぶ使い、ページごとは動かない', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        await page.setViewportSize({ width: 1920, height: 960 });

        /*
         * **周りの余白は他の画面と同じ。** 外の `<main>` が持っているぶんだけで、
         * ここでは足さない・頭打ちにもしない。広い画面で中央に寄せていた頃は、
         * 左右だけ他より広かった
         */
        const edge = async (): Promise<number> =>
            page.evaluate(() => {
                const box = document.querySelector('main')?.firstElementChild;
                return Math.round(box?.getBoundingClientRect().left ?? -1);
            });
        await goto(page, '/');
        const other = await edge();

        await goto(page, `/watch/${id}`);
        expect(await edge()).toBe(other);

        const box = await page.evaluate(() => {
            const stage = document.querySelector('[data-testid="watch-stage"]')?.getBoundingClientRect();
            const aside = document.querySelector('aside')?.getBoundingClientRect();
            const board = document.querySelector('main')?.firstElementChild?.getBoundingClientRect();
            const root = document.documentElement;
            return {
                横に並ぶ: stage !== undefined && aside !== undefined ? stage.right <= aside.left + 1 : false,
                // 下まで使い切る。決め打ちで切っていた頃は、下に余白があるのに先に終わっていた
                余り:
                    aside !== undefined && board !== undefined ? Math.round(board.bottom - aside.bottom) : -1,
                縦に動く: root.scrollHeight > root.clientHeight + 1,
                横に動く: root.scrollWidth > root.clientWidth,
            };
        });
        expect(box.横に並ぶ).toBe(true);
        expect(box.余り).toBeLessThanOrEqual(1);
        expect(box.縦に動く).toBe(false);
        expect(box.横に動く).toBe(false);
    });

    /**
     * **右端は「観るのをやめる」ための列。** 閉じる・切り抜く・消すは、
     * 観ながら使う操作 (再生・音・字幕) とは押す頻度も並べる理由も違う。
     *
     * 1本の帯に混ぜていた頃は押すものが12個並び、**番組の名前が入る幅が
     * 残らなかった** — 実機のタブレットで名前が折り返し、帯が二段になっていた
     */
    test('閉じる・切り抜き・削除は右の列。下の帯は一段のまま', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);

        await page.setViewportSize({ width: 820, height: 1180 });
        await goto(page, `/watch/${id}`);

        const side = page.getByTestId('watch-side');
        for (const testid of ['watch-close', 'watch-shot', 'watch-delete']) {
            expect(await side.getByTestId(testid).count()).toBe(1);
            // 下の帯には無い。同じことをする口を2つ置かない
            expect(await page.getByTestId('watch-controls').getByTestId(testid).count()).toBe(0);
        }
        // 送り・戻しのボタンは置いていない (PCは矢印キー、指は端を素早く2回)
        await expect(page.getByTestId('watch-back')).toHaveCount(0);
        await expect(page.getByTestId('watch-forward')).toHaveCount(0);
        // 再生停止は下の帯のいちばん左。ライブと同じ並び
        await expect(page.getByTestId('watch-controls').getByTestId('watch-play')).toBeVisible();
        // 小窓 (PiP) も下の帯。並べても一段に収まる (下で見る)
        await expect(page.getByTestId('watch-controls').getByTestId('watch-pip')).toBeVisible();

        /*
         * **読むものが長くても帯を割らない。** 折り返すかは中身の幅で決まるので、
         * 縮む指定 (`truncate`) だけでは、縮む前に行が分かれてしまう
         */
        const rowHeight = async (): Promise<number> =>
            page.evaluate(() =>
                Math.round(
                    document.querySelector('[data-testid="watch-buttons"]')?.getBoundingClientRect().height ??
                        -1,
                ),
            );
        const before = await rowHeight();
        // 押すものは一段に収まる (`btn-lg` = 48px。折れると倍になる)
        expect(before).toBeLessThan(60);
        await page.getByTestId('watch-clock').evaluate((el) => (el.textContent = 'あ'.repeat(200)));
        expect(await rowHeight()).toBe(before);
    });

    /*
     * **バックグラウンド再生は既定で切。** 裏に回すと止め、戻ると止めた所から再開する。
     * OS が勝手に小窓にしないよう `disablePictureInPicture` も立てる (`background.svelte.ts`)。
     *
     * 偽 ffmpeg の録画は絵が出ない (上) ので、`<video>` の止める・再開を差し替えて、
     * 呼ばれたかだけを見る。裏に回るのは `visibilityState` を差し替えて知らせを送る
     */
    test('バックグラウンド再生は既定で切。裏に回すと止まり、入れると止まらない', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);
        await goto(page, `/watch/${id}`);

        const video = page.getByTestId('watch-video');
        await expect
            .poll(() => video.evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture))
            .toBe(true);
        // 再生中のふり。止める・再開は印を動かすだけ
        await video.evaluate((v) => {
            const media = v as HTMLVideoElement & { fake: boolean };
            media.fake = false;
            Object.defineProperty(media, 'paused', { configurable: true, get: () => media.fake });
            media.pause = () => {
                media.fake = true;
            };
            media.play = async () => {
                media.fake = false;
            };
        });
        const paused = () => video.evaluate((v) => (v as HTMLVideoElement).paused);
        const turn = (state: 'hidden' | 'visible') =>
            page.evaluate((state) => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
                document.dispatchEvent(new Event('visibilitychange'));
            }, state);

        await turn('hidden');
        expect(await paused()).toBe(true);
        await turn('visible');
        expect(await paused()).toBe(false);

        await wakeControls(page, 'watch-stage');
        const toggle = page.getByTestId('watch-background');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect
            .poll(() => video.evaluate((v) => (v as HTMLVideoElement).disablePictureInPicture))
            .toBe(false);
        await turn('hidden');
        expect(await paused()).toBe(false);
        await turn('visible');
    });

    /** 無い録画を開いても、黙って空の画面を出さない */
    test('無い録画は 404', async ({ request }) => {
        const res = await request.get('/watch/999999');
        expect(res.status()).toBe(404);
    });
});

/**
 * **スマホの縦で、全画面をやめて観る。** 枠は 390x224 しか無い (画面の端から端まで。
 * 余白の内側に置いていた頃は 358x224)。
 *
 * 48px の押すものを全部並べていた頃は、帯が折れて絵を覆い、右の縦列 (閉じる・
 * 切り抜き・削除) がシークバーや再生ボタンに重なっていた (実機の報告)。狭い枠では
 * 40px に縮め、毎回は使わないもの (速さなど) を「ほか」(⋯) に畳み、右の列を右上の
 * 一行に寝かせる (`PlayerStage`)
 */
test.describe('スマホの縦で観る', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test('押すものは 40px 以上で重ならず、速さは「ほか」に畳まれる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);
        await goto(page, `/watch/${id}`);
        // 指の端末は開いた時点で全画面に入る。やめたところを見る
        await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

        const stage = page.getByTestId('watch-stage');
        await expect(stage).toHaveAttribute('data-compact', '');
        // 出ていなければ押して出す (開いた直後は出ている。2.5 秒で引っ込む)
        const bar = page.getByTestId('watch-controls');
        if ((await bar.getAttribute('data-shown')) !== 'true') {
            const box = (await stage.boundingBox())!;
            await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        }
        await expect(bar).toHaveAttribute('data-shown', 'true');

        const shape = await page.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const shown = (el: Element) => rect(el).width > 0;
            const side = [...document.querySelectorAll('[data-testid="watch-side"] .ov-btn')].filter(shown);
            const bottom = [
                ...document.querySelectorAll(
                    '[data-testid="watch-controls"] .ov-btn, [data-testid="watch-controls"] input',
                ),
            ].filter(shown);
            const sideBottom = Math.max(...side.map((el) => rect(el).bottom));
            const barTop = Math.min(...bottom.map((el) => rect(el).top));
            const buttons = [...side, ...bottom].filter((el) => el.classList.contains('ov-btn'));
            const stage = rect(document.querySelector('[data-testid="watch-stage"]') as Element);
            return {
                右の列は帯より上: sideBottom <= barTop,
                いちばん小さい: Math.min(...buttons.map((el) => Math.min(rect(el).width, rect(el).height))),
                枠からはみ出す: buttons.some(
                    (el) => rect(el).left < stage.left || rect(el).right > stage.right,
                ),
                横に動く: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                枠: { left: Math.round(stage.left), width: Math.round(stage.width) },
            };
        });
        expect(shape.右の列は帯より上).toBe(true);
        expect(shape.いちばん小さい).toBeGreaterThanOrEqual(40);
        expect(shape.枠からはみ出す).toBe(false);
        expect(shape.横に動く).toBe(false);
        // **絵は画面の端から端まで** (余白の内側に置くと 358px に縮み、周りに縁が出る)
        expect(shape.枠).toEqual({ left: 0, width: 390 });
        // 押すものは一段 (40px)。折れると倍になる
        const row = await page.getByTestId('watch-play').boundingBox();
        const full = await page.getByTestId('watch-full').boundingBox();
        expect(Math.abs((row?.y ?? 0) - (full?.y ?? -100))).toBeLessThan(2);

        // 速さは畳まれていて、「ほか」で出る
        await expect(page.getByTestId('watch-speed')).toBeHidden();
        await page.getByTestId('watch-more').tap();
        await expect(page.getByTestId('watch-speed')).toBeVisible();
        await page.getByTestId('watch-speed').tap();
        // 器は枠の中に収まる (見出しの裏に潜らない)
        const menu = page.getByTestId('watch-speed-menu');
        await expect(menu).toBeVisible();
        const inside = await page.evaluate(() => {
            const menu = document.querySelector('[data-testid="watch-speed-menu"]')?.getBoundingClientRect();
            const stage = document.querySelector('[data-testid="watch-stage"]')?.getBoundingClientRect();
            return (
                menu !== undefined &&
                stage !== undefined &&
                menu.top >= stage.top - 1 &&
                menu.bottom <= stage.bottom + 1
            );
        });
        expect(inside).toBe(true);
        await page.getByTestId('watch-speed-option').filter({ hasText: '×1.5' }).tap();
        await expect(page.getByTestId('watch-speed')).toContainText('×1.5');
    });
});

/**
 * **指で。** マウスと指では操作列の出し方が違い (`controls.svelte.ts`)、メニューの
 * 開け方も Bits UI が pointer の種類で分けていたので、指の経路を別に見る
 */
test.describe('指で観る', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

    /*
     * **押した口が開いたまま残り、操作列も引っ込まない。** 実機のタブレットで、
     * 速さを押した瞬間にメニューが閉じていた。開いている間は操作列の 2.5 秒の
     * 時計 (`LINGER`) も止める — 器は操作列の中に居るので、操作列が消えれば
     * 選んでいる最中でもメニューごと消える
     */
    test('速さの口を押すと開いたまま残り、選ぶまで操作列も消えない', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);
        await goto(page, `/watch/${id}`);

        // 指は絵を1回押して操作列を出す (マウスのように動かしただけでは出ない)
        const stage = (await page.getByTestId('watch-stage').boundingBox())!;
        await page.touchscreen.tap(stage.x + stage.width / 2, stage.y + stage.height / 2);
        const bar = page.getByTestId('watch-controls');
        await expect(bar).toHaveAttribute('data-shown', 'true');

        await page.getByTestId('watch-speed').tap();
        const menu = page.getByTestId('watch-speed-menu');
        await expect(menu).toBeVisible();
        // 触らずに時計のぶんより長く待っても、開いている間は残る
        await page.waitForTimeout(3500);
        await expect(menu).toBeVisible();
        await expect(bar).toHaveAttribute('data-shown', 'true');

        // 選べば閉じて、そこから時計が動き出す
        await page.getByTestId('watch-speed-option').filter({ hasText: '×1.5' }).tap();
        await expect(menu).toBeHidden();
        await expect(page.getByTestId('watch-speed')).toContainText('×1.5');
        await expect(bar).toHaveAttribute('data-shown', 'false', { timeout: 5000 });
    });
});

/**
 * **iPhone の全画面は、枠を画面いっぱいに広げて代わりにする** (#471。`fullscreen.svelte.ts`)。
 *
 * iPhone の Safari は要素の全画面 (`requestFullscreen` / `webkitRequestFullscreen`) を
 * 持たない。口を消して iPhone の横持ち (844x390) に見立てる。指の端末は開いた時点で
 * 全画面に入るので、開いたら広がっていること。出口は同じボタン・Esc・戻る
 */
test.describe('iPhone で全画面', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

    test('開くと枠が画面いっぱいに広がり、重ねものも付いてくる。ボタン・Esc・戻るで出る', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const id = await watchable(page, request);
        await page.addInitScript(() => {
            for (const proto of [Element.prototype, HTMLElement.prototype]) {
                delete (proto as Partial<Element>).requestFullscreen;
                delete (proto as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen;
            }
        });
        await goto(page, `/watch/${id}`);

        const stage = page.getByTestId('watch-stage');
        const full = page.getByTestId('watch-full');
        const covers = async () => {
            await expect(stage).toHaveAttribute('data-pseudo', '');
            await expect.poll(() => stage.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
            // 後ろのページは止める
            await expect(page.locator('html')).toHaveAttribute('data-stage-fullscreen', '');
            await expect(full).toHaveAttribute('aria-label', '全画面をやめる');
        };
        const restored = async () => {
            await expect(stage).not.toHaveAttribute('data-pseudo', '');
            await expect.poll(async () => (await stage.boundingBox())?.height).toBeLessThan(390);
            await expect(page.locator('html')).not.toHaveAttribute('data-stage-fullscreen', '');
            await expect(full).toHaveAttribute('aria-label', '全画面');
            await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));
        };
        const showControls = async () => {
            const bar = page.getByTestId('watch-controls');
            if ((await bar.getAttribute('data-shown')) !== 'true') {
                const box = (await stage.boundingBox())!;
                await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
            }
            await expect(bar).toHaveAttribute('data-shown', 'true');
        };

        // 開いた時点で広がっている。本物の全画面には入っていない
        await covers();
        expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

        // 字幕の面は映像に、映像は枠に重なる。操作列は画面の中
        await showControls();
        const layout = await page.evaluate(() => {
            const rect = (id: string) => {
                const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
                return {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                };
            };
            return {
                video: rect('watch-video'),
                captions: rect('watch-captions-canvas'),
                bar: rect('watch-controls'),
            };
        });
        expect(layout.video).toEqual({ x: 0, y: 0, w: 844, h: 390 });
        expect(layout.captions).toEqual(layout.video);
        expect(layout.bar.y + layout.bar.h).toBeLessThanOrEqual(390);

        // 同じボタンで出る
        await full.tap();
        await restored();

        // もう一度入って、Esc で出る
        await showControls();
        await full.tap();
        await covers();
        await page.keyboard.press('Escape');
        await restored();

        // もう一度入って、戻るで出る。画面は離れない
        await showControls();
        await full.tap();
        await covers();
        await page.evaluate(() => history.back());
        await restored();
    });
});
