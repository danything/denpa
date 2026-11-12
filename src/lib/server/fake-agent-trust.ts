/**
 * 単体テスト用: 偽のエージェント (`fake-agent.ts`) の証明書を、組んだものとして今のエージェントの行に保存する。
 * 組む受け答えを持たない `Bun.serve` を偽のエージェントにするとき (`tls: fakeAgentTls()` と一緒に使う)。
 * `config.agentUrl` と `config.dbPath` を決めてから呼ぶ。
 * DB を使うので `fake-agent.ts` とは分ける (あちらは Node の Playwright からも読む)
 */
import { primaryAgent, rememberAgentCert } from "./agents";
import { fakeAgentIdentity } from "./fake-agent";

export function trustFakeAgent(): void {
  const { cert, fingerprint } = fakeAgentIdentity();
  rememberAgentCert(primaryAgent().id, cert, fingerprint);
}
