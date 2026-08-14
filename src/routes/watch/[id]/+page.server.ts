import { existsSync } from 'node:fs';
import { error, fail, redirect } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { deleteRecordingFiles } from '$lib/server/files';
import { sidecarPaths } from '$lib/server/metadata';
import { settings } from '$lib/server/settings';
import type { Recording } from '$lib/types';

/**
 * 録画を観る画面。**ブラウザでそのまま再生する。**
 *
 * ## なぜ一覧の中ではなく1枚の画面なのか
 *
 * ポップアップの中に映像と番組の説明を並べると、どちらも中途半端な幅になる
 * (説明は数百字あり、CMの注記もダウンロードも削除も入る)。1枚の画面にすると:
 *
 * - **端末の「戻る」がそのまま効く。** 全画面を抜けたあと、閉じるための×を
 *   画面から探さずに済む
 * - **URL が残る。** 途中まで観たものを開き直せる。ホーム画面から直接も開ける
 *
 * ## 観るのは焼いたものだけ
 *
 * 生TSは MPEG-2 で、**ブラウザに復号器が無い** (docs/stream.md §5.5)。
 * 焼いたもの (AV1 + Opus の Matroska) はそのまま読める。
 * まだ焼けていない録画では、この画面は「まだ焼けていません」を出す。
 */

interface WatchRow extends Recording {
    /** 直近のエンコード失敗の理由。焼けていない理由として出す */
    encode_error: string | null;
    /** 動いているエンコード。焼いている最中かどうかが分かる */
    job_id: number | null;
}

export function load({ params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(404, '録画が見つかりません');

    const recording = queryOne<WatchRow>(
        `SELECT r.*,
             (
                 SELECT CASE WHEN j2.state = 'failed' THEN j2.error END FROM encode_jobs j2
                 WHERE j2.recording_id = r.id
                 ORDER BY j2.id DESC LIMIT 1
             ) AS encode_error,
             (
                 SELECT id FROM encode_jobs
                 WHERE recording_id = r.id AND state IN ('queued','running')
                 ORDER BY id DESC LIMIT 1
             ) AS job_id
         FROM recordings r
         WHERE r.id = ?`,
        id,
    );
    if (recording === undefined) error(404, '録画が見つかりません');
    if (recording.deleted_at !== null) error(410, 'この録画は削除されています');

    // データ放送を焼いてあるか (無い局・古い録画では出さない)。中身は d ボタンで別に取る
    const hasData =
        recording.library_path !== null && existsSync(sidecarPaths(recording.library_path).dataBroadcast);

    // 郵便番号だけ、ライブと同じく器を作る前に NVRAM へ写すのに要る (`DataBroadcast`)
    return { recording, broadcast: { postalCode: settings().postalCode }, hasData };
}

export const actions = {
    /**
     * 観終わったその場で消す。**一覧に戻らずに済ませるため。**
     *
     * 末尾はたいてい CM なので、**流したまま消せる**のが狙い。
     * 押し間違い防止に2回押させるのは一覧と同じ (画面側の `armed`)
     */
    delete: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: '録画が見つかりません' });
        const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id);
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
        redirect(303, '/');
    },
};
