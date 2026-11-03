/**
 * エージェントへの呼び出し。**HTTPS で、お互いを証明書で確かめる** (docs/agent.md)。
 *
 * - こちらの証明書は自分で作る (`<dataDir>/tls/denpa.key` / `denpa.crt`。自己署名)
 * - エージェントの証明書は、組んだときに覚える (`<dataDir>/tls/agent.crt`)。その証明書そのものを
 *   `ca` にして繋ぐので、`TUNER_AGENT_URL` をどんな名前・IP で書いても通る (名前は見ない)
 * - 組むのは合言葉 (`TUNER_AGENT_URL` の `#pair=…`) を知っている者どうしだけ。覚えた証明書で
 *   繋がらない・エージェントに断られたときは、合言葉があれば組み直してもう 1 度だけ試す
 *
 * 合言葉はログにも不具合報告にも出さない (`agentSecrets`)。
 */
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:tls";

import { config } from "./config";

/** `TUNER_AGENT_URL` を、送る先 (`origin`) と合言葉に分けたもの */
interface AgentTarget {
  /** `https://host:port` (末尾の `/` と `#` から後ろは除く) */
  origin: string;
  /** `#pair=` の値。無ければ null */
  pair: string | null;
}

/** `TUNER_AGENT_URL` を読む。`https://` でなければ誤り */
export function parseAgentUrl(raw: string): AgentTarget {
  const hash = raw.indexOf("#");
  const base = (hash < 0 ? raw : raw.slice(0, hash)).replace(/\/+$/, "");
  const fragment = hash < 0 ? "" : raw.slice(hash + 1);
  if (!/^https:\/\//i.test(base)) {
    throw new Error(
      "TUNER_AGENT_URL は https:// で書きます (エージェントとは TLS で繋ぎます。docs/agent.md)",
    );
  }
  const pair = new URLSearchParams(fragment).get("pair");
  return { origin: base, pair: pair && pair.length > 0 ? pair : null };
}

/** 不具合報告で伏せる値 (合言葉) */
export function agentSecrets(): string[] {
  try {
    const { pair } = parseAgentUrl(config.agentUrl);
    return pair === null ? [] : [pair];
  } catch {
    return [];
  }
}

/** エージェントの宛先のホスト名 (不具合報告で伏せるため) */
export function agentHostname(): string | null {
  try {
    return new URL(parseAgentUrl(config.agentUrl).origin).hostname;
  } catch {
    return null;
  }
}

// --- 証明書 -------------------------------------------------------------------

/** 証明書の指紋。DER の SHA-256 を小文字の 16 進で (エージェントと同じ決まり) */
export function fingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(body, "base64"));
}

function derToPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/*
 * 自己署名の証明書を DER で組む。Bun にも node:crypto にも証明書を作る API が無いので、
 * 要る形 (X.509 v3・ECDSA P-256・SHA-256・CN だけ・拡張なし) だけを手で並べる
 */
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const head =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff];
  const out = new Uint8Array(head.length + length);
  out.set(head);
  let at = head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const seq = (...parts: Uint8Array[]) => der(0x30, ...parts);
const bytes = (...values: number[]) => new Uint8Array(values);
/** ecdsa-with-SHA256 (1.2.840.10045.4.3.2) */
const ECDSA_SHA256 = seq(
  bytes(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02),
);

function commonName(name: string): Uint8Array {
  const utf8 = new TextEncoder().encode(name);
  // SET { SEQ { OID 2.5.4.3, UTF8String } }
  return seq(
    der(0x31, seq(bytes(0x06, 0x03, 0x55, 0x04, 0x03), der(0x0c, utf8))),
  );
}

function generalizedTime(at: Date): Uint8Array {
  const text = at.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return der(0x18, new TextEncoder().encode(text));
}

