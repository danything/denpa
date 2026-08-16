import { existsSync } from 'node:fs';
import {
    cellOf,
    expect,
    goto,
    reserveSoon,
    setRecording,
    syncEpg,
    test,
    upcoming,
    waitRowState,
    waitWatchable,
} from './helpers';

/**
 * 録画→エンコード→保存先に入るまでを通しで確認する。
 * 進行はサーバ側のタイマー任せなので、ページを読み直しながら状態が変わるのを待つ。
 */
test.describe('録画とエンコード', () => {
    test('予約した番組が録画され、エンコードされて保存先に入る', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // 節目の通知が実際にどう飛ぶかも、この一連の流れで見ておく
        await request.post(`${stack.webhookUrl}/__control/reset`);
        await goto(page, '/settings');
        await page.getByTestId('webhook-url').fill(`${stack.webhookUrl}/__control/webhook`);
        await page.getByTestId('webhook-add').click();

        // BSは他のテストが触らないので、チューナー競合の心配なく録れる
        const programId = await reserveSoon(page, request, 'BS');

        const reservationRow = `[data-testid="reservation-row"][data-program-id="${programId}"]`;
        await waitRowState(page, '/?all=1', page.locator(reservationRow), '完了');

        const recordingRow = `[data-testid="recording-row"][data-program-id="${programId}"]`;
        await waitRowState(page, '/', page.locator(recordingRow), '視聴可能');

        // 保存先のパスが決まっていること。実体との突き合わせにこのパスを使う。
        // 画面には出さない(普段は見ないので)ので、行の属性から取る
        await goto(page, '/');
        const recording = page.locator(recordingRow);
        const videoPath = (await recording.getAttribute('data-library-path')) ?? '';
        expect(videoPath).toContain(stack.libraryDir);
        expect(videoPath).toContain('.mkv');

        /*
         * CM検出が走り、既定のチャプター付与として記録されていること。
         *
         * **切った位置は画面に出さない** — チャプターとして動画に入っているので、
         * 再生すれば分かる。ここでは行の属性から確かめる。
         * 詳細には「何で見つけたか」だけを出す (ロゴを教える口を出すかの判断にも使う)
         */
        expect(await recording.getAttribute('data-cm-ranges')).toContain('300');
        await recording.getByTestId('detail-button').click();
        await expect(page.getByTestId('detail-cm-note')).toContainText('無音');
        await page.getByTestId('detail-close').click();

        // 実際に録れた長さが記録されていること。番組表の尺は予定でしかなく、
        // 途中で止めたときは実物と合わない
        const recorded = Number(await recording.getAttribute('data-duration-ms'));
        expect(recorded).toBeGreaterThan(0);
        // 番組表の尺(BSの偽番組は10秒)から大きく外れていないこと
        expect(recorded).toBeLessThan(5 * 60_000);

        // サムネイル (denpa の画面が出す絵) が隣に置かれていること。
        // 番組情報の .nfo は書かなくなった (Nova/WebDAV 連携をやめた) ので、無いのが正
        const base = videoPath.replace(/\.mkv$/, '');
        expect(existsSync(`${base}-poster.jpg`)).toBe(true);
        expect(existsSync(`${base}.nfo`)).toBe(false);

        // 観られる録画には再生の印が出ていること。
        // 再生ボタンは置いていない (行そのものを押すと再生する)
        await expect(recording.getByTestId('play-hint')).toBeVisible();

        /*
         * 何で録れた1本かを出していること。**録画の側では手動とも書く** —
         * 予約は「ルールでないなら黙る」が、録れたものは後から見返すので、
         * 「ルールではない」ことにも意味がある (どのルールを直せばいいのか、を
         * 探し始める前に打ち切れる)
         */
        await expect(recording.getByTestId('rule-name')).toHaveText('手動予約');

        // 行を押すと番組表と同じ詳細が出る。焼いたもののコマ数の札も付く
        await recording.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('detail-video')).toBeVisible();
        await expect(detail.getByTestId('detail-fps')).toHaveText('60コマ/秒');

        /*
         * 畳んでいる「その他…」のメニューは display:none であること。
         * dropdown-content に flex を直に載せていた頃、daisyUI の display:none より
         * 強く効いて閉じても display:flex のまま (opacity 0) になり、ボタンの真上の
         * 見えない項目がクリックを食っていた (実機で発覚)
         */
        expect(await detail.locator('.dropdown-content').evaluate((el) => getComputedStyle(el).display)).toBe(
            'none',
        );

        /*
         * ダウンロードは押されてから**期限付きの署名URL** (?token=) を作って始める。
         * 資格情報を URL に埋めていた頃は、パスワードがダウンロード履歴に残り続けた。
         *
         * **口は詳細の中にある。** 一覧の行に並べていた頃は、1行に4つも5つも
         * ボタンが載って狭い画面で横に流れていた
         */
        await detail.getByTestId('detail-more').click();
        const started = page.waitForEvent('download');
        await detail.getByTestId('download-link').click();
        const download = await started;
        const minted = new URL(download.url());
        expect(minted.search).toContain('token=');
        expect(minted.search).toContain('download=1');
        expect(download.url()).not.toContain('denpa:');
        // URL の尻は番組名 (`/file/<番組名>.mkv`)。テレビの VLC はここを見出しにする
        expect(decodeURIComponent(minted.pathname)).toMatch(/\/file\/.+\.mkv$/);
        await download.cancel();

        // 落とし始めたら詳細は畳む (押せたかどうかが分かるように)
        await expect(detail).toHaveCount(0);

        // ファイルは Range で取りに行ける。プレイヤーはこれでシークするので、
        // 対応していないと全部落とし終わるまで早送りできない
        const id = await recording.getAttribute('data-recording-id');
        expect(id).toBeTruthy();
        // 信頼したネットワーク (E2E はローカル) からは、資格情報なしでそのまま取れる
        const part = await request.get(`/api/recordings/${id}/file`, {
            headers: { Range: 'bytes=0-99' },
        });
        expect(part.status()).toBe(206);
        expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
        expect((await part.body()).byteLength).toBe(100);

        // 名前を付けないと「file」という拡張子の無いファイルとして落ちてくる。
        // 署名URLは資格情報なしで通る (token が資格そのもの)
        const attached = await request.get(minted.pathname + minted.search);
        expect(attached.status()).toBe(200);
        const disposition = attached.headers()['content-disposition'] ?? '';
        expect(disposition).toMatch(/^attachment;/);
        expect(disposition).toContain('.mkv');

        // 節目ごとに通知が飛び、どれも番組名と一緒にチャンネル名が入っていること。
        // 番組名だけだと、どの局のものか通知を見ただけでは分からない
        const state = await (await request.get(`${stack.webhookUrl}/__control/state`)).json();
        const events = state.webhookCalls.map((call: { event: string }) => call.event);
        expect(events).toContain('recording.started');
        expect(events).toContain('recording.finished');
        expect(events).toContain('encode.finished');
        for (const call of state.webhookCalls as { text: string; recording?: { service: string } }[]) {
            expect(call.text).toContain('BS11イレブン');
            expect(call.recording?.service).toBe('BS11イレブン');
        }

        /*
         * 番組表のほうも「完了」になっていること。
         *
         * 予約の行が持っているのは録り始めた時刻だけで、そこから先の状態は
         * 録画の行から引く。番組表が予約の状態をそのまま出していた頃は、
         * 録り終えた番組が「予約済み」のまま並び、詳細に取消ボタンまで出ていた
         * (取り消せるのは scheduled / conflict / recording だけ)
         */
        await goto(page, '/guide?type=BS');
        await expect(cellOf(page, programId)).toContainText('完了');

        // 後続のテストに通知先を持ち越さない
        await goto(page, '/settings');
        await page.getByTestId('webhook-delete').first().click();
    });
});

