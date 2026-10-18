import { redirect } from '@sveltejs/kit';
import { FIRST_SECTION } from '#lib/settings-sections.js';
import { resolve } from '$app/paths';

/**
 * **広い画面では先頭の節へ移る。** 狭い画面の `/settings` は節の一覧だけを出す画面
 * (`+layout.svelte`)。幅はサーバでは分からないので、ブラウザで見る。
 * 最初に開いたとき (サーバで描いたあと) も、ブラウザでもう1度ここを通る
 */
export function load() {
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
        redirect(307, resolve(`settings/${FIRST_SECTION}`));
    }
}
