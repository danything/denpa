import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
/**
 * エージェントへの呼び出し。**HTTPS で、お互いを証明書で確かめる** (docs/agent.md)。
 *
 * - こちらの証明書は自分で作る (`<dataDir>/tls/denpa.key` / `denpa.crt`。自己署名)
 * - エージェントの証明書は、組んだときに DB の行に保存する (`agents.cert`)。その証明書そのものを
 *   `ca` にして繋ぐので、`TUNER_AGENT_URL` をどんな名前・IP で書いても通る (名前は見ない)
 * - 組むのは合言葉 (`TUNER_AGENT_URL` の `#pair=…`) が同じものどうしだけ。保存した証明書で
 *   繋がらない・エージェントに断られたときは、合言葉があれば組み直してもう 1 度だけ試す
 *
 * 合言葉はログにも不具合報告にも DB にも出さない (`agentSecrets`)。
 */
import { connect } from "node:tls";

import {
  createIdentity,
  derToPem,
  fingerprint,
  type Identity,
  pairProof,
  pemToDer,
} from "./agent-identity";
import { type Agent, agentCert, rememberAgentCert } from "./agents";
import { config } from "./config";

// --- 置き場 -------------------------------------------------------------------

const tlsDir = () => `${config.dataDir}/tls`;

function writeSecret(path: string, text: string): void {
  mkdirSync(tlsDir(), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // 権限を持てない置き場 (Windows のボリュームなど) ではそのまま
  }
}

let own: { dir: string; identity: Identity } | null = null;

/** こちらの鍵と証明書。無ければ作って残す。置き場ごとに 1 度だけ読む */
function ownIdentity(): Identity {
  const dir = tlsDir();
  if (own?.dir !== dir) own = { dir, identity: loadIdentity(dir) };
  return own.identity;
}

function loadIdentity(dir: string): Identity {
  const keyPath = `${dir}/denpa.key`;
  const certPath = `${dir}/denpa.crt`;
  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath, "utf8");
    return {
      key: readFileSync(keyPath, "utf8"),
      cert,
      fingerprint: fingerprint(pemToDer(cert)),
    };
  }
  const identity = createIdentity("denpa");
  writeSecret(keyPath, identity.key);
  writeSecret(certPath, identity.cert);
  return identity;
}

// --- 組む ---------------------------------------------------------------------

/** 相手の証明書を、確かめずに取得する (このあと合言葉で確かめる) */
function peerCertificate(
  origin: string,
  identity: Identity,
): Promise<Uint8Array> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || 443),
        servername: /^[\d.]+$|:/.test(url.hostname) ? undefined : url.hostname,
        /*
         * ここでは確かめない (まだ覚えていない相手の証明書を取得するので)。取った証明書は、このあと
         * 合言葉の証し (pairProof) で相手が同じ合言葉を持つと確かめてからしか覚えない
         */
        rejectUnauthorized: false, // lgtm[js/disabling-certificate-validation]
        cert: identity.cert,
        key: identity.key,
      },
      () => {
        const raw = socket.getPeerCertificate(true)?.raw;
        socket.end();
        if (raw) resolve(new Uint8Array(raw));
        else reject(new Error("エージェントが証明書を出しませんでした"));
      },
    );
    socket.setTimeout(10_000, () =>
      socket.destroy(new Error("エージェントに繋がりません (10 秒)")),
    );
    socket.on("error", reject);
  });
}

type TlsOptions = ReturnType<typeof makeTlsOptions>;
const tlsCache = new WeakMap<Identity, Map<string, TlsOptions>>();

/** `fetch` の `tls`。同じ相手には同じものを渡す */
function tlsOptions(identity: Identity, ca: string): TlsOptions {
  let byCa = tlsCache.get(identity);
  if (byCa === undefined) tlsCache.set(identity, (byCa = new Map()));
  let options = byCa.get(ca);
  if (options === undefined) {
    options = makeTlsOptions(identity, ca);
    byCa.set(ca, options);
  }
  return options;
}

