import { existsSync, readFileSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { sidecarPaths } from '$lib/server/metadata';
import { parseAss, toVtt } from '$lib/ts/ass';
import type { Recording } from '$lib/types';

/**
 * 字幕を WebVTT で返す。**ブラウザの `<track>` に渡せる唯一の形。**
 *
 * 元は動画の隣に置いてある `.ja.ass` (`server/subtitle.ts` の `buildText`)。
 * 入れ物の中に入っているのは PGS で、あれは絵なのでブラウザには渡せない。
 *
 * ## 置いてある形のまま渡さない
 *
 * 保存先に置くのは ASS のほうです。**Kodi は位置も色もそのまま出せる**ので、
 * 放送に近い見え方になる。ブラウザにはその形が無いので、ここで直す
 * (直し方と、そこで落ちるものは [ass.ts](../../../../../lib/ts/ass.ts))。
 *
 * ## 変えずに持っておく
 *
 * 直すのは一瞬 (実機で 70KB・600枚) なので控えは持たない。焼き直せば中身が
 * 変わるので、持つとかえって古いものを配ることになる。ブラウザには
 * `private` で持たせる — 字幕は番組の中身そのものなので、間に置かせない
 */
export function GET({ params, setHeaders }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');
    if (recording.library_path === null) error(404, '字幕がありません');

    const path = sidecarPaths(recording.library_path).subtitle;
    /*
     * **無いほうがふつう。** 字幕を持たない番組もあれば、この仕組みより前に
     * 焼いた録画もある (焼き直せば付く)。画面は字幕のボタンを出さない
     */
    if (!existsSync(path)) error(404, '字幕がありません');

    let vtt: string;
    try {
        vtt = toVtt(parseAss(readFileSync(path, 'utf8')));
    } catch {
        error(404, '字幕を読めませんでした');
    }

    setHeaders({
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'private, max-age=3600',
    });
    return new Response(vtt);
}
