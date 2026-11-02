/**
 * **denpa-hub がトークンの応答を denpa の公開鍵に宛てて暗号化する手順** (denpa-hub の docs/niconico.md の「暗号の形」)。
 * 偽の hub (`denpa-hub.ts`) と、開く側の単体テスト (`src/lib/server/niconico.test.ts`) が使う。
 *
 * `base64url(使い捨ての公開鍵 65 ‖ nonce 12 ‖ 暗号文 ‖ tag 16)`。鍵は ECDH P-256 の共有の秘密から
 * HKDF-SHA256 (salt = 使い捨ての公開鍵 ‖ denpa の公開鍵、info = `denpa-hub niconico token v1`) で作り、AES-256-GCM の AAD は戻り先
 */
const INFO = new TextEncoder().encode("denpa-hub niconico token v1");

export async function sealForDenpa(
  recipientBase64url: string,
  plaintext: string,
  aad: string,
): Promise<string> {
  const recipient = new Uint8Array(
    Buffer.from(recipientBase64url, "base64url"),
  );
  const peer = await crypto.subtle.importKey(
    "raw",
    recipient,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ephemeralRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peer },
    ephemeral.privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const salt = new Uint8Array([...ephemeralRaw, ...recipient]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return Buffer.from(
    new Uint8Array([...ephemeralRaw, ...nonce, ...body]),
  ).toString("base64url");
}

/** 署名の無い ID トークン (denpa は sub だけを読む) */
export function idTokenFor(sub: string): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ sub })}.`;
}
