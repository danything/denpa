import type { GuideSheet } from "#lib/types.js";
import { resolve } from "$app/paths";

/**
 * 番組表のマスを取る。**外枠 (`+page.server.ts`) とは別の取得にして、promise のまま渡す。**
 *
 * 外枠には局の並びと日付が入っていて、局名の行と時刻の列はそれだけで描ける。マスは後から届き、
 * 届くまではマスのところだけ骨組みにする。
 *
 * **ブラウザでだけ取る。** サーバで描く HTML は外枠と骨組みまで — 取り込み直し (hydration) のときに
 * この load がブラウザでもう一度走るので、そこから取る。前日・翌日の先読み (`preloadData`) も
 * この load を通るので、マスまで取っておける。
 *
 * **転んでも投げ返さない。** 拒否のままだと骨組みで止まるうえ、先読みしたぶんは誰も受け取らない。
 * 理由を中身として返す (`GuideSheet.failed`)
 */
export function load({ data, fetch }) {
  return {
    ...data,
    sheet:
      typeof window !== "undefined"
        ? sheetOf(fetch, data.type, data.start)
        : null,
  };
}

async function sheetOf(
  fetch: typeof globalThis.fetch,
  type: string,
  start: number,
): Promise<GuideSheet> {
  try {
    const res = await fetch(resolve(`api/guide?type=${type}&start=${start}`));
    const body = (await res.json().catch(() => null)) as GuideSheet | null;
    if (res.ok && body !== null) return body;
    return {
      programs: [],
      failed: body?.failed ?? `${res.status} ${res.statusText}`,
    };
  } catch (error) {
    return { programs: [], failed: String(error) };
  }
}
