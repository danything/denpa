import { error, json } from '@sveltejs/kit';
import { completePairing, startPairing, targets } from '$lib/server/vlc';

/**
 * テレビの VLC とのペアリング (vlc.ts)。
 *
 * `code` なし: 始める — **テレビの画面に6桁のコードが出る** (60秒で切れる)。
 * `code` あり: そのコードで仕上げる。通れば以後「テレビで再生」が一発で効く。
 *
 * 相手は**設定に書いてある居場所だけ** — 画面から任意のホストへ突かせない。
 */
export async function POST({ request }) {
    const body = (await request.json().catch(() => null)) as { host?: string; code?: string } | null;
    const host = body?.host ?? '';
    if (!targets().some((t) => t.host === host)) error(400, '設定にないテレビです');

    const result =
        body?.code === undefined || body.code === ''
            ? await startPairing(host)
            : await completePairing(host, body.code);
    return json(result);
}
