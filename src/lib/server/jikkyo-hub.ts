/**
 * **実況のコメントを denpa-hub から受ける・hub へ書く (トークンと呼び出し)。** 端末は NX-Jikkyo にも過去ログ API にも繋がず、
 * denpa のサーバだけに繋ぐ。サーバは hub (`DENPA_HUB`) を通す。hub の作りは denpa-hub の docs/jikkyo.md
 *
 * - hub のトークンは初めて要るときに `POST /jikkyo/tokens` で受け取り、DB に置く (`jikkyo_link`)。hub が 401 を返したら 1 回だけ取り直してやり直す
 * - 書いた人の ID (`author`) は、`HMAC-SHA256(トークン, "denpa jikkyo author" ‖ 書いた人の鍵)` の先頭 22 文字。
 *   鍵はログインの subject (OIDC・アクセストークン)、無ければ端末の Cookie。hub には subject も Cookie も渡らない
 *
 * トークンは記録に書かない
 */
import { createHmac } from "node:crypto";

import { config, userAgent } from "./config";
import { orm } from "./db";
import { randomToken } from "./oidc";
import { jikkyoLink } from "./schema";

/** hub を待つ上限 (ms)。過去ログは hub が 20 秒で打ち切る */
export const HUB_TIMEOUT = 25_000;

let issuing: Promise<string> | null = null;

function storedToken(): string | null {
  return orm().select().from(jikkyoLink).get()?.token ?? null;
}

/** hub からトークンを受け取り、DB に置く。同時に呼ばれても受け取るのは 1 回 */
function issue(): Promise<string> {
  issuing ??= (async () => {
    const res = await fetch(`${config.hubUrl}/jikkyo/tokens`, {
      method: "POST",
      headers: { Accept: "application/json", "User-Agent": userAgent() },
      signal: AbortSignal.timeout(HUB_TIMEOUT),
    });
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    if (res.status !== 201 || typeof body?.token !== "string")
      throw new Error(`hub /jikkyo/tokens -> ${res.status}`);
    const token = body.token;
    const row = { id: 1, token, issued_at: Date.now() };
    orm()
      .insert(jikkyoLink)
      .values(row)
      .onConflictDoUpdate({ target: jikkyoLink.id, set: row })
      .run();
    return token;
  })().finally(() => {
    issuing = null;
  });
  return issuing;
}

/** いまのトークン (無ければ受け取る) */
export async function hubToken(): Promise<string> {
  return storedToken() ?? issue();
}

/**
 * hub を呼ぶ。トークンを付け、401 なら 1 回だけ取り直してやり直す。`path` は `/jikkyo/...`。
 * 長く読むもの (SSE) は `signal` で止める。無ければ `HUB_TIMEOUT` で打ち切る
 */
export async function hubFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = (token: string) =>
    fetch(`${config.hubUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent(),
      },
      signal: init.signal ?? AbortSignal.timeout(HUB_TIMEOUT),
    });
  const token = await hubToken();
  const res = await send(token);
  if (res.status !== 401) return res;
  await res.body?.cancel();
  // hub がトークンを忘れた (30 日使わなかった・hub のデータが消えた)。取り直す
  if (storedToken() === token) await issue();
  return send(await hubToken());
}

/** 書いた人の ID。同じ人はいつも同じ、家ごと・人ごとに違う (hub はこれをさらにハッシュにして持つ) */
export function authorId(token: string, key: string): string {
  return createHmac("sha256", token)
    .update(`denpa jikkyo author\u0000${key}`)
    .digest("base64url")
    .slice(0, 22);
}

/** 信頼するネットワークから入った端末 (ログインの subject が無い) の、書いた人の鍵を持つ Cookie */
export const AUTHOR_COOKIE = "denpa_jikkyo";

/** 新しい書いた人の鍵 (Cookie の値) */
export function newAuthorKey(): string {
  return randomToken();
}
