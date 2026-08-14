import { json } from '@sveltejs/kit';
import { recordingOr404 } from '$lib/server/recording';
import { mintShareToken } from '$lib/server/share';

/**
 * 期限付きの再生リンクを1本作る (`share.ts`)。
 *
 * **ここは普通の HTTP なので、認証がそのまま効く** — リンクを作れるのは
 * denpa に入れる人だけ。返すURLは出先のプレイヤーにそのまま貼れる。
 * 起点はリクエストの origin — 画面を開いている名前なら、その端末の近くからも
 * 引ける見込みがいちばん高い。
 *
 * `?source=` を付けると、配るファイルの名指し (`file/+server.ts` と同じ語彙)
 * ごとリンクに焼き込む。テレビごとのコーデック設定 (AV1 を解けないテレビに
 * H.264 や生TSを渡す) がこれを使う。知らない値は黙って落とす — リンクは
 * おまかせ (今いいほう) になるだけ
 */
export function POST({ params, url }) {
    const recording = recordingOr404(params.id);
    const { token, expiresAt } = mintShareToken(recording.id);
    const source = url.searchParams.get('source');
    const named = source === 'ts' || source === 'alt' || source === 'encoded' ? `&source=${source}` : '';
    return json({
        url: `${url.origin}/api/recordings/${recording.id}/file?token=${token}${named}`,
        expiresAt,
    });
}
