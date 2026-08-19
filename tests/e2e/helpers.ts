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

/** 番組表に出ているうち、もう終わったもの。放送日の頭(4時台)では前日に送って探す */
export async function past(page: Page): Promise<Cell[]> {
    const stale = (cells: Cell[]) => cells.filter((c) => c.startAt < Date.now() - 60 * 60 * 1000);
    let found = stale(await allCells(page));
    if (found.length === 0) {
        await page.getByTestId('prev-day').click();
        await page.locator('[data-hydrated="true"]').waitFor();
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
export async function airing(page: Page): Promise<Cell[]> {
    const at = Date.now();
    const latest = new Map<string, Cell>();
    for (const cell of await allCells(page)) {
        if (cell.startAt > at) continue;
        const held = latest.get(cell.serviceId);
        if (held === undefined || cell.startAt > held.startAt) latest.set(cell.serviceId, cell);
    }
    const found = [...latest.values()];
    expect(found.length).toBeGreaterThan(0);
    return found;
}

export async function upcoming(page: Page): Promise<Cell[]> {
    let soon = await cellsOn(page);
    if (soon.length === 0) {
        // 放送日の終わり際(深夜3時台など)は、この日にこれから始まる番組が
        // 1つも残っていない。翌日に送って探す
        await page.getByTestId('next-day').click();
        await page.locator('[data-hydrated="true"]').waitFor();
        soon = await cellsOn(page);
    }
    expect(soon.length).toBeGreaterThan(0);
    return soon;
}

/** 番組表のマスをIDで掴む。番組が終わると並びがずれるので位置では追わない */
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
    const target = cells[Math.min(skip, cells.length - 1)];
    const res = await request.post('/guide?/reserve', { form: { programId: target.programId } });
    await ok(res, '予約');
    return target.programId;
}

/**
 * 1回開いて、行の状態が変わるのを待つ。**開き直さない** — 画面はサーバからの
 * 知らせ (liveUpdates) で自分で書き換わるので、待っている間は裏の録画とエンコードに
 * CPU を回せる。`waitWatchable` はこれの「視聴可能」専用で、あちらは開き直す
 * (行が知らせで書き換わらない場面 = 予約が録画の行に化けるところ を跨ぐため)
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
        /** 焼くコーデック。両方焼くなら `['av1', 'h264']`、焼かないなら `[]`。省けば av1 */
        codecs?: string[];
        cmCut?: string;
        cmDetector?: string;
        keepOriginal?: boolean;
        freeOnly?: boolean;
    } = {},
): Promise<void> {
    const chosen = patch.codecs ?? ['av1'];

    /*
     * **`codecs` は同じ名前で複数送る** (`codecs=av1&codecs=h264`)。
     * サーバは `formData().getAll('codecs')` で拾う。Playwright の `form`
     * オブジェクトは同じキーを繰り返せないので、body を手で組む
     */
    const body = new URLSearchParams();
    for (const codec of chosen) body.append('codecs', codec);
    body.append('cmCut', patch.cmCut ?? 'chapter');
    // 偽 ffmpeg しか居ないので、外部のコマンドを呼ばないほうで固定する
    body.append('cmDetector', patch.cmDetector ?? 'silence');
    if (patch.keepOriginal === true) body.append('keepOriginal', 'on');
    /*
     * **1回だけ投げ直す。**
     *
     * CI で 1回、**中身の空の 400** が返って落ちました (`saveRecording` は
     * 不正な値でしか 400 を出さず、そのときは理由の入ったページを返すので、
     * 出どころはこちらのフォームではない)。手元では同じ形で走らせても出ず、
     * 4本並べて走らせている CI でだけ出ています。
     *
     * ここは**確かめたいことではなく前準備**なので、1回投げ直す。それでも
     * 駄目なら落とす — 本当に壊れているならどのみち後の assert が落ちる
     */
    for (let 回 = 0; ; 回++) {
        const res = await request.post('/settings?/saveRecording', {
            data: body.toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        if (res.ok() || 回 >= 1) {
            await ok(res, '録画のしかたの保存');
            return;
        }
    }
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
        await page.getByTestId('rule-delete').first().click();
        await expect(rows).toHaveCount(count - 1);
    }
    await expect(rows).toHaveCount(0);
}

/** 通知先を全部消す (10-webhook の後片付け)。消えるのを待ってから次を押す */
export async function clearWebhooks(page: Page): Promise<void> {
    await goto(page, '/settings');
    const rows = page.getByTestId('webhook-delete');
    for (let i = 0; i < 10; i++) {
        const count = await rows.count();
        if (count === 0) break;
        await rows.first().click();
        await expect(rows).toHaveCount(count - 1);
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
 * 引っ込んでいる間の帯は押せません (`pointer-events-none`)。
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
