import { error } from '@sveltejs/kit';
import { emit } from '$lib/server/events';
import { deleteRecordingFiles } from '$lib/server/files';
import { recordingOr404 } from '$lib/server/recording';

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
