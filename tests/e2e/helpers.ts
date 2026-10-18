import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import { expect, test } from '../stack';

// テストは必ずここから test / expect を取る。素の @playwright/test から取ると
// ワーカーごとのアプリ (tests/stack.ts) が立たず、宛先も決まらない
export { expect, test };

/**
 * ページを開いてハイドレーション完了まで待つ。
 * SSR済みのDOMにいきなり入力すると、その後のハイドレーションで値が初期値に戻り、
 * 空のまま絞り込みが実行されてしまう。フォームを触るテストは必ずこれを使う。
 */
export async function goto(page: Page, url: string): Promise<void> {
    await page.goto(url);
    await page.locator('[data-hydrated="true"]').waitFor();
    /*
     * **番組表は外枠だけ先に出る。** 表は後から流れてくるので
     * (`guide/+page.server.ts` の `gridOf`)、ハイドレーションだけ待って触りに
     * いくと、まだ骨組みしか無いことがある。局が1つも無ければ表の代わりに
     * 「局がありません」が出るので、どちらかが出るまで待つ
     */
    const pathname = new URL(url, 'http://localhost').pathname;
    if (pathname === '/guide') {
        await page.locator('[data-testid="guide-grid"], [data-testid="empty-grid"]').first().waitFor();
        // マスは数百個ずつ描く (`guide/+page.svelte` の `drawGradually`)。数える前に描き終わるのを待つ
        await expect(page.locator('[data-testid="guide-grid"][aria-busy="true"]')).toHaveCount(0);
    }
    /*
     * **ホームの一覧は少しずつしか描かない** (`#lib/paging.svelte`)。テストは行を
     * 番号で名指ししたり件数を数えたりするので、開いた時点で全部出させておく —
     * 61 件目から先は、巻き取って初めて描かれる
     */
    if (pathname === '/') {
        await revealAll(page, 'timeline', 'recording-more');
    }
}

/**
 * 投げた先が断ったときに、何を言われたのかまで出す。
 * 「false であるはず」とだけ出ても、状態番号も本文も分からず追いようがない
 */
async function ok(res: APIResponse, what: string): Promise<void> {
    if (res.ok()) return;
    throw new Error(`${what} が ${res.status()} で返しました: ${(await res.text()).slice(0, 500)}`);
}

/** EPG を取り込む。定期取得は止めてあるので、テストは必ずこれを先に呼ぶ */
export async function syncEpg(request: APIRequestContext): Promise<void> {
    const res = await request.post('/api/sync');
    await ok(res, 'EPG の取り込み');
    const body = await res.json();
    expect(body.services).toBeGreaterThan(0);
    expect(body.programs).toBeGreaterThan(0);
}

interface Cell {
    programId: string;
    serviceId: string;
    startAt: number;
}

/**
 * 番組表に出ているうち、これから始まるものを放送順に返す。
 *
 * グリッドは日本の慣習どおり4時から24時間ぶんを出すので、先頭は「もう終わった番組」。
 * 位置で選ぶと過去の番組を予約してしまい、いつまでも録画が始まらない。
 */
async function allCells(page: Page): Promise<Cell[]> {
    return await page.getByTestId('grid-program').evaluateAll((nodes) =>
        nodes.map((node) => ({
            programId: node.getAttribute('data-program-id') ?? '',
            serviceId: node.getAttribute('data-service-id') ?? '',
            startAt: Number(node.getAttribute('data-start-at')),
        })),
    );
}

async function cellsOn(page: Page): Promise<Cell[]> {
    return (await allCells(page))
        .filter((c) => c.startAt > Date.now())
        .sort((a, b) => a.startAt - b.startAt || Number(a.serviceId) - Number(b.serviceId));
}

/**
 * 番組表を翌日 / 前日に送り、**表が新しい日のものに入れ替わって描き終わるまで待つ。**
 *
 * ハイドレーションは済んでいるので、それを待っても即座に抜ける。表は後から流れてきて
 * 少しずつ描くので (`goto` と同じ)、押した直後に数えると**前の日のマス**を数え、
 * 入れ替わった後には無いマスを押していた (放送日の終わり際の 3 時台に CI で落ちた)
 */
async function turnDay(page: Page, which: 'next-day' | 'prev-day'): Promise<void> {
    const before = page.url();
    await page.getByTestId(which).click();
    await page.waitForURL((url) => url.href !== before);
    await page.locator('[data-hydrated="true"]').waitFor();
    /*
     * 送った先の日は `start` (その日の 4:00) から 24 時間。いちばん遅く始まるマスがその中に
     * 入っていれば、入れ替わっている (前の日の表は、翌日へ送ったなら手前、前日へ送ったなら先に外れる)
     */
    const start = Number(new URL(page.url()).searchParams.get('start'));
    const day = 24 * 60 * 60 * 1000;
    await expect
        .poll(
            async () => {
                const last = Math.max(...(await allCells(page)).map((c) => c.startAt));
                return last >= start && last < start + day;
            },
            { timeout: 30_000 },
        )
        .toBe(true);
    await expect(page.locator('[data-testid="guide-grid"][aria-busy="true"]')).toHaveCount(0);
}

