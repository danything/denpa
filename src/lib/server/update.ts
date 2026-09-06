/**
 * 新しい版が出ているか。**GitHub のリリースが、動いているコミットより先か**を見る。
 *
 * 動いているのはコミット (`config.commit`。イメージを組むときに入る)。GitHub の
 * 「最新のリリース」の札を取り、compare API でそのコミットとの前後を訊く
 * (`/compare/<コミット>...<札>`)。**リリースのほうが先 (`ahead`) なら知らせる。**
 *
 * 版の札を焼き込んで数で比べる手は取らない — リリースはイメージを組み直さず
 * main のものに名前を貼るだけなので (release.yml)、v1.8.0 のイメージの中身は
 * 「v1.7.1 の後の main」でしかなく、自分が v1.8.0 だと知りようがない。
 * コミットなら組んだときに必ず分かり、前後は GitHub が知っている。
 *
 * **リリースを消せば知らせも消える** — 「最新」は消したあとの版になるので、次に
 * 見比べたときに引っ込む。手元や試験の `dev` では何も出さない。繋がらないときは
 * **前に分かっていたことをそのまま持つ** (消すと点滅する)。1 時間に 2 回の呼び出し
 * (認証なしの GitHub API は 60 回/時)
 */

import { boolean, type Infer, literal, object, optional, read, string } from '../shape';
import { config } from './config';

const RELEASE = object({
    tag_name: string,
    html_url: string,
    draft: optional(boolean),
    prerelease: optional(boolean),
});
type Release = Infer<typeof RELEASE>;

/** compare API の答えのうち見るもの。`base...head` で head が base より先なら `ahead` */
const COMPARISON = object({ status: literal('ahead', 'behind', 'identical', 'diverged') });

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

/**
 * 見比べる。**外に出る呼び出しはここだけ。** 試験は `fetcher` を差し替える
 *
 * 404 は「リリースが 1 つも無い」なので知らせ無し。それ以外の失敗は前の結果を持つ
 */
export async function checkForUpdate(fetcher: Fetcher = fetch): Promise<Available | null> {
    if (config.commit === 'dev') {
        available = null;
        return available;
    }
    const get = async (path: string): Promise<Response> =>
        fetcher(`${config.githubApi}${path}`, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'denpa' },
            signal: AbortSignal.timeout(10_000),
        });
    try {
        const res = await get('/releases/latest');
        if (res.status === 404) {
            // 繋がった (リリースが 1 つも無いだけ)。次に繋がらなくなったら、また言う
            available = null;
            warned = false;
            return available;
        }
        if (!res.ok) throw new Error(`releases/latest が ${res.status} を返しました`);
        const release: Release = read(RELEASE, await res.json(), 'GitHub のリリース');

        let ahead = false;
        if (!(release.draft ?? false) && !(release.prerelease ?? false)) {
            const compared = await get(`/compare/${config.commit}...${encodeURIComponent(release.tag_name)}`);
            if (!compared.ok) throw new Error(`compare が ${compared.status} を返しました`);
            ahead = read(COMPARISON, await compared.json(), 'GitHub の compare').status === 'ahead';
        }
        available = ahead ? { version: release.tag_name, url: release.html_url } : null;
        warned = false;
    } catch (error) {
        if (!warned) {
            warned = true;
            console.warn(`[update] 新しい版が出ているか確かめられません (${config.githubApi}): ${error}`);
        }
    }
    return available;
}