test.describe('CMの実カット', () => {
    test('CMを切っても字幕は残る', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // CM の扱いは全体設定。実際に切る側にしてから録る
        await goto(page, '/settings');
        await page.getByTestId('global-cmcut').selectOption('cut');
        await page.getByTestId('save-recording').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();

        await goto(page, '/guide?type=BS');
        const cells = await upcoming(page);
        const target = cells[0];
        const res = await request.post('/guide?/reserve', {
            form: { programId: target.programId, options: '1', encode: 'on' },
        });
        expect(res.ok()).toBeTruthy();

        const recordingRow = `[data-testid="recording-row"][data-program-id="${target.programId}"]`;
        await waitRowState(page, '/', page.locator(recordingRow), '視聴可能');

        await goto(page, '/');
        const recording = page.locator(recordingRow);
        expect(await recording.getAttribute('data-cm-ranges')).toContain('300');

        // 字幕はエンコードの前にTSを切ることで残している。
        // フィルタで切っていた頃は -sn で落とすしかなかった
        const videoPath = (await recording.getAttribute('data-library-path')) ?? '';
        expect(videoPath).toContain('.mkv');
        // 切るための作業ファイルは片付いていること
        expect(existsSync(`${videoPath.replace(/\.mkv$/, '')}.cut.ts`)).toBe(false);
    });
});