/** 番組表に出ているうち、もう終わったもの。放送日の頭(4時台)では前日に送って探す */
export async function past(page: Page): Promise<Cell[]> {
    const stale = (cells: Cell[]) => cells.filter((c) => c.startAt < Date.now() - 60 * 60 * 1000);
    let found = stale(await allCells(page));
    if (found.length === 0) {
        await turnDay(page, 'prev-day');
        found = stale(await allCells(page));
    }
    expect(found.length).toBeGreaterThan(0);
    return found;
}

/**
 * 番組表に出ているうち、**いま流れているもの。** 局ごとに1つ。
 *
 * 偽の放送は隙間なく並べてある (`tests/fake/broadcast.ts`) ので、始まったものの
 * うちいちばん新しいものがそれにあたる。終わりの時刻はマスに出ていない
 */
/** 1つは要る。型でも「先頭がある」と言う (`const [target] = await upcoming(page)` がそのまま使える) */
function atLeastOne(cells: Cell[], what: string): [Cell, ...Cell[]] {
    const [head, ...rest] = cells;
    if (head === undefined) throw new Error(`${what}が1つも無い`);
    return [head, ...rest];
}

export async function airing(page: Page): Promise<[Cell, ...Cell[]]> {
    const at = Date.now();
    const latest = new Map<string, Cell>();
    for (const cell of await allCells(page)) {
        if (cell.startAt > at) continue;
        const held = latest.get(cell.serviceId);
        if (held === undefined || cell.startAt > held.startAt) latest.set(cell.serviceId, cell);
    }
    return atLeastOne([...latest.values()], 'いま流れている番組');
}

export async function upcoming(page: Page): Promise<[Cell, ...Cell[]]> {
    let soon = await cellsOn(page);
    if (soon.length === 0) {
        // 放送日の終わり際(深夜3時台など)は、この日にこれから始まる番組が
        // 1つも残っていない。翌日に送って探す
        await turnDay(page, 'next-day');
        soon = await cellsOn(page);
    }
    return atLeastOne(soon, 'これから始まる番組');
}

/**
 * いま開いている番組表の日を、`start` を名指しした URL で返す。
 *
 * **番組表を開き直すときはこれを使う。** `upcoming` は放送日の終わり際 (3時台) に翌日へ
 * 送って選ぶので、`/guide?type=GR` で開き直すと今日の表に戻り、選んだ番組が無い
 * (3:30〜4:00 に CI で落ちていた)。4時を跨いで「今日」が変わっても同じ日が開く
 */
export async function shownDay(page: Page): Promise<string> {
    const href = await page.locator('[data-testid^="type-"][aria-current="page"]').getAttribute('href');
    if (href === null) throw new Error('番組表の種別のリンクが無い');
    return href;
}

/** 番組表のマスをIDで探す。番組が終わると並びがずれるので位置では追わない */
export function cellOf(page: Page, programId: string) {
    return page.locator(`[data-testid="grid-program"][data-program-id="${programId}"]`);
}

/**
 * 指定した局の「少し先の番組」を予約する。
 *
 * BSの偽番組は5秒しかなく、番組表のグリッドではマスが潰れて押せない。
 * ここで見たいのは録画そのものなので、予約は画面ではなくアクションに直接投げる。
 */
export async function reserveSoon(page: Page, request: APIRequestContext, type: string, skip = 0) {
    await goto(page, `/guide?type=${type}`);
    const cells = await upcoming(page);
    const target = cells[Math.min(skip, cells.length - 1)]!;
    const res = await request.post('/guide?/reserve', { form: { programId: target.programId } });
    await ok(res, '予約');
    return target.programId;
}

/**
 * 1回開いて、行の状態が変わるのを待つ。**開き直さない** — 画面はサーバからの
 * 通知 (liveUpdates) で自分で書き換わるので、待っている間は裏の録画とエンコードに
 * CPU を回せる。`waitWatchable` はこれの「視聴可能」専用で、あちらは開き直す
 * (行が通知で書き換わらない場面 = 予約が録画の行に化けるところ を跨ぐため)
 */
export async function waitRowState(
    page: Page,
    url: string,
    row: Locator,
    expected: string,
    timeoutMs = 90_000,
): Promise<void> {
    await goto(page, url);
    await expect(
        row.getByTestId('recording-state').or(row.getByTestId('reservation-state')).first(),
    ).toContainText(expected, { timeout: timeoutMs });
}

/**
 * 一覧を読み直しながら、その録画が「視聴可能」になるまで待つ。
 *
 * **短い間隔で見に行く。** 中の `toHaveText` に既定の待ち (30秒) を使わせると、
 * 「録画中」のうちは30秒粘ってから読み直すので、5秒で終わる録画に気づくのが
 * 最悪90秒後になっていた (録画を待つテストが軒並み1〜2分掛かっていた正体)。
 * 1秒待って読み直すほうが、待ち時間が録画の実尺に近づく
 */
export async function waitWatchable(page: Page, row: Locator, path = '/', timeout = 120_000): Promise<void> {
    await expect(async () => {
        await goto(page, path);
        await expect(row.getByTestId('recording-state')).toHaveText('視聴可能', { timeout: 1_000 });
    }).toPass({ timeout, intervals: [500] });
}

/**
 * 1本録って、視聴可能になるまで待つ。
 *
 * 「外から消されたとき」のような、実体のある録画が要る試験のためのもの。
 * 以前は録画の通しテスト(03)が残した1本を借りていたが、ワーカーごとに別のアプリが
 * 立つようになったので、自分のぶんは自分で用意する
 */
