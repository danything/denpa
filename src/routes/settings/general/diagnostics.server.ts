import { type Agent, listAgents, NO_AGENT } from "#lib/server/agents.js";
import { tokenRefusal } from "#lib/server/auth.js";
import {
  agentAbout,
  agentLogs,
  knownValues,
  recentFaults,
  serverEnvironment,
  serverLogLines,
} from "#lib/server/diagnostics.js";
import { type CardStatus, cardStatus } from "#lib/server/scramble.js";
import { type AgentTuner, getTuners, pinKey } from "#lib/server/tuner.js";

/** 「その他」のライブのチューナーの選択肢の 1 つ (`load` の `tuners`)。名指しは `pin` (`<エージェントの ID>:<pin>`。`pinKey`) */
type TunerChoice = Pick<
  AgentTuner,
  "name" | "agent" | "types" | "disabled" | "error" | "signal"
> & {
  pin: string;
  agentName: string;
  /** 使っている用途 (`StreamUse` の先頭の語。`rec`・`live`・`epg`・`scan`・`logo`)。録画の ID のような後ろは渡さない */
  uses: string[];
};

/** チューナーの選択肢と、取れなかったときの理由。取れたときは null */
interface TunerChoices {
  list: TunerChoice[];
  error: string | null;
}

/**
 * 「バージョンと環境」と「ログ」の節 (前の「診断」)。動いている環境 (denpa とエージェントのバージョン・OS・サーバの CPU と GPU・チューナー・カードリーダー) と、
 * サーバとエージェントのログ・機材の異常 (`faults`)。チューナーには、受信の状態と C/N (`signal`) と使っている用途 (`uses`) も添える。
 * バグを報告するとき、ここから伏せた報告を作って GitHub の Issue を開く (`#lib/issue-report.ts`)。
 *
 * **エージェントのバージョンとログ・チューナー・カードリーダーは、全部のエージェントから取る** (`agents` と同じ並び)。
 * エージェントが無い・`TUNER_AGENT_URL` が読めないときは、その理由を `agentsError` に入れる。
 *
 * **秘密の値 (OIDC のクライアントシークレット・Webhook の URL) は、画面に送る前にログから消す。**
 * ホスト名は画面にはそのまま出し (自分の家の作りを見るのは本人)、Issue に貼るときに伏せる。
 * そのために伏せるホスト名 (`hosts`) を渡す。
 *
 * **アクセストークン (テレビのアプリ) には、ログとエージェントごとのものを返さない** (設定の「受信」の
 * `agents.server.ts`・`tuners.server.ts` と同じ)。ログやカードを配る側の URL から、エージェントのある場所が分かる。
 * 機材の異常 (`faults`) も返さない。返すのはサーバのバージョンと環境 (CPU と GPU を含む)、断った理由 (`agentsError`) だけ。形は同じで、中身を空にする
 */
export function load(url: URL, locals: { token?: number }) {
  const refused = tokenRefusal(locals);
  const known = knownValues(url.hostname);
  let all: Agent[] = [];
  let agentsError: string | null = refused;
  if (refused === null) {
    try {
      all = listAgents();
      if (all.length === 0) agentsError = NO_AGENT;
    } catch (error) {
      agentsError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    environment: serverEnvironment(),
    hosts: refused === null ? known.hosts : [],
    serverLogs: refused === null ? serverLogLines(known) : [],
    agents: all.map((agent) => ({ id: agent.id, name: agent.name })),
    agentsError,
    /** エージェントが知らせた機材の異常 (`agent_faults`)。新しい `FAULT_LINES` 件を古い順に。「Issue にする」のチューナーの記録に入れる */
    faults: refused === null ? recentFaults(known) : [],
    // エージェント待ちのものは promise のまま返して後から流し込む (待つと画面が出ない)
    agentLogs: Promise.all(all.map((agent) => agentLogs(agent, known))),
    agentAbout: Promise.all(all.map((agent) => agentAbout(agent, known))),
    // 「その他」のライブのチューナーの選択肢もこれから作る (エージェントごとに `/denpa/tuners` を 1 回だけ呼ぶ)。名指しは `<エージェントの ID>:<pin>`
    tuners:
      refused === null
        ? getTuners()
            .then((got): TunerChoices => ({
              list: got.map((tuner) => ({
                name: tuner.name,
                pin: pinKey(tuner),
                agent: tuner.agent,
                agentName:
                  all.find((agent) => agent.id === tuner.agent)?.name ?? "",
                types: tuner.types,
                disabled: tuner.disabled,
                error: tuner.error,
                signal: tuner.signal,
                uses: [
                  ...new Set(
                    tuner.users.map((user) => user.use.split(" ")[0]!),
                  ),
                ],
              })),
              error: null,
            }))
            .catch((error: unknown): TunerChoices => ({
              list: [],
              error: String(error),
            }))
        : Promise.resolve<TunerChoices>({ list: [], error: refused }),
    card:
      refused === null
        ? cards(all)
        : Promise.resolve<CardStatus>({
            ok: false,
            message: refused,
            source: "local",
            ids: [],
            tuners: [],
            readers: [],
          }),
  };
}

/**
 * 全部のエージェントのカードリーダーを、エージェントの並びの順につなげたもの (チューナーと同じ)。
 * リーダーが 1 つも無いときの理由は、最初に理由を返したエージェントのもの
 */
async function cards(all: Agent[]): Promise<CardStatus> {
  const got = await Promise.all(all.map((agent) => cardStatus(agent)));
  const first = got[0] ?? (await cardStatus());
  return {
    ...first,
    message: got.find((card) => card.message !== "")?.message ?? first.message,
    readers: got.flatMap((card) => card.readers),
  };
}
