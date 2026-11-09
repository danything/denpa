/**
 * **ニコニコのアカウントとの連携** (世帯で 1 つ)。ニコニコの OAuth は denpa-hub が中継する
 * (クライアントのシークレットとニコニコ固有の値は hub だけが持つ。手順は denpa-hub の docs/niconico.md)。
 *
 * 1. 連携を始める (`startLink`): P-256 の鍵の組を作り、秘密鍵は**このプロセスのメモリにだけ** 10 分持つ
 *    (DB にもファイルにも書かない。再起動したら連携をやり直す)。画面は hub の `/niconico/authorize` へ移る
 * 2. 戻り先 (`RETURN_PATH`) に hub が `#result=` を付けて返す。画面がそれを送ってきたら開く (`finishLink`)。
 *    中身は hub がこちらの公開鍵に宛てて暗号化したトークンの応答 (ECDH P-256 → HKDF-SHA256 → AES-256-GCM。AAD は戻り先)
 * 3. トークンは暗号化して DB に置く (`schema.ts` の `niconicoLink`)。**端末には渡さない**
 * 4. アクセストークンは使う直前に期限を見て、切れかけていたら hub の `/niconico/token` で更新する (`accessToken`)。
 *    更新のたびに更新に使うトークンも替わる (古いものは使えなくなる) ので、**更新はこのプロセスの中で 1 本だけ**走らせ、
 *    受けた新しいトークンはすぐ DB に書く
 * 5. 外す (`unlink`): 手元のトークンを消すだけ。ニコニコに失効のエンドポイントが無いので、ニコニコの側の許可は
 *    利用者がニコニコのアカウント設定から取り消す
 *
 * トークン・戻り先の URL・hub の応答の本文は記録に書かない
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RETURN_PATH } from "../niconico";
import { config, userAgent } from "./config";
import { now, orm } from "./db";
import { randomToken } from "./oidc";
import { niconicoLink } from "./schema";

/** 連携の途中を持っておく長さ (ms)。hub の state の期限と同じ */
export const FLOW_TTL = 10 * 60_000;
/** 同時に持つ連携の途中の上限。押しっぱなしでメモリを使い続けない (超えたら古いものから捨てる) */
const MAX_FLOWS = 16;
/** アクセストークンの期限がこれを切っていたら、使う前に更新する (ms) */
const REFRESH_BEFORE = 5 * 60_000;
/** 応答に期限が無かったときのアクセストークンの長さ (秒)。短めに見て早く更新する */
const DEFAULT_EXPIRES_IN = 30 * 60;
/** hub を待つ上限 (ms)。hub はニコニコを 15 秒で打ち切る */
export const HUB_TIMEOUT = 20_000;
/** hub が結果の暗号化に使う HKDF の info (denpa-hub との約束) */
const INFO = new TextEncoder().encode("denpa-hub niconico token v1");

// ---- 連携の途中 ----

interface Flow {
  privateKey: CryptoKey;
  /** こちらの公開鍵 (非圧縮の 65 バイト)。HKDF の salt に使う */
  publicKey: Uint8Array;
  /** hub に渡した戻り先。結果の AAD */
  returnUrl: string;
  expiresAt: number;
}

const flows = new Map<string, Flow>();

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function prune(at: number): void {
  for (const [id, flow] of flows) if (flow.expiresAt <= at) flows.delete(id);
  while (flows.size >= MAX_FLOWS) {
    const oldest = flows.keys().next().value;
    if (oldest === undefined) break;
    flows.delete(oldest);
  }
}

/**
 * 連携を始める。`origin` は画面を開いているオリジン (`http://192.168.1.20:3000`)。
 * 返す `flow` は Cookie に入れて、戻ってきたときに同じブラウザかを見る。`url` へ画面ごと移る
 */
export async function startLink(
  origin: string,
  at = now(),
): Promise<{ flow: string; url: string }> {
  prune(at);
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  // hub は組み直した形 (スキーム・ホスト・既定でないポート・パス) を AAD に使うので、同じ形で渡す
  const returnUrl = `${new URL(origin).origin}${RETURN_PATH}`;
  const flow = randomToken();
  flows.set(flow, {
    privateKey: pair.privateKey,
    publicKey,
    returnUrl,
    expiresAt: at + FLOW_TTL,
  });
  const query = new URLSearchParams({
    return: returnUrl,
    key: base64url(publicKey),
  });
  return { flow, url: `${config.hubUrl}/niconico/authorize?${query}` };
}