export async function recordOne(
    page: Page,
    request: APIRequestContext,
): Promise<{ id: string; libraryPath: string }> {
    await syncEpg(request);
    // BS の偽番組は5秒。すぐ録り終わる
    const programId = await reserveSoon(page, request, 'BS');
    const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
    await waitWatchable(page, row);
    return {
        id: (await row.getAttribute('data-recording-id')) ?? '',
        libraryPath: (await row.getAttribute('data-library-path')) ?? '',
    };
}

/**
 * 録画のしかたを変える。全体で1つの設定なので、番組ごとの指定は無い。
 * 設定画面のフォームと同じものを投げる (チェックを外した状態はキーごと消える)。
 * エンコードしないときは codec に 'none' を渡す (専用のチェックは無い)
 */
export async function setRecording(
    request: APIRequestContext,
    patch: {
        /** エンコードするコーデック。両方エンコードするなら `['av1', 'h264']`、エンコードしないなら `[]`。省けば av1 */
        codecs?: string[];
        cmCut?: string;
        keepOriginal?: boolean;
        freeOnly?: boolean;
        /** その場で変換する本数の上限 (空は自動)。省けば前のまま */
        transcodeLimit?: string;
    } = {},
): Promise<void> {
    const chosen = patch.codecs ?? ['av1'];

    /*
     * **`codecs` は同じ名前で複数送る** (`codecs=av1&codecs=h264`)。
     * サーバは `formData().getAll('codecs')` で読む。Playwright の `form`
     * オブジェクトは同じキーを繰り返せないので、body を手で組む
     */
    const encoding = new URLSearchParams();
    for (const codec of chosen) encoding.append('codecs', codec);
    if (patch.keepOriginal === true) encoding.append('keepOriginal', 'on');
    if (patch.transcodeLimit !== undefined) encoding.append('transcodeLimit', patch.transcodeLimit);
    const reserve = new URLSearchParams();
    if (patch.freeOnly === true) reserve.append('freeOnly', 'on');
    // 画面では節ごとにフォームが分かれている (エンコード・CM・自動予約)。同じ3つを投げる
    await saveRecordingPart(request, 'saveEncoding', encoding);
    await saveRecordingPart(request, 'saveCm', new URLSearchParams({ cmCut: patch.cmCut ?? 'chapter' }));
    await saveRecordingPart(request, 'saveReserve', reserve);
}

