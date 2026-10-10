import { json } from '@sveltejs/kit';
import { publicBase } from '#lib/server/paths.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { mintShareToken, shareUrl } from '#lib/server/share.js';
import { parseFileSource } from '#lib/source.js';

/**
 * 期限付きの再生リンクを作る (`share.ts`)。返す `url` は録画のファイルの口に `?token=` を付けたもの。
 *
 * **ここは普通の HTTP なので、認証がそのまま効く** — リンクを作れるのは
 * denpa に入れる人だけ。
 * 起点はリクエストの origin (前段が剥がした接頭辞も足す。`paths.publicBase`) —
 * 画面を開いている名前なら、その端末の近くからも引ける見込みがいちばん高い。
 *
 * `?source=` を付けると、配るファイルの名指し (`file/+server.ts` と同じ語彙)
 * ごとリンクに焼き込む (ダウンロードの口が H.264 や生TSを名指しするとき)。
 * 知らない値は黙って落とす — リンクはおまかせ (今いいほう) になるだけ
 */
export function POST({ params, url, request }) {
    const recording = recordingOr404(params.id);
    const { token, expiresAt } = mintShareToken(recording.id);
    return json({
        url: shareUrl(
            recording.id,
            publicBase(url, request.headers),
            token,
            parseFileSource(url.searchParams.get('source')),
        ),
        expiresAt,
    });
}