function makeTlsOptions(identity: Identity, ca: string) {
  return {
    ca,
    cert: identity.cert,
    key: identity.key,
    // 証明書そのものを ca にしているので、名前は見ない
    checkServerIdentity: () => undefined,
  };
}

/** 組んでいる途中のもの (行の ID ごと)。別のエージェントとは同時に組める */
const pairing = new Map<number, Promise<void>>();

/** 合言葉で組み、相手の証明書を行に保存する。同じエージェントに同時に呼ばれても 1 度だけ */
function pair(target: Agent): Promise<void> {
  const running = pairing.get(target.id);
  if (running !== undefined) return running;
  const done = (async () => {
    const token = target.pair;
    if (token === null) {
      throw new Error(
        "エージェントとまだ組んでいません。TUNER_AGENT_URL に #pair=<合言葉> を付けてください (エージェントのログか `denpa-agent --pair` に出ます。docs/agent.md)",
      );
    }
    const identity = ownIdentity();
    const peer = await peerCertificate(target.origin, identity);
    const agent = fingerprint(peer);
    const peerPem = derToPem(peer);
    const res = await fetch(`${target.origin}/denpa/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: identity.fingerprint,
        proof: pairProof(token, "client", agent, identity.fingerprint),
      }),
      signal: AbortSignal.timeout(10_000),
      tls: tlsOptions(identity, peerPem),
    });
    const body = (await res.json().catch(() => null)) as {
      proof?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok) {
      const why =
        typeof body?.error === "string" ? body.error : `${res.status}`;
      throw new Error(`エージェントと組めません: ${why}`);
    }
    if (
      body?.proof !== pairProof(token, "agent", agent, identity.fingerprint)
    ) {
      throw new Error(
        "エージェントと組めません: 相手の合言葉が違います (別の相手に繋がっているかもしれません)",
      );
    }
    rememberAgentCert(target.id, peerPem, agent);
    console.log(
      `[agent] エージェント (${target.name}・${agent.slice(0, 16)}) と組みました`,
    );
  })();
  pairing.set(target.id, done);
  const clear = () => {
    if (pairing.get(target.id) === done) pairing.delete(target.id);
  };
  done.then(clear, clear);
  return done;
}

/** TLS の確かめで落ちたか (覚えた証明書と違う相手) */
function isTrustError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_SIGNATURE|CERT_UNTRUSTED|UNABLE_TO_GET_ISSUER|CERT_NOT_YET_VALID|CERT_HAS_EXPIRED/.test(
      code,
    )
  );
}

/** エージェントの 403 のうち、組んでいないと断られたものか (本文の `paired: false`。文言は見ない) */
async function notPaired(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { paired?: unknown } | null;
  return body?.paired === false;
}

/**
 * 決まったエージェントを呼ぶ。`path` は `/denpa/...`。返すのはふつうの `fetch` の応答。
 * どのエージェントに送るかは呼ぶ側が決める (`agents.ts` の `listAgents`・`primaryAgent`。選局は `tuner.openChannel` が振り分ける)。
 * まだ組んでいない・保存した証明書と合わない・組んでいないと断られた、のどれかなら、合言葉で組み直して 1 度だけ試し直す。
 * 試し直すので、`init.body` は文字列など何度でも送れるものにする (いまの呼び出し元はどれも JSON の文字列か本文なし)
 */
export async function fetchAgent(
  target: Agent,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const ca = agentCert(target.id);
    if (ca === null) throw new NeedsPairing();
    try {
      return await fetch(`${target.origin}${path}`, {
        ...init,
        tls: tlsOptions(ownIdentity(), ca),
      });
    } catch (error) {
      if (isTrustError(error)) throw new NeedsPairing();
      throw error;
    }
  };
  try {
    const res = await attempt();
    if (res.status !== 403 || target.pair === null) return res;
    if (!(await notPaired(res))) return res;
  } catch (error) {
    if (!(error instanceof NeedsPairing)) throw error;
  }
  if (init.signal?.aborted) throw init.signal.reason;
  await pair(target);
  return attempt();
}

class NeedsPairing extends Error {}