async function saveRecordingPart(
    request: APIRequestContext,
    action: string,
    body: URLSearchParams,
): Promise<void> {
    /*
     * **1回だけ投げ直す。**
     *
     * CI で 1回、**中身の空の 400** が返って落ちました (保存の action は
     * 不正な値でしか 400 を出さず、そのときは理由の入ったページを返すので、
     * 出どころはこちらのフォームではない)。手元では同じ条件で走らせても出ず、
     * 4つ並べて走らせている CI でだけ出ています。
     *
     * ここは**確かめたいことではなく前準備**なので、1回投げ直す。それでも
     * 駄目なら落とす — 本当に壊れているならどのみち後の assert が落ちる
     */
    for (let 回 = 0; ; 回++) {
        const res = await request.post(`/settings/recording?/${action}`, {
            data: body.toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        if (res.ok() || 回 >= 1) {
            await ok(res, `録画のしかたの保存 (${action})`);
            return;
        }
    }
}

/**
 * ルールを1件消す。**削除は書く欄の上にある** (編集中だけ出る) ので、一覧の行を押して開いてから。
 * 消すと一覧の初め (`/rules`) に戻る
 */
export async function deleteRule(page: Page, row: Locator): Promise<void> {
    await row.click();
    await page.waitForURL(/\/rules\?edit=\d+$/);
    await page.getByTestId('rule-delete').click();
    await page.getByTestId('rule-delete-confirm').click();
    await page.waitForURL(/\/rules$/);
}

/**
 * 前のテストが残したルールを全部消す。
 *
 * **件数で判定するテストの前に要る。** 同じワーカーの前のファイルが作った
 * ルールが残っていると、`toHaveCount(1)` の類が理由もなく落ちます。
 * 消すと、そのルールが立てた予約も一緒に引っ込みます。
 */
export async function clearRules(page: Page): Promise<void> {
    await goto(page, '/rules');
    /*
     * **消えるのを待ってから次を押す。** 数えた直後に前の削除が反映されて
     * 行が消える (か、送信中で `disabled` になる) と、`first().click()` が
     * 押せる要素をテストのタイムアウトいっぱい (2分) 待っていた
     */
    const rows = page.getByTestId('rule-row');
    for (let i = 0; i < 20; i++) {
        const count = await rows.count();
        if (count === 0) break;
        await deleteRule(page, rows.first());
        await expect(rows).toHaveCount(count - 1);
    }
    await expect(rows).toHaveCount(0);
}

/**
 * 少しずつ出す一覧を**全部出させる** (`#lib/paging.svelte`)。
 *
 * ホームの予約・録画とルールの一覧は、最初は 1 画面と少しだけ描き、末尾の印
 * (`<一覧>-more`。`use:sentinel`。まとめない録画は頭と尻の間) が画面に入るたびに続きを足す。件数を数える・
 * 行を番号で名指しするテストは、その前にこれを呼ぶ (ホームは `goto` が呼ぶ)。
 *
 * **印を巻き取って見せる**のはブラウザの `scrollIntoView` で。一覧は自分の箱の中で
 * 巻き取る (`overflow: auto`) ので、箱ごと動かさないと見えない。足されたかどうかは
 * **行の数**で見る (印の文言で見ていた頃は、読む前に足されると比べる相手が同じになって
 * 5 秒ずつ空回りし、テストごと時間切れになった)。
 *
 * @param listTestId 一覧の `data-testid` (`timeline` など)
 * @param moreTestId 続きを足す印の `data-testid`
 */
async function revealAll(page: Page, listTestId: string, moreTestId: string): Promise<void> {
    const list = page.getByTestId(listTestId);
    const more = page.getByTestId(moreTestId);
    const rows = list.locator('[data-testid$="-row"]');
    for (let i = 0; i < 100; i++) {
        if ((await more.count()) === 0) return;
        const before = await rows.count();
        await more.first().evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await expect
            .poll(async () => (await more.count()) === 0 || (await rows.count()) > before, {
                timeout: 10_000,
                message: `${listTestId} の続きが出ません (${before} 行のまま)`,
            })
            .toBe(true);
    }
    await expect(more).toHaveCount(0);
}

/** 通知先を全部消す (10-webhook の後片付け)。消えるのを待ってから次を押す */
export async function clearWebhooks(page: Page): Promise<void> {
    await goto(page, '/settings/integrations');
    const rows = page.getByTestId('webhook-delete');
    for (let i = 0; i < 10; i++) {
        const count = await rows.count();
        if (count === 0) break;
        // 削除は2回押し (`ArmedDelete`)。1回目で「確定」に変わるだけなので、確定まで押す
        await rows.first().click();
        await page.getByTestId('webhook-delete-confirm').click();
        await expect(page.getByTestId('webhook-row')).toHaveCount(count - 1);
    }
}

/**
 * 残っている予約を全部取り消す。
 *
 * **消し切れたことを確かめてから返します。** 途中で諦めると、そのあとの
 * 件数の検証が「何を数えているのか分からない」ものになります。
 */
export async function cancelAllReservations(page: Page): Promise<void> {
    await goto(page, '/');
    // 消えるのを待ってから次を押す (clearRules と同じ理由)
    const buttons = page.getByTestId('cancel-button');
    for (let i = 0; i < 80; i++) {
        const count = await buttons.count();
        if (count === 0) break;
        await buttons.first().click();
        await expect(buttons).toHaveCount(count - 1);
    }
    await expect(page.getByTestId('reservation-row')).toHaveCount(0);
}

/**
 * 操作列を出し直す。**触らないでいると 2.5 秒で引っ込む**ので
 * ([controls.svelte.ts](../../src/lib/components/player/controls.svelte.ts))、
 * 引っ込んでいる間の操作バーは押せません (`pointer-events-none`)。
 *
 * 開いた直後は出ているため、続けて押すだけのテストは通ってしまいます。
 * **待ちを挟んだ先で押すものは、ここで起こしてから押すこと。**
 *
 * 同じ場所への `pointermove` は捨てられるので (止まっているカーソルの下で
 * 中身が動いただけでもブラウザは投げてくる)、**2回、違う場所へ動かします**
 */
export async function wakeControls(page: Page, stage: string): Promise<void> {
    const box = await page.getByTestId(stage).boundingBox();
    if (box === null) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.move(x, y - 4);
}

/**
 * 再生の設定 (⚙ `SettingsMenu`) を開く。開いていればそのまま。`prefix` は `live` / `chase` / `watch`。
 * 操作列が引っ込んでいると押せないので、待ちを挟んだ先では先に `wakeControls` を呼ぶ
 */
export async function openSettings(page: Page, prefix: string): Promise<void> {
    const menu = page.getByTestId(`${prefix}-settings-menu`);
    if (await menu.isVisible()) return;
    await page.getByTestId(`${prefix}-settings`).click();
    await expect(menu).toBeVisible();
}

/** 再生の設定からコーデックを選ぶ (選ぶとメニューは閉じる) */
export async function pickCodec(page: Page, prefix: string, codec: string): Promise<void> {
    await openSettings(page, prefix);
    await page.getByTestId(`${prefix}-codec`).click();
    await page.locator(`[data-testid="${prefix}-codec-option"][data-codec="${codec}"]`).click();
    await expect(page.getByTestId(`${prefix}-settings-menu`)).toBeHidden();
}

/** 再生の設定の切り替え (`skip-cm` / `ambient` / `background`) を押して、メニューを閉じる */
export async function flipSetting(page: Page, prefix: string, id: string): Promise<void> {
    await openSettings(page, prefix);
    await page.getByTestId(`${prefix}-${id}`).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`${prefix}-settings-menu`)).toBeHidden();
}

/**
 * 舞台の上の押すもの (`.ov-btn`) が**丸ごと見えているか**を見る。どれか2つが重なって
 * いないか (箱が交わらないか)、枠からはみ出していないか。見えていないもの (畳んだもの・
 * 幅 0) は数えない。返すのは困りごとの一覧 (空なら良し)
 */
