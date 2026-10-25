import {
  agentLogs,
  knownValues,
  serverEnvironment,
  serverLogLines,
} from "#lib/server/diagnostics.js";
import { cardStatus } from "#lib/server/scramble.js";
import { tunerList } from "#lib/server/tuner.js";

/**
 * 診断。動いている環境 (バージョン・OS・チューナー・カードリーダー) と、サーバとエージェントのログ。
 * バグを報告するとき、ここから伏せた報告を作って GitHub の Issue を開く (`#lib/issue-report.ts`)。
 *
 * **秘密の値 (OIDC のクライアントシークレット・Webhook の URL) は、画面に送る前にログから消す。**
 * ホスト名は画面にはそのまま出し (自分の家の作りを見るのは本人)、Issue に貼るときに伏せる。
 * そのために伏せるホスト名 (`hosts`) を渡す
 */
export function load({ url }) {
  const known = knownValues(url.hostname);
  return {
    environment: serverEnvironment(),
    hosts: known.hosts ?? [],
    serverLogs: serverLogLines(known),
    // エージェント待ちのものは promise のまま返して後から流し込む (待つと画面が出ない)
    agentLogs: agentLogs(known),
    tuners: tunerList()
      .then((got) => ({
        list: got.tuners.map((tuner) => ({
          name: tuner.name,
          types: tuner.types,
          disabled: tuner.disabled,
          error: tuner.error,
        })),
        error: null as string | null,
      }))
      .catch((error: unknown) => ({ list: [], error: String(error) })),
    card: cardStatus(),
  };
}
