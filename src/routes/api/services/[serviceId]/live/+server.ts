import { error } from '@sveltejs/kit';
import { askedTrack } from '#lib/arib.js';
import { liveStream } from '#lib/server/live.js';

/**
 * **ライブを HTTP で流す** (画面の外のもの向けの口。docs/api.md)。
 *
 * 画面と同じ焼き方の fragmented MP4 を流し続ける。既定は H.264 / AAC (Cast・テレビ・
 * いちばん広く再生できる)。`?codec=av1` で AV1 / Opus、`?codec=raw` で焼かずに
 * 1局に絞っただけの生の TS (MPEG-2。テレビのアプリ向け。Content-Type で分かる)。
 * `?audio=only` で音声だけ (AAC の fMP4。画面の無いスピーカーへの Cast 向け。録画の口と同じ書き方)。
 * `?audio=<音声ID>` (`now.audios` の `id`。`0:sub` など) で焼く音声を選ぶ。知らないものは主音声、生では効かない。
 * 画面の視聴者と同じチューナーの取り合いに乗り、閉じれば降りる (live.ts の liveStream)
 */
export function GET({ params, url }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isInteger(serviceId)) error(400, '局IDが不正です');
    const asked = url.searchParams.get('codec');
    const audio = url.searchParams.get('audio');
    const codec = audio === 'only' ? 'audio' : asked === 'av1' || asked === 'raw' ? asked : 'h264';
    const stream = liveStream(serviceId, codec, askedTrack(audio));
    if (stream === null) error(404, '局がありません');
    return new Response(stream, {
        headers: {
            'Content-Type': codec === 'raw' ? 'video/mp2t' : codec === 'audio' ? 'audio/mp4' : 'video/mp4',
            'Cache-Control': 'no-store',
        },
    });
}