export async function overlayTroubles(page: Page, stage: string): Promise<string[]> {
    return page.evaluate((testid) => {
        const root = document.querySelector(`[data-testid="${testid}"]`);
        if (root === null) return [`${testid} がありません`];
        const frame = root.getBoundingClientRect();
        const name = (el: Element) =>
            el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent;
        const boxes = [...root.querySelectorAll('.ov-btn')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height > 0);
        const troubles: string[] = [];
        for (const { el, r } of boxes) {
            if (
                r.left < frame.left - 0.5 ||
                r.right > frame.right + 0.5 ||
                r.top < frame.top - 0.5 ||
                r.bottom > frame.bottom + 0.5
            )
                troubles.push(`${name(el)} が枠の外`);
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i]!.r;
                const b = boxes[j]!.r;
                const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (w > 0.5 && h > 0.5)
                    troubles.push(`${name(boxes[i]!.el)} と ${name(boxes[j]!.el)} が重なる`);
            }
        }
        return troubles;
    }, stage);
}

/**
 * **操作バーのボタンが1行に並んでいるか** (`ControlRow`。狭い幅で見る)。見えているボタン (`.ov-btn`) の
 * 上端がそろい、行の高さが1段ぶん (いちばん高いボタンと同じ)、行からはみ出したものが無く、
 * どれも 40px 以上あること。畳んだもの (幅 0) は数えない。返すのは困りごとの一覧 (空なら良し)
 */
export async function oneRowTroubles(page: Page, row: string): Promise<string[]> {
    return page.evaluate((testid) => {
        const root = document.querySelector(`[data-testid="${testid}"]`);
        if (root === null) return [`${testid} がありません`];
        const frame = root.getBoundingClientRect();
        const name = (el: Element) =>
            el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent ?? '';
        const buttons = [...root.querySelectorAll('.ov-btn')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height > 0);
        if (buttons.length === 0) return ['ボタンが1つも見えていない'];
        const top = Math.min(...buttons.map(({ r }) => r.top));
        const tallest = Math.max(...buttons.map(({ r }) => r.height));
        const troubles: string[] = [];
        for (const { el, r } of buttons) {
            if (r.top - top > 1.5)
                troubles.push(`${name(el)} が別の行 (上端が ${Math.round(r.top - top)}px 下)`);
            if (r.left < frame.left - 0.5 || r.right > frame.right + 0.5)
                troubles.push(`${name(el)} が行からはみ出す`);
            if (Math.min(r.width, r.height) < 39.5) troubles.push(`${name(el)} が 40px より小さい`);
        }
        if (frame.height > tallest + 1.5) {
            troubles.push(`行の高さが ${Math.round(frame.height)}px (1段は ${Math.round(tallest)}px)`);
        }
        return troubles;
    }, row);
}

/**
 * **全画面をやめる。** 指の端末の観る画面は、開いた時点で全画面に入る。狭い枠のまま
 * (操作バーを映像の下に出した形) を見るときに呼ぶ
 */
export async function leaveFullscreen(page: Page): Promise<void> {
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
}

/**
 * **字幕は操作列の下に潜らない** (`PlayerStage` の持ち上げ)。字幕の canvas に「下の方に
 * 字が載っている」(`data-ink`。描く係が書くもの) と書き込み、字の下端が操作バーの上端より
 * 上へ来るのを待つ。偽の放送には字幕が乗っていないので、載っている範囲だけを作る
 */
export async function captionsClearOfBar(page: Page, canvas: string, bar: string): Promise<void> {
    await page.getByTestId(canvas).evaluate((el) => el.setAttribute('data-ink', '0.8000,0.9700'));
    await expect
        .poll(() =>
            page.evaluate(
                ([c, b]) => {
                    const canvasBox = document.querySelector(`[data-testid="${c}"]`)!.getBoundingClientRect();
                    const barBox = document.querySelector(`[data-testid="${b}"]`)!.getBoundingClientRect();
                    return Math.round(canvasBox.top + canvasBox.height * 0.97 - barBox.top);
                },
                [canvas, bar] as const,
            ),
        )
        .toBeLessThanOrEqual(0);
}

/**
 * **偽のデータ放送。** 1枚だけの BML で、映像を右下の小窓 (`DATA_WINDOW`。960x540 の面の上の
 * 位置) に映し、まわりを青で塗る。実際の局の画面と同じく、小窓の外は面に塞がれる。
 *
 * 作りものの放送にはデータ放送が載っていないので、出したときの見え方 (字幕が映像と一緒に
 * 小窓へ縮むか) はこれを流して確かめる。中身は `ResponseMessage` (`src/lib/ts/bml-protocol.ts`) そのまま
 * (ライブは WebSocket の 0x30、録画はサイドカーの `.bml.jsonl` で渡す)。
 *
 * `extra` は `<body>` の終わりに足す BML (放送が書くものを試すとき。tests/e2e/35-csp.spec.ts)
 */