test.describe('コーデックを両方焼く', () => {
    test.afterEach(async ({ request }) => {
        await setRecording(request);
    });

    /*
     * **両方選ぶと1本の録画が2ファイルになる。** 古いテレビは AV1 を解けない
     * ので H.264 も置いておくと、同じ録画をどちらの端末でも観られる。主は AV1
     * (`library_path`)、もう一方は H.264 (`alt_path`)。どちらも同じフォルダに
     * 並ぶので、H.264 のほうは名前に印を付けて分ける ([H264])。
     */
    test('AV1 と H.264 の2本ができて、どちらも落とせる', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        await setRecording(request, { codecs: ['av1', 'h264'] });

        const programId = await reserveSoon(page, request, 'BS');
        const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await waitWatchable(page, row);

        // 主は AV1 (素の .mkv)、もう一方は H.264 ([H264] 付き)。実体も2本ある
        const av1 = (await row.getAttribute('data-library-path')) ?? '';
        const alt = (await row.getAttribute('data-alt-path')) ?? '';
        expect(av1).toMatch(/\.mkv$/);
        expect(av1).not.toContain('[H264]');
        expect(alt).toContain('[H264].mkv');
        expect(existsSync(av1)).toBe(true);
        expect(existsSync(alt)).toBe(true);

        // どちらのコーデックにもサムネイルが付く (消したとき残ったほうへ主を
        // 譲れるように、H.264 側へも写してある)
        for (const video of [av1, alt]) {
            expect(existsSync(`${video.replace(/\.mkv$/, '')}-poster.jpg`)).toBe(true);
        }

        // ダウンロードの口が AV1 と H.264 の2つに分かれる (「その他…」の中)
        await row.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail.getByTestId('download-link')).toHaveText('ダウンロード (AV1)');
        await expect(detail.getByTestId('download-alt-link')).toHaveText('ダウンロード (H.264)');
    });
});

test.describe('エンコードしない', () => {
    test.afterEach(async ({ request }) => {
        await setRecording(request);
    });

    /*
     * コーデックはチェックで選ぶ。**どちらも外すと「エンコードしない」** —
     * 別に「エンコードする」のチェックを持たないので、外れていることが
     * そのまま「焼かない」になる
     */
    test('コーデックをどちらも外すと、生TSのまま保存先に置く', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        await goto(page, '/settings');
        await page.getByTestId('codec-av1').uncheck();
        await page.getByTestId('codec-h264').uncheck();
        await page.getByTestId('save-recording').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
        // 選び直しても残っていること (どちらも外れたまま)
        await goto(page, '/settings');
        await expect(page.getByTestId('codec-av1')).not.toBeChecked();
        await expect(page.getByTestId('codec-h264')).not.toBeChecked();

        const programId = await reserveSoon(page, request, 'BS');
        const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;
        await waitWatchable(page, page.locator(row));

        // 焼かずに置いたので mkv ではない。エンコードの進み具合も出ない
        const path = (await page.locator(row).getAttribute('data-library-path')) ?? '';
        expect(path).toContain('.m2ts');
        await expect(page.locator(row).getByTestId('encode-progress')).toHaveCount(0);

        /*
         * 焼き直す口は出ない。**焼かない設定では生TSがそのまま保存先へ移る**ので、
         * 元にできるTSがもう無い (「生TSも残す」は焼いたときの話)。
         * 焼きたくなったらコーデックを選んで録り直すことになる
         */
        await page.locator(row).getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('reencode-button')).toHaveCount(0);
        // 生TSでも観られるものは落とせる
        await expect(detail.getByTestId('download-link')).toHaveCount(1);

        // 後片付け。**焼く設定に戻す** (他のテストや本番の既定に揃える)
        await goto(page, '/settings');
        await page.getByTestId('codec-av1').check();
        await page.getByTestId('save-recording').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
    });
});
