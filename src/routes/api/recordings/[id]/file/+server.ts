import { basename } from 'node:path';
import { error } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { recordingOr404 } from '$lib/server/recording';
import { contentDisposition, serveFile } from '$lib/server/serve';

/**
 * 録画ファイルをそのまま配る。
 * プレイヤーに URL を渡して直接再生させるための口。
 */
function respond(id: string, request: Request, download: boolean, source: string | null): Response {
    const recording = recordingOr404(id);

    /*
     * どのファイルを配るか。
     *
     * 基本はエンコード済み、無ければ生TS。ただし**エンコードが走っている間は
     * 生TSのほう**を配る。録り直しの最中は library_path がまだ古いファイルを
     * 指していて、しかもその古いファイルは終わり際に消えるので、
     * 押した瞬間によって出るものが変わっていた
     */
    const encoding =
        queryOne<{ n: number }>(
            `SELECT COUNT(*) AS n FROM encode_jobs
             WHERE recording_id = ? AND state IN ('queued', 'running')`,
            recording.id,
        )?.n ?? 0;
    /*
     * **どちらを寄越すか、名指しもできる** (`?source=ts` / `encoded` / `alt`)。
     *
     * - `ts` … 生TS
     * - `encoded` … 主のエンコード済み (両方焼いたときは AV1)
     * - `alt` … もう一方 (H.264)。両方焼いた録画でだけ在る。古いテレビはこちら
     *
     * 残っているものが複数ある録画では、画面がダウンロードの口を分けて出す
     * (`+page.svelte` の `recordingActions`)。上の「今いいほう」だけだと、
     * **押した先が同じファイル**になってしまう。プレイヤーに渡す URL は
     * 名指ししない — あちらは観られさえすればよく、選ばせるものではない
     */
    const path =
        source === 'ts'
            ? recording.ts_path
            : source === 'alt'
              ? recording.alt_path
              : source === 'encoded'
                ? recording.library_path
                : encoding > 0 && recording.ts_path !== null
                  ? recording.ts_path
                  : (recording.library_path ?? recording.ts_path);
    if (path === null) error(404, 'ファイルがありません');

    // ?download=1 のときだけ添付にする。プレイヤーは inline のほうが素直に開く
    return serveFile(
        path,
        path.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp2t',
        request,
        contentDisposition(basename(path), download),
    );
}

export function GET({ params, request, url }) {
    return respond(
        params.id,
        request,
        url.searchParams.get('download') === '1',
        url.searchParams.get('source'),
    );
}

export function HEAD({ params, request, url }) {
    return respond(
        params.id,
        request,
        url.searchParams.get('download') === '1',
        url.searchParams.get('source'),
    );
}