export const DATA_WINDOW = { left: 480, top: 270, width: 480, height: 270 } as const;
export function fakeDataBroadcast(extra = ''): Record<string, unknown>[] {
    const { left, top, width, height } = DATA_WINDOW;
    const bml = [
        '<?xml version="1.0" encoding="EUC-JP" ?>',
        '<!DOCTYPE bml PUBLIC "+//ARIB STD-B24:1999//DTD BML Document for Japanese//JA" "http://www.arib.or.jp/B24/DTD/bml_1_0.dtd">',
        '<?bml bml-version="1.0" ?>',
        '<bml><head><title>e2e</title></head>',
        '<body style="background-color:#0000ff;">',
        `<object type="video/X-arib-mpeg2" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;"/>`,
        extra,
        '</body></bml>',
    ].join('\n');
    const dataEventId = 1;
    return [
        {
            type: 'pmt',
            components: [
                {
                    pid: 0x0740,
                    componentId: 0x40,
                    streamType: 0x0d,
                    // 地上波 (A プロファイル)
                    dataComponentId: 0x0c,
                    bxmlInfo: {
                        transmissionFormat: 0,
                        entryPointFlag: true,
                        entryPointInfo: {
                            autoStartFlag: true,
                            documentResolution: 0,
                            useXML: false,
                            defaultVersionFlag: true,
                            independentFlag: true,
                            styleForTVFlag: false,
                            bmlMajorVersion: 1,
                            bmlMinorVersion: 0,
                        },
                    },
                },
            ],
        },
        {
            type: 'moduleListUpdated',
            componentId: 0x40,
            modules: [{ id: 0, version: 1, size: bml.length }],
            dataEventId,
        },
        {
            type: 'moduleDownloaded',
            componentId: 0x40,
            moduleId: 0,
            version: 1,
            dataEventId,
            files: [
                {
                    contentLocation: 'startup.bml',
                    contentType: {
                        type: 'text',
                        originalType: 'text',
                        subtype: 'x-arib-bml',
                        originalSubtype: 'X-arib-bml',
                        parameters: [{ attribute: 'charset', originalAttribute: 'charset', value: 'euc-jp' }],
                    },
                    dataBase64: Buffer.from(bml).toString('base64'),
                },
            ],
        },
    ];
}

/** 取っておいた要素 (`holdMedia`)。ページの中の `window.__media` */
interface HeldMedia {
    __media: { video: HTMLElement; captions: HTMLCanvasElement; stage: HTMLElement };
}

/**
 * 映像・字幕・枠の要素を取っておく (`captionsSeenInDataWindow` が使う)。d を押す前に呼ぶ
 */
export async function holdMedia(page: Page, video: string, captions: string, stage: string): Promise<void> {
    await page.evaluate(
        ([v, c, s]) => {
            const held = window as unknown as HeldMedia;
            held.__media = {
                video: document.querySelector(`[data-testid="${v}"]`) as HTMLElement,
                captions: document.querySelector(`[data-testid="${c}"]`) as HTMLCanvasElement,
                stage: document.querySelector(`[data-testid="${s}"]`) as HTMLElement,
            };
        },
        [video, captions, stage] as const,
    );
}

/**
 * **データ放送を出しても字幕が見えているかを、画像で確かめる。**
 *
 * データ放送を出すと、映像の箱ごと BML の小窓へ寄せる (`DataBroadcast` の `placeVideo`)。字幕の
 * canvas がその外にあると、映像だけ小窓へ行き、字幕は枠いっぱいのままデータ放送の面
 * (`z-index: 5`) の下に隠れる (実機で「データ放送を出すと字幕が消える」)。見るのは:
 * - 映像が小窓 (`DATA_WINDOW`) に縮んでいる (流した BML が効いている)
 * - 映像の箱は影の中へ移さない (その場で寄せる)
 * - 字幕の canvas が映像と同じ箱に入っていて、小窓の中に収まる。持ち上げ (`translate`) も残っていない
 * - 字幕を目立つ色で塗って画面を撮ると、**小窓の真ん中はその色** (上に何も被っていない)、
 *   小窓の外 (左上) はその色でない (字幕が枠いっぱいに残っていない)
 */
