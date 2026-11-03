/**
 * テストと開発用の偽のエージェントに要る TLS と「組む」受け答え (`tests/fake/agent.ts` と単体テストで使う)。
 *
 * 本物 (agent/Denpa.Agent/AgentTls.cs) との違いは 1 つで、**相手の証明書を見ない。** Bun.serve からは
 * クライアント証明書を読めないので、denpa が名乗った指紋 (`client`) をそのまま信じて証しを返す。
 * denpa 側の確かめ (証しを確かめて証明書を覚える) は本物と同じに通る。
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { createIdentity, pairProof } from "./agent-client";
import type { Identity } from "./agent-client";
import { config } from "./config";

/** 偽のエージェントの合言葉 */
export const FAKE_AGENT_PAIR = "fake-agent-pair";

let identity: Identity | null = null;

/** 偽のエージェントの鍵と証明書。プロセスの中では 1 つ (組み直しを起こさないため) */
export function fakeAgentIdentity(): Identity {
  identity ??= createIdentity("denpa-agent");
  return identity;
}

/** Bun.serve の `tls` */
export function fakeAgentTls(): {
  key: string;
  cert: string;
  requestCert: true;
  rejectUnauthorized: false;
} {
  const { key, cert } = fakeAgentIdentity();
  return { key, cert, requestCert: true, rejectUnauthorized: false };
}

/** `POST /denpa/pair` なら答えを返す。ほかは null */
export async function answerPairing(
  request: Request,
): Promise<Response | null> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/denpa/pair"
  )
    return null;
  const body = (await request.json().catch(() => null)) as {
    client?: unknown;
    proof?: unknown;
  } | null;
  const agent = fakeAgentIdentity().fingerprint;
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
 * `config.agentUrl = fakeAgentUrl(server.port)` で指す
 */
export function serveFakeAgent(
  fetch: (request: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: fakeAgentTls(),
    async fetch(request) {
      return (await answerPairing(request)) ?? fetch(request);
    },
  });
}

/**
 * 単体テスト用: 偽のエージェントの証明書を、組んだものとして覚えさせる (組む受け答えを持たない
 * `Bun.serve` を偽のエージェントにするとき。`tls: fakeAgentTls()` と一緒に使う)
 */
export function trustFakeAgent(): void {
  const dir = `${config.dataDir}/tls`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/agent.crt`, fakeAgentIdentity().cert);
}
