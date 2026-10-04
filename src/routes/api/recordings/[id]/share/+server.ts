import { json } from '@sveltejs/kit';
import { publicBase } from '#lib/server/paths.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { mintShareToken, shareUrls } from '#lib/server/share.js';
import { parseFileSource } from '#lib/source.js';

/**
 * 期限付きの再生リンクを作る (`share.ts`)。
 *
 * **ここは普通の HTTP なので、認証がそのまま効く** — リンクを作れるのは
 * denpa に入れる人だけ。返すURLは出先のプレイヤーにそのまま貼れる。
 * 起点はリクエストの origin (前段が剥がした接頭辞も足す。`paths.publicBase`) —
 * 画面を開いている名前なら、その端末の近くからも引ける見込みがいちばん高い。
 *
 * `?source=` を付けると、配るファイルの名指し (`file/+server.ts` と同じ語彙)
 * ごとリンクに焼き込む。AV1 を解けないプレイヤーに H.264 や生TSを渡すときに使う。
 * 知らない値は黙って落とす — リンクは
 * おまかせ (今いいほう) になるだけ。
 *
 * 返すのは 2 本: `url` はファイルそのもの (コピーして貼る用、頭から)、
 * `playlist` はそれを**続きの位置から**指す XSPF (続きから始めさせたい
 * プレイヤー向け。`server/playlist.ts`)。URL の形は `shareUrls` に
 */
export function POST({ params, url, request }) {
    const recording = recordingOr404(params.id);
    const { token, expiresAt } = mintShareToken(recording.id);
    const links = shareUrls(
        recording,
        publicBase(url, request.headers),
        token,
        parseFileSource(url.searchParams.get('source')),
    );
    return json({ url: links.file, playlist: links.playlist, expiresAt });
}
