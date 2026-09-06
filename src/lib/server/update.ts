/**
 * 新しい版が出ているか。**GitHub のリリースを見比べる。**
 *
 * 動いている版 (`config.version`。イメージを組むときに入る) と、GitHub の
 * 「最新のリリース」を 1 時間に 1 度見比べ、向こうが新しければヘッダーに出す
 * (`+layout.svelte`)。**リリースを消せば知らせも消える** — 「最新」は消したあとの
 * 版になるので、次に見比べたときに引っ込む。
 *
 * 手元や試験の `dev` では何も出さない。読めない札 (試し版の `v2.0.0-rc1` など) も同じ。
 * 繋がらないときは**前に分かっていたことをそのまま持つ** (消すと点滅する)。
 */

import { boolean, type Infer, object, optional, read, string } from '../shape';
import { config } from './config';

const RELEASE = object({
    tag_name: string,
    html_url: string,
    draft: optional(boolean),
    prerelease: optional(boolean),
});
type Release = Infer<typeof RELEASE>;

export interface Available {
    /** `v1.8.0` の形。そのまま画面に出す */
    version: string;
    /** リリースのページ */
    url: string;
}

/** 外に出る口。試験で差し替えられるように、fetch の要る分だけ */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let available: Available | null = null;
/** 繋がらなかった。1 回だけ言う (1 時間おきに同じことを言わない) */
let warned = false;

/** 直近に見比べた結果。画面はこれを読むだけ */
export function updateAvailable(): Available | null {
    return available;
}

/** `v1.7.1` → `[1, 7, 1]`。読めなければ null (`dev`、試し版) */
export function parseVersion(tag: string): [number, number, number] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
    if (match === null) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** a が b より新しいか */
export function newer(a: [number, number, number], b: [number, number, number]): boolean {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i]! > b[i]!;
    }
    return false;
}

/**
 * 見比べる。**外に出る呼び出しはここだけ。** 試験は `fetcher` を差し替える
 *
 * 404 は「リリースが 1 つも無い」なので知らせ無し。それ以外の失敗は前の結果を持つ
 */
export async function checkForUpdate(fetcher: Fetcher = fetch): Promise<Available | null> {
    const current = parseVersion(config.version);
    if (current === null) {
        available = null;
        return available;
    }
    try {
        const res = await fetcher(config.releasesUrl, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'denpa' },
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) {
            // 繋がった (リリースが 1 つも無いだけ)。次に繋がらなくなったら、また言う
            available = null;
            warned = false;
            return available;
        }
        if (!res.ok) throw new Error(`${res.status} を返しました`);
        const release: Release = read(RELEASE, await res.json(), 'GitHub のリリース');
        const latest = parseVersion(release.tag_name);
        available =
            latest !== null &&
            !(release.draft ?? false) &&
            !(release.prerelease ?? false) &&
            newer(latest, current)
                ? { version: release.tag_name, url: release.html_url }
                : null;
        warned = false;
    } catch (error) {
        if (!warned) {
            warned = true;
            console.warn(`[update] 新しい版が出ているか確かめられません (${config.releasesUrl}): ${error}`);
        }
    }
    return available;
}
