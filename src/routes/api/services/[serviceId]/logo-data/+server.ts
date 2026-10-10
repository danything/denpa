import { error } from '@sveltejs/kit';
import { readLearnedLogo } from '#lib/server/logo-data.js';

/**
 * その局について CM検出のために**覚えたロゴ**を絵にして返す。
 *
 * 番組表に出すロゴ (`/api/services/<id>/logo`) とは別物。あちらは放送波から
 * 拾った局のマークで、こちらは「画面のどこにロゴが出ているか」を録画から
 * 覚えたもの。覚えているものが絵になっていない (ロゴではない縁を拾った) とき、
 * それを確かめる手立てが要る。
 *
 * 線の向きの揃い方を明るさにした白黒 (縁が白)。原寸は小さいので、出す側で拡大する。
 */
export function GET({ params }) {
    const logo = readLearnedLogo(Number(params.serviceId));
    if (logo === null) error(404, 'まだロゴを覚えていません');

    return new Response(new Uint8Array(logo.png), {
        headers: {
            'Content-Type': 'image/png',
            // 焼くたびに書き直す。画面は書いた時刻を URL に付けて取り直す
            'Cache-Control': 'no-cache',
            'X-Logo-Learned-At': String(logo.learnedAt),
        },
    });
}