/** hub の結果 (`base64url(使い捨ての公開鍵 65 ‖ nonce 12 ‖ 暗号文 ‖ tag 16)`) を開く。開けなければ投げる */
async function open(flow: Flow, sealed: string): Promise<Uint8Array> {
  const data = new Uint8Array(Buffer.from(sealed, "base64url"));
  if (data.length < 65 + 12 + 16) throw new Error("結果が短すぎます");
  const ephemeral = data.subarray(0, 65);
  const peer = await crypto.subtle.importKey(
    "raw",
    ephemeral,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peer },
    flow.privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const salt = new Uint8Array(65 + flow.publicKey.length);
  salt.set(ephemeral, 0);
  salt.set(flow.publicKey, 65);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: data.subarray(65, 77),
        additionalData: new TextEncoder().encode(flow.returnUrl),
      },
      key,
      data.subarray(77),
    ),
  );
}

/** トークンの応答のうち使うもの */
interface Tokens {
  access: string;
  refresh: string | null;
  expiresIn: number;
  idToken: string | null;
}

/**
 * トークンの応答 (RFC 6749 5.1) を読む。hub は手を加えずに渡すので、読むものだけ読む。
 * `access_token` が無ければ投げる。期限が無い・数でないときは短めに見て、`warn` を呼ぶ
 */
export function readTokens(
  body: unknown,
  warn: (message: string) => void = () => {},
): Tokens {
  const value = (body ?? {}) as Record<string, unknown>;
  const access = value["access_token"];
  if (typeof access !== "string" || access === "")
    throw new Error("応答にアクセストークンがありません");
  const refresh = value["refresh_token"];
  const expires = value["expires_in"];
  const idToken = value["id_token"];
  let expiresIn = DEFAULT_EXPIRES_IN;
  if (typeof expires === "number" && expires > 0) expiresIn = expires;
  else
    warn(
      "トークンの応答に期限 (expires_in) がありません。ニコニコの応答の形式が変わったかもしれません",
    );
  return {
    access,
    refresh: typeof refresh === "string" && refresh !== "" ? refresh : null,
    expiresIn,
    idToken: typeof idToken === "string" ? idToken : null,
  };
}

/**
 * ID トークンの `sub` (ニコニコのユーザー ID)。署名は確かめない。トークンのエンドポイントから hub が TLS で受け、
 * こちらの鍵で暗号化して渡したもの (OIDC Core 3.1.3.7 の 6)。読めなければ null
 */
export function subjectOf(idToken: string | null): string | null {
  const payload = idToken?.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sub?: unknown };
    return typeof claims.sub === "string" && claims.sub !== ""
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

/** 連携を終えられなかったわけ (戻り先の画面にそのまま出す) */
export const FINISH_ERRORS = {
  expired:
    "時間が経ったため連携できませんでした。もう一度「ニコニコと連携」を押してください",
  unreadable:
    "連携の結果を読めませんでした。もう一度「ニコニコと連携」を押してください",
  noRefresh: "更新に使うトークンが届かなかったため、連携できませんでした",
  noUser: "ニコニコのユーザー ID が届かなかったため、連携できませんでした",
} as const;

/**
 * 戻ってきた結果を開いて保存する。`flow` は Cookie の値、`by` は連携した人。
 * 途中は成否にかかわらずここで捨てる (同じ結果を 2 度使わせない)
 */
