/**
 * テストと開発用の偽のエージェントに要る TLS と「組む」受け答え (`tests/fake/agent.ts` と単体テストで使う)。
 *
 * 本物 (agent/Denpa.Agent/AgentTls.cs) との違いは 1 つで、**相手の証明書を見ない。** Bun.serve からは
 * クライアント証明書を読めないので、denpa が名乗った指紋 (`client`) をそのまま信じて証しを返す。
 * denpa 側の確かめ (証しを確かめて証明書を覚える) は本物と同じに通る。
 */
import { createIdentity, type Identity, pairProof } from "./agent-identity";

/** 偽のエージェントの合言葉 */
export const FAKE_AGENT_PAIR = "fake-agent-pair";

let identity: Identity | null = null;

/** 偽のエージェントの鍵と証明書。プロセスの中では 1 つ (組み直しを起こさないため) */
export function fakeAgentIdentity(): Identity {
  identity ??= createIdentity("denpa-agent");
  return identity;
}

/** Bun.serve の `tls`。`own` を渡せば、その鍵と証明書の偽のエージェントになる (2 台目のエージェント) */
export function fakeAgentTls(own: Identity = fakeAgentIdentity()): {
  key: string;
  cert: string;
  requestCert: true;
  rejectUnauthorized: false;
} {
  const { key, cert } = own;
  return { key, cert, requestCert: true, rejectUnauthorized: false };
}

/**
 * `POST /denpa/pair` (組む) と `DELETE /denpa/pair` (登録を消す) なら答えを返す。ほかは null。`own` はこの偽のエージェントの鍵と証明書。
 * 組んだ相手を覚えないので、消しても 204 を返すだけ
 */
export async function answerPairing(
  request: Request,
  own: Identity = fakeAgentIdentity(),
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/denpa/pair") return null;
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return null;
  const body = (await request.json().catch(() => null)) as {
    client?: unknown;
    proof?: unknown;
  } | null;
  const agent = own.fingerprint;
  const client = typeof body?.client === "string" ? body.client : "";
  if (body?.proof !== pairProof(FAKE_AGENT_PAIR, "client", agent, client)) {
    return Response.json({ error: "合言葉が違います" }, { status: 403 });
  }
  return Response.json({
    proof: pairProof(FAKE_AGENT_PAIR, "agent", agent, client),
  });
}

/** 偽のエージェントを指す `TUNER_AGENT_URL` */
export function fakeAgentUrl(port: number, host = "127.0.0.1"): string {
  return `https://${host}:${port}#pair=${FAKE_AGENT_PAIR}`;
}

/**
 * 単体テスト用: `fetch` を受ける偽のエージェントを立てる。組む受け答えは前に挟む。
 * `config.agentUrl = fakeAgentUrl(server.port)` で指す。`own` を渡せば別の鍵と証明書で立てる (2 台目のエージェント)
 */
export function serveFakeAgent(
  fetch: (request: Request) => Response | Promise<Response>,
  own: Identity = fakeAgentIdentity(),
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: fakeAgentTls(own),
    async fetch(request) {
      return (await answerPairing(request, own)) ?? fetch(request);
    },
  });
}

/** `/denpa/card` の答え。カードが 1 枚読めていて、それを使っている (契約・EMM のテスト用) */
export const ONE_CARD = {
  ok: true,
  message: "",
  source: "local",
  readers: [
    {
      name: "CardReader",
      card: true,
      ids: ["0000111122223333"],
      active: true,
      tuners: [],
    },
  ],
};
