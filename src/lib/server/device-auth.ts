/**
 * **アプリのペアリングと、アプリに渡すアクセストークン** (docs/auth.md「アプリのペアリング」)。
 *
 * テレビのアプリ (danything/denpa-tv) は Cookie の控えを持てず、リモコンで OIDC の
 * ログイン画面を操作するのもつらい。そこで OAuth のデバイス認可 (RFC 8628) と同じ流れにする:
 *
 * 1. テレビが `POST /api/device/code` で `device_code` (秘密) と `user_code` (QR の URL に入れる短いコード) を貰う
 * 2. テレビは QR (`device?code=…`) を出す。スマホで開くと、denpa のいつものログイン方法
 *    (信頼するネットワークか OIDC) を通ったうえで、**そのまま許す** (`/device`)。
 *    「許す / 断る」を聞かないのは家で使う前提だから — QR を読めるのはテレビの前にいる人で、
 *    コードは10分で切れ、1度しか使えない。完了の画面には端末の名前を出す (コードは出さない。docs/auth.md)
 * 3. テレビは `POST /api/device/token` を間を置いて呼び、許されたらアクセストークンを1度だけ受け取る
 * 4. 以後は `Authorization: Bearer <アクセストークン>` で API とファイルのエンドポイントに入る
 *
 * **秘密を平文で DB に置かない。** `device_code` もアクセストークンも SHA-256 だけ持つ。アクセストークンは許した瞬間
 * ではなく**渡すときに作る** — 許してから渡すまでの間に、平文のアクセストークンを預かっておく場所が要らない
 */

import { createHash } from "node:crypto";

import { and, count, eq, gt, isNull, lte } from "drizzle-orm";

import { affected, now, orm } from "./db";
import { randomToken } from "./oidc";
import { apiTokens, deviceCodes } from "./schema";

/** コードの寿命 (秒で返すのは `expiresIn`) */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** 聞きに来てよい間隔 (`interval`) */
export const POLL_INTERVAL_MS = 5 * 1000;
/**
 * 有効なコードの上限。`/api/device/code` は誰でも呼べるので、溜め込ませない。
 * 埋めても10分で切れる (そのあいだペアリングできなくなるだけで、入れるようにはならない)
 */
export const MAX_PENDING = 20;
/** 名前の長さ。画面で見分けるためだけのもの */
const NAME_MAX = 40;
/** アクセストークンの頭。ほかの Bearer (前段の SSO など) と取り違えないための印 */
export const TOKEN_PREFIX = "denpa_";
/** 最後に使った時刻を書く間隔。映像は Range ごとに来るので、毎回は書かない */
const TOUCH_INTERVAL_MS = 60 * 1000;
/**
 * 間隔の数え方のゆとり。5秒ごとに呼ぶアプリでも、タイマーのずれで 4.9 秒になることがある。
 * それを `slow_down` で返すと、アプリが間隔を延ばし続けてしまう
 */
const POLL_SLACK_MS = 1000;

/** 見間違えない字だけ (0/O・1/I を外す)。ちょうど32字なので、1バイトを 32 で割っても偏らない */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** QR の URL に入れるコード。`ABCD-EFGH` (RFC 8628 の user_code の形式) */
export function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes]
    .map((byte) => ALPHABET[byte % ALPHABET.length])
    .join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** URL から来たコードを揃える (小文字・ハイフン抜け・空白を許す)。形式が違えば null */
export function normalizeUserCode(input: string): string | null {
  const chars = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (chars.length !== 8 || [...chars].some((c) => !ALPHABET.includes(c)))
    return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export interface IssuedCode {
  deviceCode: string;
  userCode: string;
}

/** コードを出す。有効なコードが上限に達していれば null (呼ぶ側が 429 で返す) */
export function issueCode(name: string, at = now()): IssuedCode | null {
  const alive =
    orm()
      .select({ n: count() })
      .from(deviceCodes)
      .where(
        and(gt(deviceCodes.expires_at, at), isNull(deviceCodes.consumed_at)),
      )
      .get()?.n ?? 0;
  if (alive >= MAX_PENDING) return null;

  const deviceCode = randomToken(32);
  // コードは短いので、まれに重なる。重なったら引き直す (unique で弾かれる)
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    try {
      orm()
        .insert(deviceCodes)
        .values({
          device_code_hash: sha256(deviceCode),
          user_code: userCode,
          name: name.trim().slice(0, NAME_MAX) || "テレビ",
          created_at: at,
          expires_at: at + CODE_TTL_MS,
        })
        .run();
      return { deviceCode, userCode };
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("ペアリングコードを作れませんでした");
}

type CodeState = "pending" | "approved" | "expired" | "consumed";

export interface CodeView {
  userCode: string;
  name: string;
  state: CodeState;
}

function stateOf(row: typeof deviceCodes.$inferSelect, at: number): CodeState {
  if (row.consumed_at !== null) return "consumed";
  if (row.expires_at <= at) return "expired";
  if (row.approved_at !== null) return "approved";
  return "pending";
}

function codeRow(userCode: string) {
  return orm()
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.user_code, userCode))
    .get();
}