export async function captionsSeenInDataWindow(page: Page): Promise<void> {
    type Box = { x: number; y: number; width: number; height: number };
    const boxes = () =>
        page.evaluate(() => {
            const { video, captions, stage } = (window as unknown as HeldMedia).__media;
            const box = (el: Element): Box => {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            return {
                video: box(video),
                captions: box(captions),
                stage: box(stage),
                sameBox: captions.parentElement === video.parentElement,
                inShadow: video.getRootNode() !== document,
                translate: getComputedStyle(captions).translate,
            };
        });
    // 映像が小窓に縮むまで (BML を組むのはエンジンができてから)
    await expect
        .poll(
            async () => {
                const { video, stage } = await boxes();
                const want = {
                    x: stage.x + (stage.width * DATA_WINDOW.left) / 960,
                    y: stage.y + (stage.height * DATA_WINDOW.top) / 540,
                    width: (stage.width * DATA_WINDOW.width) / 960,
                };
                return [video.x - want.x, video.y - want.y, video.width - want.width].every(
                    (d) => Math.abs(d) < 2,
                );
            },
            { message: '映像がデータ放送の小窓へ移らない (偽の BML が効いていない)' },
        )
        .toBe(true);
    // 持ち上げを戻すのは `--dp-duration` かけて動く (PlayerStage の transition)。戻り終わるまで待つ
    await expect
        .poll(async () => (await boxes()).translate, { message: '小窓の中で字幕が持ち上げられたまま' })
        .toBe('none');
    const { video, captions, stage, sameBox, inShadow, translate } = await boxes();
    expect.soft(inShadow, '映像の箱が影の中へ移されている').toBe(false);
    expect.soft(sameBox, '字幕が映像と同じ箱に入っていない (小窓へ一緒に行かない)').toBe(true);
    expect.soft(translate, '小窓の中で字幕が持ち上げられたまま').toBe('none');
    // 字幕の面は小窓 (映像の箱) の中に収まる
    expect.soft(captions.x).toBeGreaterThanOrEqual(video.x - 1);
    expect.soft(captions.y).toBeGreaterThanOrEqual(video.y - 1);
    expect.soft(captions.x + captions.width).toBeLessThanOrEqual(video.x + video.width + 1);
    expect.soft(captions.y + captions.height).toBeLessThanOrEqual(video.y + video.height + 1);

    /*
     * **画像で見る。** 字幕を塗りつぶして撮り、塗った色の画素の割合を数える。字幕を描く係が
     * 描き直すと塗りが消えるので、塗るのと撮るのを1組にして待つ
     */
    const share = async (clip: Box): Promise<number> => {
        await page.evaluate(() => {
            const canvas = (window as unknown as HeldMedia).__media.captions;
            const ctx = canvas.getContext('2d');
            if (ctx === null) return;
            ctx.fillStyle = '#ff00ff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        });
        const png = await page.screenshot({ clip });
        return page.evaluate(async (b64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${b64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
            ctx.drawImage(image, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let hit = 0;
            for (let i = 0; i < data.length; i += 4) {
                // 塗った色 (マゼンタ)。読み込み中の幕 (半透明の黒) が被っていても色味で見分ける
                const [r = 0, g = 255, b = 0] = [data[i], data[i + 1], data[i + 2]];
                if (r > 90 && b > 90 && g * 3 < r && g * 3 < b) hit++;
            }
            return hit / (data.length / 4);
        }, png.toString('base64'));
    };
    const around = (x: number, y: number): Box => ({
        x: Math.round(x) - 10,
        y: Math.round(y) - 10,
        width: 20,
        height: 20,
    });
    await expect
        .poll(() => share(around(video.x + video.width / 2, video.y + video.height / 2)), {
            message: '小窓の真ん中に字幕が見えない (データ放送の面の下に隠れている)',
        })
        .toBeGreaterThan(0.9);
    expect(
        await share(around(stage.x + stage.width / 4, stage.y + stage.height / 4)),
        '字幕が枠いっぱいに残っている (映像と一緒に縮んでいない)',
    ).toBeLessThan(0.1);
}

/** 字幕の canvas を取っておく先 (`holdCaptions`) */
interface HeldCaptions {
    __captions: HTMLCanvasElement;
}

/** 字幕の canvas を取っておく */
export async function holdCaptions(page: Page, testid: string): Promise<void> {
    await page.evaluate((id) => {
        (window as unknown as HeldCaptions).__captions = document.querySelector(
            `[data-testid="${id}"]`,
        ) as HTMLCanvasElement;
    }, testid);
}

/**
 * **字幕の canvas は、見えている大きさ × 画面の画素で描いてある** (`caption-draw.ts` の `CaptionPainter`)。
 *
 * 描く画素 (`width`/`height` 属性) と、実際に見えている字幕の面 (`getBoundingClientRect`。
 * 祖先の `transform: scale` 込み。`object-fit: contain` なら収めた中身) × `devicePixelRatio` を
 * 比べる。食い違うと、描いた画像がブラウザに引き伸ばされて字がぼやける — データ放送の小窓の中で
 * 字幕がぼやけていた (面ごと `scale` で伸ばしていた頃と、`%` の大きさで端数が出るとき)。
 * `holdCaptions` で取ってから呼ぶ。描いていない (`data-drawn` が無い) うちは待つ
 */
export async function expectSharpCaptions(page: Page, where: string): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const canvas = (window as unknown as HeldCaptions).__captions;
                    if (canvas.dataset['drawn'] === undefined) return '描いていない';
                    const rect = canvas.getBoundingClientRect();
                    let { width, height } = rect;
                    if (getComputedStyle(canvas).objectFit === 'contain') {
                        const scale = Math.min(width / canvas.width, height / canvas.height);
                        width = canvas.width * scale;
                        height = canvas.height * scale;
                    }
                    const dpr = window.devicePixelRatio;
                    const shown = [width * dpr, height * dpr];
                    const sharp =
                        Math.abs(canvas.width - shown[0]!) <= 1 && Math.abs(canvas.height - shown[1]!) <= 1;
                    return sharp
                        ? 'ok'
                        : `描く画素 ${canvas.width}x${canvas.height} / 見えている大きさ × DPR ${shown.map((n) => n.toFixed(1)).join('x')} (DPR ${dpr})`;
                }),
            { message: `${where}: 字幕の canvas の画素が見えている大きさ × DPR と合わない (ぼやける)` },
        )
        .toBe('ok');
}

/** 開いた WebSocket を覚えておく (`feedCaption`・`feedData`)。**開く前に呼ぶ** */
export async function captureSockets(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const seen = window as unknown as { __sockets: WebSocket[] };
        seen.__sockets = [];
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                seen.__sockets.push(this);
            }
        };
    });
}

/**
 * **データ放送の通知を流す** (`CHANNEL.data` = 0x30 + 多重化の頭 8 バイト + JSON。時刻は 0)。
 * `captureSockets` してから開いた画面で、エンジンができてから呼ぶ (`fakeDataBroadcast` など)
 */
export async function feedData(page: Page, messages: Record<string, unknown>[]): Promise<void> {
    await page.evaluate((messages) => {
        const socket = (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1);
        for (const message of messages) {
            const body = new TextEncoder().encode(JSON.stringify(message));
            const data = new Uint8Array(9 + body.length);
            data[0] = 0x30;
            data.set(body, 9);
            socket?.dispatchEvent(new MessageEvent('message', { data: data.buffer }));
        }
    }, messages);
}

