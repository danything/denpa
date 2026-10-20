import { json } from '@sveltejs/kit';
import { HOUR, programsOf, requestedDay, WINDOW_HOURS } from '#lib/server/guide.js';
import type { GuideSheet } from '#lib/types.js';
import { CHANNEL_TYPES } from '#lib/types.js';

/**
 * 番組表のマス (`guide/+page.ts` が取る)。**外枠 (局の並び・日付) とは別に取る。**
 *
 * 局名の行と時刻の列は外枠と一緒に届くので先に描ける。いちばん重い番組だけをここで後から取り、
 * 届くまではマスのところだけ骨組みにしておく。
 *
 * **転んでも 500 の本文に理由を入れて返す。** 画面は骨組みのまま止めずに理由を出す
 * (本当の理由はサーバのログにも残す)
 */
export function GET({ url }) {
    const type = CHANNEL_TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR';
    const start = requestedDay(url.searchParams.get('start'));
    try {
        return json({
            programs: programsOf(type, start, start + WINDOW_HOURS * HOUR),
            failed: null,
        } satisfies GuideSheet);
    } catch (error) {
        console.error('[guide] 番組表を組めませんでした', error);
        return json({ programs: [], failed: String(error) } satisfies GuideSheet, { status: 500 });
    }
}
