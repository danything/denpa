import { json } from '@sveltejs/kit';
import { recordingOr404 } from '$lib/server/recording';
import { mintShareToken } from '$lib/server/share';
import { displayTitle } from '$lib/server/title';

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
 *
 * **URL の尻に番組名を置く** (`/file/<番組名>.mkv`)。テレビの VLC (Android) は
 * 再生画面の見出しに **URL の最後の区切りから拡張子を除いたもの** を出す
 * (vlc-android の VideoPlayerActivity / MediaWrapper.getTitle を確認)。入れ物の
 * title は履歴や通知にしか回らず、見出しには効かない。名前の区切りは
 * サーバでは読み捨てる (`file/[name]/+server.ts`) — 資格はトークンだけ
 */
export function POST({ params, url }) {
    const recording = recordingOr404(params.id);
    const { token, expiresAt } = mintShareToken(recording.id);
    const source = url.searchParams.get('source');
    const named = source === 'ts' || source === 'alt' || source === 'encoded' ? `&source=${source}` : '';
    // 名前の中の区切り文字はパスの段を増やすので寄せておく。見た目だけの部分なので厳密でなくてよい
    const label = displayTitle(recording.name).replace(/[/\\]/g, '／') || String(recording.id);
    const name = encodeURIComponent(`${label}.${source === 'ts' ? 'ts' : 'mkv'}`);
    return json({
        url: `${url.origin}/api/recordings/${recording.id}/file/${name}?token=${token}${named}`,
        expiresAt,
    });
}
