import { type Agent, listAgents, NO_AGENT } from "#lib/server/agents.js";
import {
  agentAbout,
  agentLogs,
  knownValues,
  serverEnvironment,
  serverLogLines,
} from "#lib/server/diagnostics.js";
import { cardStatus } from "#lib/server/scramble.js";
import { getTuners, pinKey } from "#lib/server/tuner.js";

/**
 * 「バージョンと環境」と「ログ」の節 (前の「診断」)。動いている環境 (denpa とエージェントのバージョン・OS・チューナー・カードリーダー) と、サーバとエージェントのログ。
 * バグを報告するとき、ここから伏せた報告を作って GitHub の Issue を開く (`#lib/issue-report.ts`)。
 *
 * **エージェントのバージョンとログは、全部のエージェントから 1 台ずつ取る** (`agents` と同じ並び)。
 * エージェントが無い・`TUNER_AGENT_URL` が読めないときは、その理由を `agentsError` に入れる。
 *
 * **秘密の値 (OIDC のクライアントシークレット・Webhook の URL) は、画面に送る前にログから消す。**
 * ホスト名は画面にはそのまま出し (自分の家の作りを見るのは本人)、Issue に貼るときに伏せる。
 * そのために伏せるホスト名 (`hosts`) を渡す
 */
export function load(url: URL) {
  const known = knownValues(url.hostname);
  let all: Agent[] = [];
  let agentsError: string | null = null;
  try {
    all = listAgents();
    if (all.length === 0) agentsError = NO_AGENT;
  } catch (error) {
    agentsError = error instanceof Error ? error.message : String(error);
  }
  return {
    environment: serverEnvironment(),
    hosts: known.hosts,
    serverLogs: serverLogLines(known),
    agents: all.map((agent) => ({ id: agent.id, name: agent.name })),
    agentsError,
    // エージェント待ちのものは promise のまま返して後から流し込む (待つと画面が出ない)
    agentLogs: Promise.all(all.map((agent) => agentLogs(agent, known))),
    agentAbout: Promise.all(all.map((agent) => agentAbout(agent, known))),
    // 「その他」のライブのチューナーの選択肢もこれから作る (エージェントごとに `/denpa/tuners` を 1 回だけ呼ぶ)。名指しは `<エージェントの ID>:<pin>`
    tuners: getTuners()
      .then((got) => ({
        list: got.map((tuner) => ({
          name: tuner.name,
          pin: pinKey(tuner),
          agent: tuner.agent,
          agentName: all.find((agent) => agent.id === tuner.agent)?.name ?? "",
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
