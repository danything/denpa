import { error, json } from '@sveltejs/kit';
import { emit } from '#lib/server/events.js';
import { deleteRecordingFiles } from '#lib/server/files.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { displayTitle } from '#lib/server/title.js';

/**
 * 録画の状態と中身を返す。
 *
 * - **追っかけ再生の画面が「焼き上がったか」を聞く口** (`encoded` / `state`) —
 *   録り終えてから焼き上がるまでの間 (CM検出・エンコード) も追っかけの器で
 *   観られるが、焼き上がれば普通の観る画面 (シークも字幕も揃う) に移りたい。
 *   画面は `recordings` の知らせ (SSE) を受けるたびにここを読む
 * - **番組の説明** (`description` / `extended`)。テレビのアプリの詳細で出す。一覧
 *   (`GET /api/recordings`) に入れないのは、詳細 (出演者など) が長く、一覧を重くするため
 */
export function GET({ params }) {
    const recording = recordingOr404(params.id);
    return json({
        id: recording.id,
        encoded: recording.library_path !== null,
        state: recording.state,
        title: displayTitle(recording.name),
        name: recording.name,
        description: recording.description,
        extended: recording.extended ?? {},
    });
}

/**
 * 録画を消す。**オフライン視聴の後片付けの口** ([docs/offline.md](../../../../../docs/offline.md))。
 *
 * 画面の削除はフォーム (2回クリックの確認つき) で、これは端末側が
 * 「オフラインで消しておいたものを、オンラインに戻ったときにサーバからも消す」
 * ために叩く (`offline.svelte.ts` の flush)。
 *
 * **何度叩いても同じところに落ちる。** outbox は失敗すると再送するので、
 * 既に消えているもの (deleted) には 204 を返して「済んだ」と伝える。
 * 行そのものが無ければ 404 (呼んだ側はこれも「済んだ」と読む)。
 */
export async function DELETE({ params }) {
    // 消した行も引く (deleted)。「もう消えている」を 204 で伝えるため
    const recording = recordingOr404(params.id, true);
    if (recording.deleted_at !== null) return new Response(null, { status: 204 });

    // 録画中のものは消させない。掴んでいるチューナーと書きかけのファイルが残る
    if (recording.finished_at === null) error(409, '録画中は消せません');

    deleteRecordingFiles(recording, '端末から削除');
    emit('recordings');
    return new Response(null, { status: 204 });
}