/** 自己署名の証明書 (PEM)。有効期間は前日から 100 年 (相手は証明書そのものを覚えるので、期限で切らない) */
function selfSignedCertificate(key: KeyObject, name: string): string {
  const spki = new Uint8Array(
    createPublicKey(key).export({ type: "spki", format: "der" }),
  );
  const serial = crypto.getRandomValues(new Uint8Array(16));
  // 正の数で、先頭のバイトを 0 にしない (0 で始まると DER の整数として余分な 0 になり、BoringSSL が INVALID_INTEGER で断る)
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, bytes(0x02))), // v3
    der(0x02, serial),
    ECDSA_SHA256,
    commonName(name),
    seq(
      generalizedTime(new Date(now - 24 * 60 * 60 * 1000)),
      generalizedTime(new Date(now + 100 * 365 * 24 * 60 * 60 * 1000)),
    ),
    commonName(name),
    spki,
  );
  const signature = new Uint8Array(sign("sha256", tbs, key));
  return derToPem(seq(tbs, ECDSA_SHA256, der(0x03, bytes(0x00), signature)));
}

export interface Identity {
  key: string;
  cert: string;
  fingerprint: string;
}

/** EC P-256 の鍵と自己署名の証明書を作る */
export function createIdentity(name: string): Identity {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const cert = selfSignedCertificate(privateKey, name);
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert,
    fingerprint: fingerprint(pemToDer(cert)),
  };
}

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

let remembered: { path: string; stamp: string; cert: string } | null = null;

/**
 * 覚えているエージェントの証明書 (PEM)。まだ組んでいなければ null。
 * ファイルが変わっていなければ前に読んだものを使う (`tls` を毎回作り直さないため)
 */
function agentCert(): string | null {
  const path = `${tlsDir()}/agent.crt`;
  if (!existsSync(path)) return null;
  const { mtimeMs, size } = statSync(path);
  const stamp = `${mtimeMs}:${size}`;
  if (remembered?.path !== path || remembered.stamp !== stamp) {
    remembered = { path, stamp, cert: readFileSync(path, "utf8") };
  }
  return remembered.cert;
}

function rememberAgent(cert: string): void {
  writeSecret(`${tlsDir()}/agent.crt`, cert);
}

// --- 組む ---------------------------------------------------------------------

/** 組むときの証し。base64url(HMAC-SHA256(合言葉, `denpa-pair/<役>\n<A>\n<D>`)) */
export function pairProof(
  token: string,
  role: "client" | "agent",
  agent: string,
  client: string,
): string {
  return createHmac("sha256", token)
    .update(`denpa-pair/${role}\n${agent}\n${client}`)
    .digest("base64url");
}

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
         * ここでは確かめない (まだ知らない相手の証明書を取りに行くので)。取った証明書は、このあと
         * 合言葉の証し (pairProof) で相手が合言葉を知っていると確かめてからしか覚えない
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

let pairing: { origin: string; done: Promise<void> } | null = null;

/** 合言葉で組む。同時に呼ばれても 1 度だけ */
function pair(target: AgentTarget): Promise<void> {
  if (pairing?.origin === target.origin) return pairing.done;
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
        "エージェントと組めません: 相手が合言葉を知りません (別の相手に繋がっているかもしれません)",
      );
    }
    rememberAgent(peerPem);
    console.log(`[agent] エージェント (${agent.slice(0, 16)}) と組みました`);
  })();
  pairing = { origin: target.origin, done };
  done.then(
    () => {
      if (pairing?.done === done) pairing = null;
    },
    () => {
      if (pairing?.done === done) pairing = null;
    },
  );
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
 * エージェントを呼ぶ。`path` は `/denpa/...`。返すのはふつうの `fetch` の応答。
 * まだ組んでいない・覚えた証明書と合わない・組んでいないと断られた、のどれかなら、合言葉で組み直して 1 度だけ試し直す。
 * 試し直すので、`init.body` は文字列など何度でも送れるものにする (いまの呼び出し元はどれも JSON の文字列か本文なし)
 */
export async function agentFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = parseAgentUrl(config.agentUrl);
  const attempt = async (): Promise<Response> => {
    const ca = agentCert();
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
