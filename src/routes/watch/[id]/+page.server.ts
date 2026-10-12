import { existsSync } from 'node:fs';
import { error, fail, redirect } from '@sveltejs/kit';
import { eq, getTableColumns } from 'drizzle-orm';
import { orm } from '#lib/server/db.js';
import { deleteRecordingFiles } from '#lib/server/files.js';
import { sidecarPaths } from '#lib/server/metadata.js';
import { relative } from '#lib/server/paths.js';
import { encodedPath, tsPathOf } from '#lib/server/playback.js';
import { recordingFromForm } from '#lib/server/recording.js';
import { lastEncodeError, recordings } from '#lib/server/schema.js';
import { settings } from '#lib/server/settings.js';
import type { Recording } from '#lib/types.js';

/**
 * 録画を観る画面。**ブラウザでそのまま再生する。**
 *
 * ## なぜ一覧の中ではなく1枚の画面なのか
 *
 * ポップアップの中に映像と番組の説明を並べると、どちらも中途半端な幅になる
 * (説明は数百字あり、CMの注記も削除も入る)。1枚の画面にすると:
 *
 * - **端末の「戻る」がそのまま効く。** 全画面を抜けたあと、閉じるための×を
 *   画面から探さずに済む
 * - **URL が残る。** 途中まで観たものを開き直せる。ホーム画面から直接も開ける
 *
 * ## 録り終えた録画はどれもここで観る
 *
 * 何で観るかは開いてから決める (`api/recordings/<id>/playback`。決め方は `ts/playback.ts`)。
 * エンコード済みがあればそのまま (読めない端末にはサーバが詰め替える)、まだエンコードしていなければ
 * サーバが元の TS をその場で変換して流す。**録っている最中だけ**追っかけ再生 (`/chase`) へ送る。
 * エンコード済みも元の TS も無ければ「まだ観られません」と理由を出す。
 */

interface WatchRow extends Recording {
    /** 直近のエンコード失敗の理由。焼けていない理由として出す */
    encode_error: string | null;
}

export function load({ params, url }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(404, '録画が見つかりません');

    const recording: WatchRow | undefined = orm()
        .select({
            ...getTableColumns(recordings),
            encode_error: lastEncodeError(recordings.id),
        })
        .from(recordings)
        .where(eq(recordings.id, id))
        .get();
    if (recording === undefined) error(404, '録画が見つかりません');
    if (recording.deleted_at !== null) error(410, 'この録画は削除されています');
    const encoded = encodedPath(recording);
    const ts = tsPathOf(recording);
    // 録っている最中は追っかけ再生へ (伸びている TS を追い読みする)
    if (encoded === null && ts !== null && recording.finished_at === null)
        redirect(302, relative(url, `/chase/${id}`));

    /*
     * データ放送を焼いてあるか (無い局・古い録画では出さない)。中身は d ボタンで別に取る。
     * **エンコード済みの時刻で書いてある**ので、まだエンコードしていない録画では出さない
     */
    const hasData = encoded !== null && existsSync(sidecarPaths(encoded).dataBroadcast);

    // 郵便番号と都道府県は、ライブと同じく受信機の設定としてエンジンに渡す (`DataBroadcast`)
    const { postalCode, prefecture } = settings();
    return {
        recording,
        /** 観るものがあるか。エンコード済みか、録り終えた元の TS */
        playable: encoded !== null || ts !== null,
        broadcast: { postalCode, prefecture },
        hasData,
    };
}

export const actions = {
    /**
     * 観終わったその場で消す。**一覧に戻らずに済ませるため。**
     *
     * 末尾はたいてい CM なので、**流したまま消せる**のが狙い。
     * 押し間違い防止に2回押させるのは一覧と同じ (画面側の `armed`)
     */
    delete: async ({ request, url }) => {
        const form = await request.formData();
        const recording = recordingFromForm(form);
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        deleteRecordingFiles(recording, '手動削除');
        /*
         * **消したら一覧へ戻す。ここで返しては駄目。**
         *
         * `{ success: true }` を返すと SvelteKit はこの画面の `load` を回し直し、
         * そこは**消えた録画に 410 を投げる** — 観ていた画面がそのまま
         * エラー画面に変わって、消えたのかどうかも分からなくなる。
         * 消したものの画面に留まっても、そもそも見るものが無い
         */
        redirect(303, relative(url, '/'));
    },
};