/** データ放送の描いたものから探す (エンジンは開いた影に描く)。見つからなければ null */
export function dataElement(page: Page, selector: string) {
    return page.evaluate((query) => {
        for (const host of document.querySelectorAll('[data-testid="live-data"] div')) {
            const found = host.shadowRoot?.querySelector(query);
            if (found)
                return { text: found.textContent, attributes: [...found.attributes].map((a) => a.name) };
        }
        return null;
    }, selector);
}

/**
 * 試しの字幕1枚 (文字の配置。`caption-text.ts` の `CaptionPage`)。面の下の方に白地に黒の字が1行。
 * 偽の放送にも偽の録画にも字幕は乗っていないので、これを渡して描かせる
 */
export const FAKE_CAPTION = {
    v: 1,
    plane: [960, 540],
    duration: null,
    runs: [
        {
            x: 240,
            y: 450,
            w: 40,
            h: 60,
            fx: 2,
            fy: 12,
            size: 36,
            scaleX: 1,
            text: '字幕はくっきり',
            fg: '#000000ff',
            bg: '#ffffffff',
        },
    ],
};

/**
 * **字幕を1枚流して描かせる** (ライブ・追っかけ。`prefix` は `live` か `chase`)。
 *
 * 字幕が1本あると通知 (`CHANNEL.control` = 0x40 の `captions`)、`FAKE_CAPTION` を字幕のチャンネル
 * (`CHANNEL.captionText` = 0x22、時刻 0) で渡す。偽の放送は映像が出ず再生位置が進まないので、
 * 描くきっかけ (`paint`) は字幕のボタンを2回押して作る (消して出す)。
 * `captureSockets` してから開いた画面で呼ぶ
 */
export async function feedCaption(page: Page, prefix: 'live' | 'chase'): Promise<void> {
    const captions = { type: 'captions', tracks: [{ index: 0, lang: 'jpn', label: '字幕' }], track: 0 };
    await page.evaluate(
        ([notice, caption]) => {
            const socket = (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1);
            for (const [kind, json] of [
                [0x40, notice],
                [0x22, caption],
            ] as const) {
                const body = new TextEncoder().encode(json);
                const data = new Uint8Array(9 + body.length);
                data[0] = kind;
                data.set(body, 9);
                socket?.dispatchEvent(new MessageEvent('message', { data: data.buffer }));
            }
        },
        [JSON.stringify(captions), JSON.stringify(FAKE_CAPTION)] as const,
    );
    // 押すのは要素に直に (操作列が引っ込んでいても、データ放送の面が上に被っていても届く)
    const button = page.getByTestId(`${prefix}-caption`);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.evaluate((el) => (el as HTMLElement).click());
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.evaluate((el) => (el as HTMLElement).click());
    await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/**
 * 字幕のくっきり具合を見る画面の大きさ (`expectSharpCaptions`)。PC (DPR 1 と 2) と
 * スマホの縦 (DPR 3)。`browser.newContext` にそのまま渡す
 */
export const CAPTION_SCREENS = [
    ['PC 1600x900 (DPR 1)', { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 }],
    ['PC 1600x900 (DPR 2)', { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 }],
    [
        'スマホ縦 390x844 (DPR 3)',
        { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ],
] as const;

/**
 * **観る画面に字幕を1枚渡す。** 偽の録画は中身が無く再生位置は 0 のまま動かないので、
 * `captions.json` を `FAKE_CAPTION` を 0 秒に置いたものに差し替える。開く前に呼ぶ
 */
export async function routeCaptions(page: Page): Promise<void> {
    await page.route('**/api/recordings/*/captions.json', (route) =>
        route.fulfill({ json: { v: 1, pages: [{ at: 0, page: FAKE_CAPTION }] } }),
    );
}

/**
 * ホームの**表示の切り替え** (まとめて表示・完了した予約も表示・削除済みも表示・ファイルと照合) を開き、
 * その入れ物を返す。広い画面 (1000px 以上) はサイドバーの「表示の切り替え」、狭い画面は
 * 絞り込みのボタンから出る下からの一枚。どちらにも同じ項目があるので、返した入れ物の中で探す
 */
export async function homeTools(page: Page): Promise<Locator> {
    const side = page.getByTestId('sidebar');
    if (await side.isVisible()) {
        const toggle = side.getByTestId('view-toggle');
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        return side;
    }
    await page.getByTestId('filter-open').click();
    const sheet = page.getByTestId('filter-sheet');
    await expect(sheet).toBeVisible();
    return sheet;
}

/** ホームの絞り込み (すべて・予約・録画中・未視聴・失敗) を押す。広い画面はサイドバー、狭い画面は下からの一枚 */
export async function homeFilter(page: Page, id: string): Promise<void> {
    const side = page.getByTestId('sidebar');
    if (await side.isVisible()) {
        await side.locator(`[data-testid="filter"][data-filter="${id}"]`).click();
        return;
    }
    await page.getByTestId('filter-open').click();
    await page.getByTestId('filter-sheet').locator(`[data-testid="filter"][data-filter="${id}"]`).click();
    await expect(page.getByTestId('filter-sheet')).toBeHidden();
}