export async function finishLink(
  flowId: string | undefined,
  sealed: string,
  by: string,
  at = now(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const flow = flowId === undefined ? undefined : flows.get(flowId);
  if (flowId !== undefined) flows.delete(flowId);
  if (flow === undefined || flow.expiresAt <= at)
    return { ok: false, message: FINISH_ERRORS.expired };
  let tokens: Tokens;
  try {
    tokens = readTokens(
      JSON.parse(new TextDecoder().decode(await open(flow, sealed))),
      warn,
    );
  } catch {
    return { ok: false, message: FINISH_ERRORS.unreadable };
  }
  if (tokens.refresh === null)
    return { ok: false, message: FINISH_ERRORS.noRefresh };
  const user = subjectOf(tokens.idToken);
  if (user === null) return { ok: false, message: FINISH_ERRORS.noUser };
  const row = {
    id: 1,
    user_id: user,
    access_token: seal(tokens.access, "access_token"),
    refresh_token: seal(tokens.refresh, "refresh_token"),
    access_expires_at: at + tokens.expiresIn * 1000,
    linked_at: at,
    linked_by: by,
    lost_at: null,
  };
  orm()
    .insert(niconicoLink)
    .values(row)
    .onConflictDoUpdate({ target: niconicoLink.id, set: row })
    .run();
  console.log("[niconico] ニコニコのアカウントと連携しました");
  return { ok: true };
}

// ---- 置いておくトークンの暗号化 ----

/** 鍵のファイル。DB の隣 (DB だけが出回っても読めないように、DB とは別のファイル) */
function keyPath(): string {
  return join(config.dataDir, "niconico.key");
}

/** 鍵 (32 バイト)。無ければ作る (持ち主だけが読める) */
function storageKey(): Buffer {
  const path = keyPath();
  try {
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error(`${path} が 32 バイトではありません`);
  return key;
}

/** `nonce 12 ‖ 暗号文 ‖ tag 16`。AAD は列の名前 (列を入れ替えても開けない) */
function seal(text: string, column: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", storageKey(), nonce);
  cipher.setAAD(Buffer.from(column));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function unseal(data: Buffer, column: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    storageKey(),
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(column));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(12, data.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

// ---- 状態・更新・外す ----

/** 設定の画面に出す状態 */
type LinkState =
  | { state: "none" }
  | { state: "linked"; userId: string; linkedAt: number }
  | { state: "lost"; lostAt: number };

function row() {
  return orm().select().from(niconicoLink).get();
}

export function linkState(): LinkState {
  const link = row();
  if (link === undefined) return { state: "none" };
  if (link.lost_at !== null) return { state: "lost", lostAt: link.lost_at };
  return { state: "linked", userId: link.user_id, linkedAt: link.linked_at };
}

/** 保存したトークンを開けなかったときに記録に書くわけ */
const UNREADABLE = "保存したトークンを開けません (niconico.key が替わった)";

/** 更新できなくなった。トークンを消して、切れた印を付ける (同じ連携のままなら) */
function markLost(linkedAt: number, reason: string): void {
  const link = row();
  if (link === undefined || link.linked_at !== linkedAt) return;
  orm()
    .update(niconicoLink)
    .set({ access_token: null, refresh_token: null, lost_at: now() })
    .run();
  console.warn(`[niconico] 連携が切れました: ${reason}`);
}

/** 出した形式の警告。同じ警告は 1 度だけ出す (違う警告はそれぞれ 1 度ずつ) */
const warned = new Set<string>();
function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[niconico] ${message}`);
}

/** 走っている更新。同時に何か所から呼ばれても 1 本だけ */
let refreshing: Promise<string | null> | null = null;

/**
 * **使えるアクセストークン。** 連携していない・切れたなら null。期限が `REFRESH_BEFORE` を切っていれば更新してから返す。
 * hub に届かないときは投げる (連携はそのまま。次に使うときにまた試す)
 */
export async function accessToken(): Promise<string | null> {
  const link = row();
  if (link === undefined || link.lost_at !== null || link.access_token === null)
    return null;
  if (link.access_expires_at - now() > REFRESH_BEFORE) {
    try {
      return unseal(link.access_token, "access_token");
    } catch {
      markLost(link.linked_at, UNREADABLE);
      return null;
    }
  }
  return renew();
}

/**
 * **いますぐ更新する** (相手がアクセストークンを断ったときにも使う)。走っている更新があればそれを待つ
 */
export function renew(): Promise<string | null> {
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refresh(): Promise<string | null> {
  const link = row();
  if (
    link === undefined ||
    link.lost_at !== null ||
    link.refresh_token === null
  )
    return null;
  let current: string;
  try {
    current = unseal(link.refresh_token, "refresh_token");
  } catch {
    markLost(link.linked_at, UNREADABLE);
    return null;
  }
  const res = await fetch(`${config.hubUrl}/niconico/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current,
    }),
    signal: AbortSignal.timeout(HUB_TIMEOUT),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    // 許可が取り消された・更新に使うトークンが使えない。連携し直してもらうほかない
    if (error === "invalid_grant") {
      markLost(link.linked_at, "ニコニコが更新を断りました (invalid_grant)");
      return null;
    }
    throw new Error(
      `トークンを更新できません (HTTP ${res.status}${typeof error === "string" ? ` ${error}` : ""})`,
    );
  }
  const tokens = readTokens(body, warn);
  // 待っている間に外された・連携し直された。受けたものは捨てる (今の行を古いトークンで上書きしない)
  const still = row();
  if (still === undefined || still.linked_at !== link.linked_at) return null;
  const at = now();
  orm()
    .update(niconicoLink)
    .set({
      access_token: seal(tokens.access, "access_token"),
      // 新しいものが来なかったら前のものを使い続ける (来るのが決まりだが、形が変わっても止めない)
      ...(tokens.refresh === null
        ? {}
        : { refresh_token: seal(tokens.refresh, "refresh_token") }),
      access_expires_at: at + tokens.expiresIn * 1000,
    })
    .run();
  if (tokens.refresh === null)
    warn(
      "更新の応答に新しい更新用のトークンがありません。ニコニコの応答の形式が変わったかもしれません",
    );
  return tokens.access;
}

/** 連携を解除する。手元のトークンを消すだけ (ニコニコの側の許可は、ニコニコのアカウント設定から取り消す) */
export function unlink(): void {
  orm().delete(niconicoLink).run();
  console.log("[niconico] ニコニコのアカウントとの連携を解除しました");
}