/** 許す画面 (`/device`) に出すもの。コードが無ければ null */
export function viewCode(userCode: string, at = now()): CodeView | null {
  const row = codeRow(userCode);
  if (row === undefined) return null;
  return { userCode: row.user_code, name: row.name, state: stateOf(row, at) };
}

/**
 * 許す。**何度呼んでも同じ** (画面を読み直してもアクセストークンは2本にならない — 作るのは
 * 端末が受け取るときで、ここは印を付けるだけ)。コードの今の様子を返す (無ければ null)。
 *
 * アクセストークンで入った相手を断るのは呼ぶ側 (`/device` のアクション)
 */
export function approve(
  userCode: string,
  by: string,
  at = now(),
): CodeView | null {
  const row = codeRow(userCode);
  if (row === undefined) return null;
  const state = stateOf(row, at);
  if (state === "pending") {
    orm()
      .update(deviceCodes)
      .set({ approved_at: at, approved_by: by })
      .where(eq(deviceCodes.id, row.id))
      .run();
  }
  return {
    userCode: row.user_code,
    name: row.name,
    state: state === "pending" ? "approved" : state,
  };
}

/** 端末への答え (RFC 8628 の名前)。断る手順が無いので `access_denied` は返さない */
export type PollError =
  "authorization_pending" | "slow_down" | "expired_token" | "invalid_grant";

/**
 * 端末が聞きに来た。許されていれば**ここでアクセストークンを作り**、1度だけ返す。
 * 答えの名前は RFC 8628 のものに揃えてある (アプリの側で読み替えずに済むように)
 */
export function poll(
  deviceCode: string,
  at = now(),
): { token: string } | { error: PollError } {
  const row = orm()
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.device_code_hash, sha256(deviceCode)))
    .get();
  if (row === undefined) return { error: "invalid_grant" };
  const state = stateOf(row, at);
  if (state === "consumed") return { error: "invalid_grant" };
  if (state === "expired") return { error: "expired_token" };

  const tooSoon =
    row.last_polled_at !== null &&
    at - row.last_polled_at < POLL_INTERVAL_MS - POLL_SLACK_MS;
  orm()
    .update(deviceCodes)
    .set({ last_polled_at: at })
    .where(eq(deviceCodes.id, row.id))
    .run();
  if (tooSoon) return { error: "slow_down" };
  if (state === "pending") return { error: "authorization_pending" };

  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  orm().transaction((tx) => {
    const created = tx
      .insert(apiTokens)
      .values({
        name: row.name,
        token_hash: sha256(token),
        created_at: at,
        created_by: row.approved_by,
      })
      .returning({ id: apiTokens.id })
      .get();
    tx.update(deviceCodes)
      .set({ consumed_at: at, approved_token_id: created.id })
      .where(eq(deviceCodes.id, row.id))
      .run();
  });
  return { token };
}

export interface TokenOwner {
  id: number;
  name: string;
}

/** `Authorization` の値から denpa のアクセストークンを取り出す。denpa のものでなければ null (ほかの Bearer は見ない) */
export function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (match === null || !match[1]?.startsWith(TOKEN_PREFIX)) return null;
  return match[1];
}

/** アクセストークンが有効なら持ち主。無効にした・知らないものなら null */
export function verifyToken(token: string, at = now()): TokenOwner | null {
  const row = orm()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      last_used_at: apiTokens.last_used_at,
    })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.token_hash, sha256(token)),
        isNull(apiTokens.revoked_at),
      ),
    )
    .get();
  if (row === undefined) return null;
  if (row.last_used_at === null || at - row.last_used_at >= TOUCH_INTERVAL_MS) {
    orm()
      .update(apiTokens)
      .set({ last_used_at: at })
      .where(eq(apiTokens.id, row.id))
      .run();
  }
  return { id: row.id, name: row.name };
}

/** アクセストークンを無効にする (設定画面の「取り消す」と、アプリの「サーバーから外す」) */
export function revokeToken(id: number, at = now()): boolean {
  return (
    affected(
      orm()
        .update(apiTokens)
        .set({ revoked_at: at })
        .where(and(eq(apiTokens.id, id), isNull(apiTokens.revoked_at))),
    ) > 0
  );
}

/** 有効なアクセストークン。設定画面に並べる */
export function liveTokens() {
  return orm()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      created_at: apiTokens.created_at,
      last_used_at: apiTokens.last_used_at,
      created_by: apiTokens.created_by,
    })
    .from(apiTokens)
    .where(isNull(apiTokens.revoked_at))
    .orderBy(apiTokens.created_at)
    .all();
}

/** 切れたコードを片付ける。使い終えたコードも、切れたあとは要らない */
export function pruneCodes(at = now()): number {
  return affected(
    orm().delete(deviceCodes).where(lte(deviceCodes.expires_at, at)),
  );
}
