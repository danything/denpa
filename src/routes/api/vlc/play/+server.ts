import { error, json } from '@sveltejs/kit';
import { recordingOr404 } from '$lib/server/recording';
import { mintShareToken } from '$lib/server/share';
import { play, targets } from '$lib/server/vlc';

/**
 * 録画をテレビの VLC で再生させる (vlc.ts)。
 *
 * 渡すURLは**期限付きの再生リンク** (share.ts) — VLC はストリーム履歴に
 * URLを残すので、恒久パスワードやベーシック認証入りのURLは渡さない。
 * 起点はこの画面を開いている origin。テレビが同じ網に居るなら
 * そのまま引ける (LAN は TRUSTED_NETWORKS でも素通し)。
 *
 * 相手は**設定に書いてある居場所だけ** — 画面から任意のホストへ突かせない。
 */
export async function POST({ request, url }) {
    const body = (await request.json().catch(() => null)) as { host?: string; id?: number } | null;
    const host = body?.host ?? '';
    if (!targets().some((t) => t.host === host)) error(400, '設定にないテレビです');

    const recording = recordingOr404(String(body?.id));
    const { token } = mintShareToken(recording.id);
    const mediaUrl = `${url.origin}/api/recordings/${recording.id}/file?token=${token}`;
    return json(await play(host, mediaUrl));
}
