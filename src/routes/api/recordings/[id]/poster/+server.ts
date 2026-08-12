import { existsSync, readFileSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { sidecarPaths } from '$lib/server/metadata';
import type { Recording } from '$lib/types';

/**
 * 録画のポスターを返す。**一覧のサムネイル用。**
 *
 * エンコードのときに動画の隣へ置いてある `-poster.jpg` (`server/metadata.ts`)
 * をそのまま配る。これは Nova など外のプレイヤーにも読ませているものと同じ絵で、
 * こちらの一覧でも使い回す。`frame` と違って ffmpeg を起こさない — 焼いたときに
 * 作ってあるので、ただ読んで返すだけ。
 *
 * **無い録画もある。** ポスターより前に焼いたもの、生TSしか無いもの、切り出しに
 * 失敗したもの。そのときは 404 を返して、一覧は絵を出さずに済ませる (`+page.svelte`)。
 */
export function GET({ params }) {
    const recording = queryOne<Recording>(
        'SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL',
        Number(params.id),
    );
    if (recording === undefined) error(404, '録画が見つかりません');
    if (recording.library_path === null) error(404, 'ポスターがありません');

    const poster = sidecarPaths(recording.library_path).thumbnail;
    if (!existsSync(poster)) error(404, 'ポスターがありません');

    return new Response(readFileSync(poster), {
        headers: {
            'Content-Type': 'image/jpeg',
            // 焼いたら変わらない絵。一覧を開くたびに取り直させない
            'Cache-Control': 'private, max-age=86400',
        },
    });
}
