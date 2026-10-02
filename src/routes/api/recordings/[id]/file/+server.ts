import { basename } from 'node:path';
import { error } from '@sveltejs/kit';
import { config } from '#lib/server/config.js';
import { activeEncodeJob } from '#lib/server/encoder.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { contentDisposition, serveFile } from '#lib/server/serve.js';
import { type FileSource, parseFileSource } from '#lib/source.js';

/**
 * **音声だけ** (`?audio=only`)。音声だけで鳴らすもの (スマートスピーカーへの Cast など) 向け。
 * 元がどれ (生TS・AV1・H.264) でも同じ形で出せるよう、主音声を AAC に焼き直して ADTS で流す。
 * 音声だけなので軽い。閉じられたら ffmpeg も止める
 */
function audioOnly(path: string, request: Request): Response {
    const headers = { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store' };
    // HEAD は形だけ答える。焼き直しを起こさない
    if (request.method === 'HEAD') return new Response(null, { headers });
    const ffmpeg = Bun.spawn(
        [
            config.ffmpeg,
            '-hide_banner',
            '-nostats',
            '-loglevel',
            'error',
            '-i',
            path,
            '-map',
            '0:a:0',
            '-vn',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-f',
            'adts',
            'pipe:1',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
    );
    // `-loglevel error` なので出るのは失敗の理由だけ。落ちたときにログへ回す
    const stderr = new Response(ffmpeg.stderr).text().catch(() => '');
    let canceled = false;
    const reader = ffmpeg.stdout.getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (!done) {
                controller.enqueue(value);
                return;
            }
            /*
             * **途中で落ちたら、ログに残して応答もエラーで終える。** 200 のまま静かに閉じると、
             * 受け手は最後まで届いたと思い、どこで何が起きたのかも残らなかった (レビュー指摘)
             */
            const code = await ffmpeg.exited;
            // 受け手が閉じたあとは、もう閉じてある (二度閉じると投げる)
            if (canceled) return;
            if (code === 0) {
                controller.close();
                return;
            }
            const why = (await stderr).trim().split('\n').slice(-3).join(' / ');
            console.warn(`[audio] 音声だけの取り出しが止まりました (${code}): ${path}: ${why}`);
            controller.error(new Error(`ffmpeg exited with ${code}`));
        },
        cancel() {
            canceled = true;
            ffmpeg.kill();
        },
    });
    return new Response(body, { headers });
}

/**
 * 録画ファイルをそのまま配る。
 * プレイヤーに URL を渡して直接再生させるための口。
 */
function respond(
    id: string,
    request: Request,
    download: boolean,
    source: FileSource | null,
    audio = false,
): Response {
    const recording = recordingOr404(id);

    /*
     * どのファイルを配るか。
     *
     * 基本はエンコード済み、無ければ生TS。ただし**エンコードが走っている間は
     * 生TSのほう**を配る。録り直しの最中は library_path がまだ古いファイルを
     * 指していて、しかもその古いファイルは終わり際に消えるので、
     * 押した瞬間によって出るものが変わっていた
     */
    const encoding = activeEncodeJob(recording.id) !== undefined;
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
                : encoding && recording.ts_path !== null
                  ? recording.ts_path
                  : (recording.library_path ?? recording.ts_path);
    if (path === null) error(404, 'ファイルがありません');
    if (audio) return audioOnly(path, request);

    // ?download=1 のときだけ添付にする。プレイヤーは inline のほうが素直に開く
    return serveFile(
        path,
        path.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp2t',
        request,
        contentDisposition(basename(path), download),
    );
}

// HEAD も同じ道 (中身を出すかは serveFile が request.method で決める)
export function GET({ params, request, url }) {
    return respond(
        params.id,
        request,
        url.searchParams.get('download') === '1',
        parseFileSource(url.searchParams.get('source')),
        url.searchParams.get('audio') === 'only',
    );
}
export const HEAD = GET;
