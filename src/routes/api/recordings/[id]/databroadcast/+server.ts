import { json } from '@sveltejs/kit';
import { sidecarPaths } from '$lib/server/metadata';
import { loadRecordedBml } from '$lib/server/recorded-bml';
import { recordingOr404 } from '$lib/server/recording';

/**
 * 録画のデータ放送 (再生位置つきの変化ログ)。**d ボタンで開いたときに読む。**
 *
 * 焼くときに元TSから取り出してサイドカーへ置いてある (`server/recorded-bml.ts`)。
 * ここは録画IDから場所を引いて、そのまま JSON で配るだけ。持っていない録画
 * (データ放送の無い局・古い録画) は空を返す — 画面はそれで「出せない」を出す。
 */
export function GET({ params }) {
    const recording = recordingOr404(params.id);
    // サイドカーは主 (library_path) の隣。焼き上がっていなければ持っていない
    if (recording.library_path === null) return json([]);

    return json(loadRecordedBml(sidecarPaths(recording.library_path).dataBroadcast));
}
