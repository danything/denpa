/**
 * エージェントと組むときの鍵・証明書・証し (docs/agent.md「denpa とは TLS で組む」)。
 * DB にも置き場にも触らない (偽のエージェント `fake-agent.ts` が Node の Playwright からも読むため)
 */
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

/** 証明書の指紋。DER の SHA-256 を小文字の 16 進で (エージェントと同じ決まり) */
export function fingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(body, "base64"));
}

export function derToPem(der: Uint8Array): string {
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
