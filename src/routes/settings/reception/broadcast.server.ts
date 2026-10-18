import { type Actions, fail } from '@sveltejs/kit';
import { parsePrefectureField } from '#lib/prefecture.js';
import { normalizePostalCode, saveSettings, settings } from '#lib/server/settings.js';

export function load() {
    const current = settings();
    /** データ放送に渡すもの。郵便番号・都道府県と、双方向の中継を許すか */
    return {
        broadcast: {
            postalCode: current.postalCode,
            prefecture: current.prefecture,
            bmlNetwork: current.bmlNetwork,
        },
    };
}

export const actions = {
    /**
     * データ放送に渡す郵便番号と都道府県。
     *
     * **どちらも空にできる** (「渡さない」という選択。都道府県の未設定は 255)。
     * 空にしても危なくない — 放送のアプリが地域を決められなくなるだけ
     */
    saveBroadcast: async ({ request }) => {
        const form = await request.formData();
        const raw = String(form.get('postalCode') ?? '').trim();
        const postalCode = normalizePostalCode(raw);
        if (raw !== '' && postalCode === '') {
            return fail(400, { message: '郵便番号は数字7桁で入れてください (例 1000001)' });
        }
        // 選ぶ欄なので、表に無い番号は画面の外から来たもの。黙って未設定にせず断る
        const field = form.get('prefecture');
        const prefecture = parsePrefectureField(field === null ? null : String(field));
        if (prefecture === null) {
            return fail(400, { message: '都道府県の指定が正しくありません' });
        }
        saveSettings({ postalCode, prefecture, bmlNetwork: form.get('bmlNetwork') === 'on' });
        return { success: true, saved: true };
    },
} satisfies Actions;
